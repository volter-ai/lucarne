// startRecall — the OBSERVE half's SCREEN sensor (LS-13): a passive, read-only recorder of what's
// on screen, running on its OWN `playwright-core` connection over a lucarne session's `cdpUrl`.
// Rewritten from cadence's `recall.ts` `watch` command onto this package's presence contract
// (LS-12) and the shared video assembler (LS-09) — the retired arbitrary-code HTTP endpoint +
// cross-eval `globalThis` state (`recall.ts:44-60`) is GONE; every piece of state below is
// in-process.
//
// SAFETY LAW 3 (recorder read-only + zero synthetic requests): every call this module makes is a
// PASSIVE READ — `page.evaluate` (DOM reads only, no dispatched input), `ariaSnapshot()`,
// `page.screenshot()`, `Page.startScreencast` (CDP screencast is a passive tap, not a request).
// This module and its siblings issue no request of their own to any site or CDN — media crops
// derive from the session's OWN screenshot via the shared assembler
// (`cropImageFromScreenshot`, `video/assembler.ts`) instead (see
// test/recall-readonly-gates.mjs, LS-13 dev/02).
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "playwright-core";
import { attributeActor, presenceTieBreakBonus, type PresenceMarker } from "../presence.js";
import { RecallConnection } from "./connection.js";
import { runStaticCapture } from "./capture.js";
import { recordWatchedVideo } from "./video-watch.js";
import { tabSignatureProbe, tabVisibilityProbe } from "./dom-probes.js";
import { MediaCropTracker } from "./media-crop.js";
import { acquireSingletonLock, RECALL_LOCK_FILE, reconcileMedia, releaseSingletonLock, sweepOrphanVideoDirs } from "./lock.js";
import { RecallStatusHolder, type RecallStatusSnapshot } from "./status.js";
import { ACTIVE_TAB_FALLBACK_THRESHOLD, changeSignature, classifyChange, pickBestTab, scrollBucket, type ChangeParts, type ScoredTabCandidate } from "./tab-scoring.js";
import { adaptivePaceMs, bumpIdle } from "./adaptive-pace.js";
import { startWireSensor, xWireAdapter, type WireSensorHandle, type WireSiteAdapter } from "./wire.js";
import type { RecallExtractor, RecallObserverFn, RecallSignal, RecallToggles, RecallVideoStopReason } from "./types.js";

export type {
  RecallActor,
  RecallCaptureReason,
  RecallExtractor,
  RecallObserverFn,
  RecallSignal,
  RecallToggles,
  RecallVideoStopReason,
} from "./types.js";
export { RecallStatusHolder, type RecallActivityState, type RecallObserveState, type RecallProgress, type RecallStatusSnapshot } from "./status.js";
export { attributeActor, presenceTieBreakBonus } from "../presence.js";
export type { PresenceMarker } from "../presence.js";
export { classifyChange, pickBestTab } from "./tab-scoring.js";
export { filterVisibleRecords, rootIdFromUrl } from "./visible-filter.js";
export { dispatchExtractors, type CaptureMeta, type CaptureOutcome } from "./capture.js";
export { decideStop, recordWatchedVideo, runVideoWatchLoop } from "./video-watch.js";
export { MediaCropTracker } from "./media-crop.js";
export { acquireSingletonLock, releaseSingletonLock, reconcileMedia, sweepOrphanVideoDirs } from "./lock.js";
export { adaptivePaceMs, DEFAULT_ADAPTIVE_PACE } from "./adaptive-pace.js";
export { dispatchWireAdapters, isXGraphqlUrl, searchTypeFromUrl, startWireSensor, xOperationNameOf, xWireAdapter, type WireSensorHandle, type WireSensorOptions, type WireSiteAdapter } from "./wire.js";

/** A lucarne session object shape, or an `InteractSession`-like one that ALSO exposes
 *  `presenceSnapshot()` (duck-typed — recall never imports `InteractSession`/`session.ts` itself,
 *  so a raw `{cdpUrl}` object works exactly as well as a real `InteractSession` instance). */
export type RecallSessionSource = string | { cdpUrl: string; presenceSnapshot?: () => PresenceMarker | null };

export interface StartRecallOptions {
  /** Where captures land: ARIA text, screenshots, media crops, the shared `lucarne-records` store. */
  dataDir: string;
  /** Per-site extractor plugins (e.g. `lucarne-records/sites`'s `xAriaExtractor`) — the SCREEN
   *  sensor's plugins. */
  extractors: readonly RecallExtractor[];
  /** Per-site WIRE adapters (LS-13W) — the second, independent passive sensor's plugins, run
   *  alongside the screen sensor on the same connection. Defaults to `[xWireAdapter]` (x's
   *  operationName -> pure-parser dispatch, `wire.ts`). Pass `[]` to disable wire capture entirely
   *  while keeping the screen sensor. */
  wireAdapters?: readonly WireSiteAdapter[];
  /** Consumer hooks fired for every capture/video/wire signal (cadence's intent-bus polling is NOT
   *  ported here — see this package's README; a caller wanting that reads its OWN page state). */
  observers?: readonly RecallObserverFn[];
  toggles?: RecallToggles;
  /** Explicit presence-marker read, overriding the duck-typed detection off `sessionOrCdpUrl`. */
  presence?: () => PresenceMarker | null;
  /** Hard ceiling for a watched-video recording, ms. Default 5 minutes. */
  videoCapMs?: number;
  /** Injectable clock, for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface RecallHandle {
  /** Stop BOTH sensors (screen loop + wire sensor), close recall's OWN connection, and release the
   *  singleton lock. Idempotent. */
  stop(): Promise<void>;
  /** The current publish-chokepoint status snapshot (see `status.ts`'s LS-14 hand-off note). */
  status(): RecallStatusSnapshot;
  /** Register an additional observer after start (in addition to `opts.observers`). */
  on(event: "signal", cb: RecallObserverFn): void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function probeTab(p: Page): Promise<{ vis: boolean; foc: boolean; skip: boolean } | null> {
  try {
    return await p.evaluate(tabVisibilityProbe);
  } catch {
    return null;
  }
}

interface PickedTabResult {
  page: Page;
  targetId: string;
  sig: Awaited<ReturnType<typeof tabSignatureProbe>>;
}

/**
 * Recall's active-tab selection (cadence's `SIG`, `recall.ts:62-101`), rewritten onto LS-12's
 * presence contract: the `p === page` eval-server identity check becomes a `targetId` equality
 * check via `presenceTieBreakBonus`, and the FALLBACK (cadence's `recall.ts:81-86`, "no visible tab
 * scored — trust the one the eval-server is driving") becomes "trust the tab named by the
 * presence marker's `drivenTargetId`, if one exists and is still open" — the connection-independent
 * replacement `presence.ts`'s doc header describes.
 */
async function pickActiveTab(conn: RecallConnection, presenceSnapshot: (() => PresenceMarker | null) | undefined): Promise<PickedTabResult | null> {
  const marker = presenceSnapshot?.() ?? null;
  const pages = await conn.pages();
  const candidates: ScoredTabCandidate[] = [];
  const pageByIndex = new Map<number, Page>();
  const targetIdByIndex = new Map<number, string>();
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i]!;
    pageByIndex.set(i, p);
    const probe = await probeTab(p);
    let tieBreakBonus = 0;
    if (probe && !probe.skip) {
      const targetId = await conn.targetIdFor(p).catch(() => null);
      if (targetId) {
        targetIdByIndex.set(i, targetId);
        tieBreakBonus = presenceTieBreakBonus(marker, targetId);
      }
    }
    candidates.push({ index: i, probe, tieBreakBonus });
  }

  const best = pickBestTab(candidates);
  let target: Page | undefined = best && best.score >= ACTIVE_TAB_FALLBACK_THRESHOLD ? pageByIndex.get(best.index) : undefined;

  if (!target && marker) {
    // FALLBACK — find the tab whose OWN targetId matches the marker's driven target (cadence's
    // `recall.ts:81-86` fallback, generalized: object identity → targetId equality).
    for (let i = 0; i < pages.length; i++) {
      const targetId = targetIdByIndex.get(i) ?? (await conn.targetIdFor(pages[i]!).catch(() => null));
      if (targetId === marker.drivenTargetId) {
        const probe = await probeTab(pages[i]!);
        if (probe && !probe.skip) target = pages[i];
        break;
      }
    }
  }
  if (!target) return null;

  const targetId = targetIdByIndex.get(pages.indexOf(target)) ?? (await conn.targetIdFor(target).catch(() => null));
  if (!targetId) return null;
  const sig = await target.evaluate(tabSignatureProbe).catch(() => null);
  if (!sig) return null;
  return { page: target, targetId, sig };
}

async function captureWatchedVideo(
  page: Page,
  dataDir: string,
  videoSig: { ct: number; dur: number | null },
  capMs: number,
  onProgress: (p: { ct: number; dur: number | null }) => void,
): Promise<{ stopReason: RecallVideoStopReason; mp4: string | null; startCt: number; maxCt: number; frames: number } | null> {
  const stamp = Date.now();
  const framesDir = resolve(dataDir, `.vid-${stamp}`);
  const cdp = await page.context().newCDPSession(page);
  try {
    const pollOnce = async () => {
      const v = await page
        .evaluate(() => {
          const el = document.querySelector("video");
          return el ? { ct: +el.currentTime.toFixed(2), dur: Number.isFinite(el.duration) ? +el.duration.toFixed(2) : null, paused: el.paused } : null;
        })
        .catch(() => null);
      if (!v) return { ct: 0, dur: null, paused: true, focus: false, gone: true as const };
      const focus = await page.evaluate(() => document.hasFocus()).catch(() => false);
      return { ct: v.ct, dur: v.dur, paused: v.paused, focus };
    };
    const result = await recordWatchedVideo(
      { cdp, pollOnce, onProgress },
      { framesDir, outPath: resolve(dataDir, `watched-${stamp}.mp4`), startCt: videoSig.ct, capMs },
    );
    if (!result.ok) return { stopReason: result.stopReason, mp4: null, startCt: result.startCt, maxCt: result.maxCt, frames: result.frames };
    return { stopReason: result.stopReason, mp4: result.mp4 ?? null, startCt: result.startCt, maxCt: result.maxCt, frames: result.frames };
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/**
 * Start the SCREEN sensor: connect, sweep + reconcile, and run the capture-on-change / watched-
 * video loop until `stop()` is called. Self-heals — a single tick's error is logged into the
 * status snapshot's `observe` field and the loop keeps going (cadence's `recall.ts:313-317,407`
 * supervisor law: a transient fault must never kill the one sanctioned always-on process).
 */
export async function startRecall(sessionOrCdpUrl: RecallSessionSource, opts: StartRecallOptions): Promise<RecallHandle> {
  const cdpUrl = typeof sessionOrCdpUrl === "string" ? sessionOrCdpUrl : sessionOrCdpUrl.cdpUrl;
  if (!cdpUrl) throw new Error("startRecall requires a cdpUrl (a string, or an object with a `cdpUrl` field)");
  if (!opts?.dataDir) throw new Error("startRecall requires opts.dataDir");

  const presenceSnapshot: (() => PresenceMarker | null) | undefined =
    opts.presence ?? (typeof sessionOrCdpUrl === "object" && typeof sessionOrCdpUrl.presenceSnapshot === "function" ? () => sessionOrCdpUrl.presenceSnapshot!() : undefined);

  mkdirSync(opts.dataDir, { recursive: true });
  const lockPath = resolve(opts.dataDir, RECALL_LOCK_FILE);
  const lock = acquireSingletonLock(lockPath, process.pid);
  if (!lock.acquired) {
    throw new Error(`lucarne-interact/recall: another recall process is already running for this dataDir (pid ${lock.otherPid}) — refusing a second (would duplicate captures)`);
  }

  sweepOrphanVideoDirs(opts.dataDir);
  const tracker = new MediaCropTracker(opts.dataDir);
  reconcileMedia(opts.dataDir, tracker);

  const conn = new RecallConnection(cdpUrl);
  const status = new RecallStatusHolder(opts.now);
  status.publish({ activity: "starting" });

  const observers: RecallObserverFn[] = [...(opts.observers ?? [])];
  const emit = (signal: RecallSignal): void => {
    for (const observer of observers) {
      try {
        observer(signal);
      } catch {
        /* one misbehaving observer must never break recording */
      }
    }
  };

  // The WIRE sensor (LS-13W) — a SECOND, independent passive sensor on this SAME connection,
  // observing the site app's own GraphQL responses via CDP's `Network` domain. It runs alongside
  // the screen sensor's loop below, not inside it: its capture is event-driven off CDP callbacks,
  // never gated on the screen sensor's own active-tab pick/pace. Default ON — a caller not wanting
  // it passes `wireAdapters: []`; the ambient `isEnabled`/`isWireEnabled` toggle still applies (the
  // wire sensor never turns ITSELF off, same law as the screen sensor).
  const wireAdapters = opts.wireAdapters ?? [xWireAdapter];
  const wireIsEnabled = (): boolean => {
    if (opts.toggles?.isWireEnabled) return !!opts.toggles.isWireEnabled();
    return opts.toggles?.isEnabled ? !!opts.toggles.isEnabled() : true;
  };
  const wireHandle: WireSensorHandle | undefined = wireAdapters.length
    ? await startWireSensor(conn, { dataDir: opts.dataDir, adapters: wireAdapters, emit, isEnabled: wireIsEnabled })
    : undefined;

  let stopped = false;
  let idle = 0;
  let lastSig: string | null = null;
  let lastParts: ChangeParts | null = null;
  const recordedVideoKeys = new Set<string>();
  const videoCapMs = opts.videoCapMs ?? 5 * 60 * 1000;

  const loop = (async () => {
    while (!stopped) {
      try {
        const enabled = opts.toggles?.isEnabled ? !!opts.toggles.isEnabled() : true;
        if (!enabled) {
          status.publish({ enabled: false });
          await sleep(700);
          continue;
        }
        status.publish({ enabled: true });

        const pick = await pickActiveTab(conn, presenceSnapshot).catch(() => null);
        if (!pick) {
          status.publish({ observe: "no_page" });
          idle = bumpIdle(idle);
          await sleep(adaptivePaceMs(idle));
          continue;
        }
        const { page, targetId, sig } = pick;
        const attribution = attributeActor(presenceSnapshot?.() ?? null, targetId);
        const by = attribution.by;

        // Video-watch is a BLOCKING branch (records to completion/cap). Skipped on a thread page
        // (`/status/<id>`) so a playing video there doesn't hijack recall from the comments —
        // cadence's `recall.ts:368-373`.
        const onThread = /\/status\/\d+/.test(sig.url || "");
        if (!onThread && sig.video && !sig.video.paused && sig.video.ct > 0.05) {
          const key = sig.url + "#" + Math.round(sig.video.dur || 0);
          if (!recordedVideoKeys.has(key)) {
            recordedVideoKeys.add(key);
            idle = 0;
            status.publish({ activity: "recording_video" });
            const result = await captureWatchedVideo(page, opts.dataDir, sig.video, videoCapMs, (p) => status.publish({ activity: "recording_video", progress: p }));
            if (result) {
              emit({
                kind: "video",
                ts: new Date().toISOString(),
                url: sig.url,
                by,
                stopReason: result.stopReason,
                mp4: result.mp4,
                watchedRange: [result.startCt, result.maxCt],
                frames: result.frames,
              });
            }
            status.publish({ observe: "ok", activity: "idle", progress: null });
            continue;
          }
        }

        const parts: ChangeParts = { url: sig.url, bucket: scrollBucket(sig.scrollY), firstText: sig.firstText || "" };
        const s = changeSignature(parts);
        if (s !== lastSig) {
          const { reason, detail } = classifyChange(lastParts, parts);
          lastSig = s;
          lastParts = parts;
          idle = 0;
          try {
            const outcome = await runStaticCapture(page, opts.dataDir, opts.extractors, tracker, { reason, by, detail });
            emit({
              kind: "capture",
              ts: new Date().toISOString(),
              url: outcome.url,
              title: outcome.title,
              reason,
              detail,
              by,
              recordsAdded: outcome.recordsAdded,
              ariaFile: outcome.ariaFile,
              screenshotFile: outcome.screenshotFile,
            });
          } catch {
            /* self-heal: one bad capture must never kill the loop */
          }
        } else {
          idle = bumpIdle(idle);
        }
        status.publish({ observe: "ok", activity: "idle" });
        await sleep(adaptivePaceMs(idle));
      } catch {
        // SUPERVISOR (cadence's `recall.ts:313-317,407`): a transient fault (a flaky page read, a
        // screencast hiccup) must never kill the recorder — retry, never exit. Strictly read-only,
        // so "keep going" can never escalate into an account action.
        status.publish({ observe: "no_server" });
        await sleep(700);
      }
    }
  })();

  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      await loop.catch(() => {});
      await wireHandle?.stop().catch(() => {});
      await conn.close().catch(() => {});
      releaseSingletonLock(lockPath, process.pid);
    },
    status: () => status.snapshot(),
    on(event, cb) {
      if (event === "signal") observers.push(cb);
    },
  };
}

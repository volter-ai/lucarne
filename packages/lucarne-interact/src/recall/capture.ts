// One static capture — ported from the origin app's `captureStatic` (`recall.ts:159-194`): an ARIA
// snapshot + an in-session screenshot + the caller's own pluggable DOM probes (media boxes,
// viewport visibility — LS-32: no longer hardwired to one site's markup, see `types.ts`'s
// `RecallPageProbes` and `dom-probes.ts`'s header), dispatched through the caller's extractor
// plugins, filtered to what was honestly ON SCREEN, and merged into the shared store. READ-ONLY:
// `page.locator(...).ariaSnapshot()` and `page.screenshot()` are passive reads of what's already
// rendered — no navigation, no synthetic input, no network request this recorder issues itself.
import { writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { Page } from "playwright-core";
import type { Capture, Entity } from "lucarne-records";
import { appendRecords } from "lucarne-records";
import { tabVisibilityProbe } from "./dom-probes.js";
import { MediaCropTracker } from "./media-crop.js";
import { RecallConnection } from "./connection.js";
import { filterVisibleRecords } from "./visible-filter.js";
import type { RecallActor, RecallCaptureReason, RecallExtractor, RecallPageProbes } from "./types.js";

export interface CaptureMeta {
  reason: RecallCaptureReason;
  by: RecallActor;
  detail: string | null;
}

export interface CaptureOutcome {
  url: string;
  title: string;
  ariaChars: number;
  recordsAdded: number;
  ariaFile: string;
  screenshotFile: string;
}

/** Path relative to `dataDir`, for portable `Capture.from`/`Capture.screenshot` pointers. */
function relToDataDir(p: string, dataDir: string): string {
  return relative(dataDir, p);
}

/**
 * Dispatch `aria` through every extractor whose `match(url)` returns true, concatenating their
 * records. PURE (no I/O) — the extractors themselves are pure (the CALLER registers its own
 * site-specific extractors; this package bundles none and stays domain-agnostic), and this loop is
 * nothing but plugin selection, so it's independently Chrome-free unit-testable
 * (test/recall-extractor-dispatch.mjs) without a live Page. A misbehaving extractor (one that throws)
 * never breaks the capture or its siblings — same self-heal posture as the rest of recall.
 */
export function dispatchExtractors(url: string, aria: string, capture: Capture, extractors: readonly RecallExtractor[]): Entity[] {
  let records: Entity[] = [];
  for (const extractor of extractors) {
    if (!extractor.match(url)) continue;
    try {
      records = records.concat(extractor.extract(aria, capture));
    } catch {
      /* one misbehaving extractor must never break the capture or the others */
    }
  }
  return records;
}

/**
 * Run one static capture against `page` (the tab recall's own SIG scan already picked as active),
 * writing the ARIA text + screenshot to `dataDir`, cropping any newly-visible post images (via
 * `tracker`, using the caller's OWN `probes.mediaProbe` — absent means no crops), dispatching every
 * matching extractor, applying the viewport-honesty filter (via the caller's own
 * `probes.visibleProbe`/`probes.rootIdFromUrl` — absent means "don't filter" / "no thread root"),
 * and merging the resulting records into the shared store (`lucarne-records`' `appendRecords`).
 */
export async function runStaticCapture(
  page: Page,
  dataDir: string,
  extractors: readonly RecallExtractor[],
  tracker: MediaCropTracker,
  probes: RecallPageProbes,
  meta: CaptureMeta,
): Promise<CaptureOutcome> {
  const stamp = Date.now();
  const ariaFile = resolve(dataDir, `aria-${stamp}.txt`);
  const shotFile = resolve(dataDir, `view-${stamp}.png`);

  const url = page.url();
  const title = await page.title().catch(() => "");
  const aria = await page
    .locator("body")
    .ariaSnapshot({ timeout: 8000 })
    .catch(() => "");
  writeFileSync(ariaFile, aria);
  try {
    await page.screenshot({ path: shotFile });
  } catch {
    /* a screenshot failure must never break the capture — the ARIA half still lands */
  }
  const mediaBoxes = probes.mediaProbe ? await page.evaluate(probes.mediaProbe).catch(() => []) : [];
  const visibleIds = probes.visibleProbe ? await page.evaluate(probes.visibleProbe).catch(() => []) : [];

  tracker.crop(shotFile, mediaBoxes);

  const capture: Capture = {
    from: relToDataDir(ariaFile, dataDir),
    screenshot: relToDataDir(shotFile, dataDir),
    ts: new Date().toISOString(),
    reason: meta.reason,
    by: meta.by,
    page: url,
  };

  const records = dispatchExtractors(url, aria, capture, extractors);

  const rootId = probes.rootIdFromUrl?.(url) ?? null;
  const filtered = filterVisibleRecords(records, visibleIds, rootId);
  for (const record of filtered) {
    const info = tracker.infoFor(record.provenance.id);
    if (!info) continue;
    (record as { raw?: Record<string, unknown> }).raw = { ...(record as { raw?: Record<string, unknown> }).raw, media: [info] };
  }

  const recordsAdded = filtered.length ? appendRecords(dataDir, filtered) : 0;
  return { url, title, ariaChars: aria.length, recordsAdded, ariaFile, screenshotFile: shotFile };
}

/** A lucarne session object shape, or an `InteractSession`-like one — structurally the same duck
 *  type `startRecall`'s own `RecallSessionSource` (`index.ts`) accepts, redeclared locally (rather
 *  than imported) to avoid a circular import: `index.ts` already imports THIS file. */
export type CaptureOnceSource = string | { cdpUrl: string };

export interface CaptureOnceOptions {
  /** Where the capture's ARIA text / screenshot / crops / `lucarne-records` store land — same
   *  contract as `startRecall`'s `dataDir`. */
  dataDir: string;
  /** Per-site extractor plugins — same contract as `startRecall`'s `extractors`. */
  extractors: readonly RecallExtractor[];
  /** Same pluggable media/visibility/root-id probes `startRecall` accepts (`types.ts`'s
   *  `RecallPageProbes`) — a caller wanting the SAME media-crop + viewport-honesty behavior as the
   *  continuous sensor passes the SAME probes object here. Absent → the same safe no-op defaults
   *  `runStaticCapture` already falls back to. */
  probes?: RecallPageProbes;
  /** Attribution stamped on the resulting records/outcome — defaults to `{reason:'initial',
   *  by:'agent', detail:null}` (a one-shot snapshot has no presence marker to consult for
   *  attribution, so it's always agent-attributed unless the caller says otherwise). */
  meta?: Partial<CaptureMeta>;
}

/**
 * A single, READ-ONLY static capture against whatever page is currently on screen for
 * `sessionOrCdpUrl` — the SAME `runStaticCapture` pipeline `startRecall`'s loop runs on every
 * change, exposed standalone for a caller that wants ONE capture on demand (e.g. a `recall
 * snapshot`-style command) rather than the continuous sensor. Opens its OWN short-lived
 * `RecallConnection` (always closed before returning, success or failure — no lingering CDP
 * session), uses a fresh, single-call `MediaCropTracker` (no persistence across calls — a caller
 * wanting cross-call crop dedup should run the continuous `startRecall` sensor instead), and picks
 * the same kind of tab the continuous sensor would settle on absent a presence marker: the first
 * non-skipped (http(s), not this recorder's own surface) tab that's both visible and focused,
 * falling back to the first non-skipped tab if none is both. Same Law 3 posture as `startRecall`:
 * no account action, no synthetic request — every read here is `page.evaluate`/`ariaSnapshot()`/
 * `screenshot()`, same as the continuous loop.
 */
export async function captureOnce(sessionOrCdpUrl: CaptureOnceSource, opts: CaptureOnceOptions): Promise<CaptureOutcome> {
  const cdpUrl = typeof sessionOrCdpUrl === "string" ? sessionOrCdpUrl : sessionOrCdpUrl.cdpUrl;
  if (!cdpUrl) throw new Error("captureOnce requires a cdpUrl (a string, or an object with a `cdpUrl` field)");
  if (!opts?.dataDir) throw new Error("captureOnce requires opts.dataDir");

  const conn = new RecallConnection(cdpUrl);
  try {
    const pages = await conn.pages();
    let page: Page | undefined;
    for (const p of pages) {
      const probe = await p.evaluate(tabVisibilityProbe).catch(() => null);
      if (!probe || probe.skip) continue;
      if (!page) page = p;
      if (probe.vis && probe.foc) {
        page = p;
        break;
      }
    }
    if (!page) throw new Error("captureOnce: no usable (visible, non-skip) page found on this session");

    const tracker = new MediaCropTracker(opts.dataDir);
    const meta: CaptureMeta = { reason: opts.meta?.reason ?? "initial", by: opts.meta?.by ?? "agent", detail: opts.meta?.detail ?? null };
    return await runStaticCapture(page, opts.dataDir, opts.extractors, tracker, opts.probes ?? {}, meta);
  } finally {
    await conn.close().catch(() => {});
  }
}

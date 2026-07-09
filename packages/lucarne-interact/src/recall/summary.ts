// The SUMMARY layer (LS-14) — ported from the origin app's `recall-summary.ts`: the small shape a
// "what has the eye seen" view renders (what the sensors captured today: counts + a recent timeline
// with tiny thumbnails). READ-ONLY: this module opens no browser and performs no account action —
// the only I/O is (a) reading media files the SCREEN sensor already wrote to `dataDir`
// (screenshots/mp4s) and (b) shelling a downscale tool to make a thumbnail from one of them.
//
// REWORKED from the origin's version on two points:
//
//  1. INPUT. The origin's `recallSummary(social)` re-parses ITS OWN ad hoc recall-log JSONL file
//     from disk. This package already emits a typed `RecallSignal` union (`types.ts`) through the
//     ONE observer chokepoint (`index.ts`'s `emit`) for every capture/video/wire event — covering
//     BOTH sensors, screen and wire (LS-13W) alike — so `recallSummary` here consumes that stream
//     directly (an array of already-collected signals) rather than re-deriving a log-line shape of
//     its own. A caller that persists the observed stream to its own JSONL (the origin app's own
//     choice, made in ITS package, not this one's) reads it back with plain `JSON.parse` per line —
//     those lines already deserialize to `RecallSignal` objects, so no adapter is needed there
//     either. `wire` signals carry no on-screen artifact (no screenshot/mp4 — they're a JSON
//     response, not something drawn on a page), so they never get a thumbnail, but they DO
//     contribute to `wireCaptures`, `seen`, `last`, and the `recent` timeline (LS-14's "cover BOTH
//     sensors" — a consumer sees wire activity in the same feed, not a second, separate one).
//
//  2. THUMBNAILS. The origin's `thumbDataUri` shells macOS `sips` unconditionally
//     (`recall-summary.ts:17-26`). `sips` doesn't exist off Darwin, and CI/most deployments are
//     Linux — so this port tries `sips` ONLY when `process.platform === 'darwin'` (a free fast path,
//     since it's already on every Mac and needs no extra process spec), and uses ffmpeg's own
//     single-frame extraction (`-frames:v 1 -vf scale=…`) as the cross-platform default — the SAME
//     tool this package already shells for `clip`/watched-video assembly (`video/assembler.ts`), so
//     this adds no new runtime dependency. `videoPoster` was ALREADY ffmpeg-only in the origin app
//     (`:30-40`) and is kept essentially verbatim.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import type { RecallActor, RecallSignal } from "./types.js";

const pexecFile = promisify(execFile);

/** Strip x/twitter's page-title suffixes down to the bare content title, and cap length for a
 *  timeline row. Ported verbatim from the origin app's `cleanTitle` (`recall-summary.ts:13`). */
export function cleanTitle(t: string | null | undefined): string {
  return (t || "").replace(/ \/ X$/, "").replace(/ on X.*$/, "").slice(0, 76);
}

async function ffmpegFrame(inputAbs: string, atSeconds: number, out: string): Promise<void> {
  await pexecFile("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(atSeconds), "-i", inputAbs, "-frames:v", "1", "-vf", "scale=168:-1", out]);
}

export interface ThumbOptions {
  /** Injectable for tests that want to FORCE the non-darwin (ffmpeg) path regardless of the actual
   *  host OS (LS-14 dev/03's Linux/ffmpeg proof). Defaults to the real `process.platform`. */
  platform?: NodeJS.Platform;
}

/**
 * Downscale a saved screenshot to a tiny PNG data URI (the capture timeline's thumbnails).
 *
 * darwin fast path: macOS `sips -Z 168` (the origin app's original, `recall-summary.ts:17-26`,
 * unchanged on that platform — no image-lib dependency, already on every Mac). EVERY other platform
 * (Linux CI, this sandbox, most server deployments): ffmpeg's single-frame `scale` filter treats a
 * still image exactly like a one-frame video — `-i <png/jpg> -frames:v 1 -vf scale=168:-1` reads the
 * file and re-encodes it at the same target width `sips -Z 168` produced, so both paths yield the
 * same shape of thumbnail. Returns `null` on any failure (the caller shows a placeholder tile) —
 * NEVER throws.
 */
export async function thumbDataUri(abs: string | null | undefined, opts: ThumbOptions = {}): Promise<string | null> {
  if (!abs || !existsSync(abs)) return null;
  const platform = opts.platform ?? process.platform;
  const out = resolve(tmpdir(), "lucarne-thumb-" + Math.random().toString(36).slice(2) + ".png");
  try {
    if (platform === "darwin") {
      await pexecFile("sips", ["-Z", "168", abs, "--out", out]);
    } else {
      await ffmpegFrame(abs, 0, out);
    }
    if (!existsSync(out)) return null;
    return "data:image/png;base64," + readFileSync(out, "base64");
  } catch {
    return null;
  } finally {
    try {
      rmSync(out, { force: true });
    } catch {
      /* best-effort cleanup — a leaked scratch file must never fail the caller */
    }
  }
}

/**
 * Extract a poster FRAME from a watched-video mp4 (so video rows in the timeline aren't blank
 * play-tiles). ffmpeg is ALREADY a recall dependency (`video/assembler.ts` shells it for
 * `clip`/watched-video assembly) — grab one frame near the start, scaled down, as a base64 data URI.
 * Ported near-verbatim from the origin app's `videoPoster` (`recall-summary.ts:30-40`, ALREADY
 * ffmpeg-only there — no `sips` fast path ever existed for video). Returns `null` on any failure.
 */
export async function videoPoster(abs: string | null | undefined): Promise<string | null> {
  if (!abs || !existsSync(abs)) return null;
  const out = resolve(tmpdir(), "lucarne-vp-" + Math.random().toString(36).slice(2) + ".png");
  try {
    await ffmpegFrame(abs, 0.3, out);
    if (!existsSync(out)) return null;
    return "data:image/png;base64," + readFileSync(out, "base64");
  } catch {
    return null;
  } finally {
    try {
      rmSync(out, { force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

export interface RecallSummaryEntry {
  kind: "view" | "video" | "wire";
  title: string;
  url: string;
  ts: number | null;
  /** `[startCt, maxCt]` watched range — `video` entries only. */
  dur: [number, number] | null;
  thumb: string | null;
  reason: string | null;
  by: RecallActor | null;
  detail: string | null;
}

export interface RecallSummary {
  /** Distinct urls seen (across all three signal kinds). */
  seen: number;
  /** Count of `capture` (screen-sensor "view") signals. */
  captures: number;
  /** Count of `video` signals. */
  videos: number;
  /** Total records added across every `wire` signal (LS-14: the wire sensor's contribution to the
   *  summary — it has no "captures" in the screenshot sense, so this is counted separately from
   *  `captures` rather than conflated with it). */
  wireCaptures: number;
  last: string | null;
  recent: RecallSummaryEntry[];
}

export interface RecallSummaryOptions {
  /** Cap on how many of the most-recent (de-duplicated) entries to include. The origin app's own
   *  cap (`recall-summary.ts:79`). */
  recentLimit?: number;
  /** Cap on how many thumbnails to actually generate — thumbnailing shells a process per image, so
   *  this bounds that cost per summary call. The origin app's own budget (`:86,90`). */
  thumbBudget?: number;
  /** Forwarded to `thumbDataUri` (LS-14 dev/03's platform-forcing test hook). */
  platform?: NodeJS.Platform;
}

interface NormalizedEntry {
  kind: "view" | "video" | "wire";
  title: string;
  url: string;
  ts: number | null;
  screenshot: string | null;
  file: string | null;
  reason: string | null;
  by: RecallActor | null;
  detail: string | null;
  dur: [number, number] | null;
}

function parseTs(ts: string): number | null {
  const n = Date.parse(ts);
  return Number.isNaN(n) ? null : n;
}

function normalize(signal: RecallSignal): NormalizedEntry {
  if (signal.kind === "capture") {
    return {
      kind: "view",
      title: cleanTitle(signal.title || signal.url),
      url: signal.url,
      ts: parseTs(signal.ts),
      screenshot: signal.screenshotFile || null,
      file: null,
      reason: signal.reason,
      by: signal.by,
      detail: signal.detail,
      dur: null,
    };
  }
  if (signal.kind === "video") {
    return {
      kind: "video",
      title: cleanTitle(signal.url),
      url: signal.url,
      ts: parseTs(signal.ts),
      screenshot: null,
      file: signal.mp4,
      reason: null,
      by: signal.by,
      detail: signal.stopReason,
      dur: signal.watchedRange,
    };
  }
  // kind === 'wire' (LS-13W): no on-screen artifact — no screenshot/file to thumbnail, no actor
  // attribution (the wire sensor doesn't attribute a driven tab), but it's still a genuine "the eye
  // saw something" event worth surfacing in the SAME timeline (LS-14's "cover both sensors").
  const n = signal.recordsAdded;
  return {
    kind: "wire",
    title: cleanTitle(signal.url),
    url: signal.url,
    ts: parseTs(signal.ts),
    screenshot: null,
    file: null,
    reason: null,
    by: null,
    detail: `${n} record${n === 1 ? "" : "s"} captured`,
    dur: null,
  };
}

/**
 * Summarize a `RecallSignal` stream into the small shape a "what have the sensors seen" view
 * renders — counts + a recent, de-duplicated, thumbnailed timeline. Ported from the origin app's
 * `recallSummary` (`recall-summary.ts:42-98`), reworked to consume the `RecallSignal` union directly
 * (see this file's header) rather than re-parsing a raw log line. `signals` is assumed
 * chronological, oldest-first (the order `index.ts`'s `emit` fires them, and the order a persisted
 * JSONL of them would read back in).
 */
export async function recallSummary(signals: readonly RecallSignal[], opts: RecallSummaryOptions = {}): Promise<RecallSummary> {
  const recentLimit = opts.recentLimit ?? 14;
  const thumbBudget = opts.thumbBudget ?? 9;

  const out: RecallSummary = { seen: 0, captures: 0, videos: 0, wireCaptures: 0, last: null, recent: [] };
  if (!signals.length) return out;

  const urls = new Set<string>();
  const entries: NormalizedEntry[] = [];
  for (const signal of signals) {
    const e = normalize(signal);
    if (e.kind === "video") out.videos++;
    else if (e.kind === "view") out.captures++;
    else out.wireCaptures += signal.kind === "wire" ? signal.recordsAdded : 0;
    if (e.url) urls.add(e.url);
    if (e.title || e.url) out.last = e.title || e.url;
    entries.push(e);
  }
  out.seen = urls.size;

  // newest first; collapse consecutive identical (kind,url) pairs (e.g. a scroll re-fires the same view)
  const recent: NormalizedEntry[] = [];
  let prevKey: string | null = null;
  for (let i = entries.length - 1; i >= 0 && recent.length < recentLimit; i--) {
    const e = entries[i]!;
    const key = e.kind + "|" + e.url;
    if (key === prevKey) continue;
    prevKey = key;
    recent.push(e);
  }

  // videos/wire entries rarely carry a page title of their own — borrow it from a VIEW of the same url.
  const titleByUrl = new Map<string, string>();
  for (const e of entries) {
    if (e.url && e.title && e.title !== e.url) titleByUrl.set(e.url, e.title);
  }

  let thumbed = 0;
  for (const r of recent) {
    let thumb: string | null = null;
    if (thumbed < thumbBudget) {
      if (r.kind === "view" && r.screenshot) {
        thumb = await thumbDataUri(r.screenshot, { platform: opts.platform });
        if (thumb) thumbed++;
      } else if (r.kind === "video" && r.file) {
        thumb = await videoPoster(r.file);
        if (thumb) thumbed++;
      }
      // kind === 'wire': never thumbnailed (no visual artifact) — see this file's header.
    }
    const title = r.title && r.title !== r.url ? r.title : (titleByUrl.get(r.url) ?? r.title);
    out.recent.push({ kind: r.kind, title, url: r.url, ts: r.ts, dur: r.dur, thumb, reason: r.reason, by: r.by, detail: r.detail });
  }
  return out;
}

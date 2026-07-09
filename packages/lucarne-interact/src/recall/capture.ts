// One static capture — ported from the origin app's `captureStatic` (`recall.ts:159-194`): an ARIA
// snapshot + an in-session screenshot + the two DOM probes (media boxes, viewport visibility),
// dispatched through the caller's extractor plugins, filtered to what was honestly ON SCREEN, and
// merged into the shared store. READ-ONLY: `page.locator(...).ariaSnapshot()` and `page.screenshot()`
// are passive reads of what's already rendered — no navigation, no synthetic input, no network
// request this recorder issues itself.
import { writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { Page } from "playwright-core";
import type { Capture, Entity } from "lucarne-records";
import { appendRecords } from "lucarne-records";
import { mediaProbe, visibleProbe } from "./dom-probes.js";
import type { MediaCropTracker } from "./media-crop.js";
import { filterVisibleRecords, rootIdFromUrl } from "./visible-filter.js";
import type { RecallActor, RecallCaptureReason, RecallExtractor } from "./types.js";

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
 * records. PURE (no I/O) — the extractors themselves are pure (`lucarne-records/sites`'s own
 * doc), and this loop is nothing but plugin selection, so it's independently Chrome-free
 * unit-testable (test/recall-extractor-dispatch.mjs) without a live Page. A misbehaving extractor
 * (one that throws) never breaks the capture or its siblings — same self-heal posture as the rest
 * of recall.
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
 * `tracker`), dispatching every matching extractor, applying the viewport-honesty filter, and
 * merging the resulting records into the shared store (`lucarne-records`' `appendRecords`).
 */
export async function runStaticCapture(page: Page, dataDir: string, extractors: readonly RecallExtractor[], tracker: MediaCropTracker, meta: CaptureMeta): Promise<CaptureOutcome> {
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
  const mediaBoxes = await page.evaluate(mediaProbe).catch(() => []);
  const visibleIds = await page.evaluate(visibleProbe).catch(() => []);

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

  const rootId = rootIdFromUrl(url);
  const filtered = filterVisibleRecords(records, visibleIds, rootId);
  for (const record of filtered) {
    const info = tracker.infoFor(record.provenance.id);
    if (!info) continue;
    (record as { raw?: Record<string, unknown> }).raw = { ...(record as { raw?: Record<string, unknown> }).raw, media: [info] };
  }

  const recordsAdded = filtered.length ? appendRecords(dataDir, filtered) : 0;
  return { url, title, ariaChars: aria.length, recordsAdded, ariaFile, screenshotFile: shotFile };
}

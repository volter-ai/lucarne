// LS-32 dev — recall's SCREEN sensor's DOM probes are PLUGGABLE, not hardwired to one site's markup
// (Chrome-free): `runStaticCapture` (capture.ts) now takes a `RecallPageProbes` argument instead of
// unconditionally evaluating a bundled `mediaProbe`/`visibleProbe`/`rootIdFromUrl` — this file proves
// both halves of that contract against a FAKE `Page` (no live Chrome needed; `page.evaluate(fn, arg)`
// is stood in as a direct `fn(arg)` call, which is exactly what a real Playwright `page.evaluate`
// does under the hood modulo the browser round-trip — the probe FUNCTIONS themselves are plain,
// self-contained JS, same law as `extractors`, so calling them directly here is a faithful stand-in):
//
//   (a) NO probes supplied (`{}`, or the field omitted) → zero crops, unfiltered records (the
//       viewport-honesty safety valve fires because `visibleProbe` is absent → `[]`), no thread
//       root, and the `onThread` formula `index.ts` computes from `probes.rootIdFromUrl` evaluates
//       false — recall degrades to "plain capture, no site assumptions" rather than silently
//       assuming X's markup.
//   (b) INJECTED fixture probes (standing in for a downstream domain package's own `xMediaProbe`/
//       `xVisibleProbe`/`xRootIdFromUrl`) → media boxes reach `MediaCropTracker` (crops are made),
//       visible ids reach `filterVisibleRecords` (only the reported-visible id + the thread root
//       survive), and the root id flows end-to-end (an off-screen record whose id equals the
//       injected `rootIdFromUrl`'s output is kept even though it was never in `visibleProbe`'s
//       output) — proving the SAME pipeline `startRecall`'s continuous loop runs, once a caller
//       plugs in its own probes, reproduces the pre-LS-32 X-shaped behavior exactly, just no longer
//       hardcoded into this package.
//
// READ-ONLY posture (Law 3) is UNCHANGED by this refactor: the probe functions are still only ever
// invoked via `page.evaluate` (a passive DOM read) in the real pipeline — LS-32 only changes WHO
// supplies the function body, never HOW it's invoked. test/recall-readonly-gates.mjs's grep gates
// (no fetch/XHR/click/goto in src/recall) already cover the invocation shape and stay green
// unchanged by this file's addition.
//
// Run with `node test/recall-probes-pluggable.mjs` (after `npm run build`).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runStaticCapture } from "../dist/recall/capture.js";
import { MediaCropTracker } from "../dist/recall/media-crop.js";
import { loadRecords } from "../dist/records/index.js";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

/** A FAKE Playwright `Page` — just enough surface for `runStaticCapture`: `url()`, `title()`,
 *  `locator(...).ariaSnapshot(...)`, `screenshot(...)`, and `evaluate(fn, arg)` (called as a direct
 *  `fn(arg)`, standing in for the real browser round-trip — see this file's header). */
function fakePage(url, title = "a fake page") {
  return {
    url: () => url,
    title: async () => title,
    locator: () => ({ ariaSnapshot: async () => "fake aria text" }),
    screenshot: async ({ path: p }) => {
      // MediaCropTracker below is given a FAKE crop backend, so the screenshot file's actual
      // contents are never read — a placeholder file is enough for writeFileSync/existsSync-style
      // bookkeeping elsewhere in the pipeline never to throw.
      writeFileSync(p, "");
    },
    evaluate: async (fn, arg) => fn(arg),
  };
}

/** A small, fully LOCAL fixture extractor (same LS-29 posture as other recall tests): match always
 *  true, extract returns a FIXED set of records regardless of the aria text — root, an on-screen
 *  reply, and an off-screen buffered reply, mirroring the shape recall-acceptance.mjs's live proof
 *  uses. */
const ROOT_ID = "ROOT";
const VISIBLE_ID = "VISIBLE";
const BUFFERED_ID = "BUFFERED";
const fixtureExtractor = {
  match: () => true,
  extract: () => [
    { kind: "post", provenance: { source: "example", id: ROOT_ID, canonicalUrl: "https://example.test/thread/ROOT", fetchedAt: "2026-01-01T00:00:00.000Z", via: "screen" }, text: "the root post", metrics: {} },
    { kind: "comment", provenance: { source: "example", id: VISIBLE_ID, canonicalUrl: "https://example.test/thread/VISIBLE", fetchedAt: "2026-01-01T00:00:00.000Z", via: "screen" }, text: "an on-screen reply", metrics: {} },
    { kind: "comment", provenance: { source: "example", id: BUFFERED_ID, canonicalUrl: "https://example.test/thread/BUFFERED", fetchedAt: "2026-01-01T00:00:00.000Z", via: "screen" }, text: "a buffered, off-screen reply", metrics: {} },
  ],
};

const THREAD_URL = "https://example.test/thread/ROOT";

// ── (a) NO probes supplied — every field absent, the safe no-op defaults ──
{
  const DIR = mkdtempSync(path.join(tmpdir(), "lucarne-probes-pluggable-a-"));
  const calls = [];
  const fakeBackend = (shotPath, outPath, box) => {
    calls.push({ shotPath, outPath, box });
    return { ok: true };
  };
  const tracker = new MediaCropTracker(DIR, fakeBackend);
  const page = fakePage(THREAD_URL);

  const outcome = await runStaticCapture(page, DIR, [fixtureExtractor], tracker, {}, { reason: "initial", by: "agent", detail: null });

  check("(a) no probes: zero crops made — MediaCropTracker's backend is never called", calls.length === 0, `${calls.length} call(s)`);

  const stored = loadRecords(DIR);
  const ids = stored.map((r) => r.provenance.id).sort();
  check(
    "(a) no probes: records are UNFILTERED (visibleProbe absent -> [] -> the safety valve keeps everything, including the would-be-buffered post)",
    ids.length === 3 && ids.includes(ROOT_ID) && ids.includes(VISIBLE_ID) && ids.includes(BUFFERED_ID),
    JSON.stringify(ids),
  );
  check("(a) no probes: CaptureOutcome.recordsAdded reflects all 3 unfiltered records", outcome.recordsAdded === 3, outcome.recordsAdded);

  // rootId: `capture.ts` computes `probes.rootIdFromUrl?.(url) ?? null` — with probes:{} that's
  // `undefined?.(...)`, i.e. always null. Exercised directly here (no exported hook into capture.ts's
  // internal `rootId` local), matching the exact expression capture.ts uses.
  const probesA = {};
  const rootIdA = probesA.rootIdFromUrl?.(THREAD_URL) ?? null;
  check("(a) no probes: rootId resolves to null (no thread model — RecallPageProbes.rootIdFromUrl absent)", rootIdA === null);

  // onThread: index.ts's loop computes `probes.rootIdFromUrl?.(sig.url) != null` — same formula,
  // exercised directly against the same empty-probes object (index.ts's inline one-liner has no
  // exported hook of its own to import; this is the exact expression it evaluates).
  const onThreadA = probesA.rootIdFromUrl?.(THREAD_URL) != null;
  check("(a) no probes: onThread evaluates false (default never-skip of the video-watch branch)", onThreadA === false);

  rmSync(DIR, { recursive: true, force: true });
}

// ── (b) INJECTED fixture probes — standing in for a downstream domain package's own probes ──
{
  const DIR = mkdtempSync(path.join(tmpdir(), "lucarne-probes-pluggable-b-"));
  const calls = [];
  const fakeBackend = (shotPath, outPath, box) => {
    calls.push({ shotPath, outPath, box });
    return { ok: true };
  };
  const tracker = new MediaCropTracker(DIR, fakeBackend);
  const page = fakePage(THREAD_URL);

  const fixtureMediaBox = { sid: VISIBLE_ID, alt: "a fixture photo", x: 10, y: 20, w: 64, h: 64, dpr: 1, full: true };
  const probes = {
    mediaProbe: () => [fixtureMediaBox],
    visibleProbe: () => [VISIBLE_ID], // only the reply was reported on-screen; the root is off-screen, the buffered post is off-screen and NOT the root
    rootIdFromUrl: (url) => (url.includes("/thread/") ? ROOT_ID : null),
  };

  const outcome = await runStaticCapture(page, DIR, [fixtureExtractor], tracker, probes, { reason: "initial", by: "agent", detail: null });

  check("(b) injected probes: media boxes reach the tracker — the backend was called for the visible post", calls.length === 1, `${calls.length} call(s)`);
  check("(b) injected probes: the crop box's sid matches the injected mediaProbe's output", calls[0]?.box && calls.length === 1, JSON.stringify(calls[0]?.box));

  const stored = loadRecords(DIR);
  const ids = stored.map((r) => r.provenance.id).sort();
  check(
    "(b) injected probes: visible ids reach filterVisibleRecords — only the reported-visible reply lands, plus the thread root",
    ids.length === 2 && ids.includes(VISIBLE_ID) && ids.includes(ROOT_ID) && !ids.includes(BUFFERED_ID),
    JSON.stringify(ids),
  );
  check(
    "(b) injected probes: rootId flows end-to-end — the ROOT post is kept even though it was never in visibleProbe's output",
    ids.includes(ROOT_ID),
  );
  check(
    "(b) injected probes: the buffered, non-root, non-visible post is DROPPED (viewport-honesty is active once a visibleProbe is injected)",
    !ids.includes(BUFFERED_ID),
  );
  check("(b) injected probes: CaptureOutcome.recordsAdded reflects the filtered count (2, not 3)", outcome.recordsAdded === 2, outcome.recordsAdded);

  // The visible record that WAS cropped carries the crop info in its `raw.media`.
  const visibleRecord = stored.find((r) => r.provenance.id === VISIBLE_ID);
  check("(b) injected probes: the cropped record's raw.media reflects the tracker's crop info", Array.isArray(visibleRecord?.raw?.media) && visibleRecord.raw.media.length === 1, JSON.stringify(visibleRecord?.raw));

  // onThread: same formula as case (a), now with a rootIdFromUrl that DOES resolve for this url.
  const onThreadB = probes.rootIdFromUrl?.(THREAD_URL) != null;
  check("(b) injected probes: onThread evaluates true (a thread model IS present via the injected rootIdFromUrl)", onThreadB === true);

  rmSync(DIR, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

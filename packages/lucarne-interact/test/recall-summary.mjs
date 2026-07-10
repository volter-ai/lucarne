// LS-14 dev/03 — the SUMMARY layer: thumbnail generation via ffmpeg with `sips` ABSENT (this
// sandbox's real platform — confirmed below — plus an explicit `platform` override so the proof
// doesn't silently depend on which OS happens to run it), and `recallSummary`'s own logic (counts,
// dedup, thumbnail budget, title-borrowing) exercised over a `RecallSignal` stream covering ALL
// THREE signal kinds (capture/video/wire — LS-14's "cover both sensors" for the summary layer too).
//
// LS-32: `cleanTitle` is now a GENERIC trim+cap (the origin's x/twitter branding-suffix stripping
// moved downstream to a domain package's own `xCleanTitle`, injected via
// `RecallSummaryOptions.cleanTitle`) — this file tests the generic default directly, plus the
// injection/composition contract (a fixture "site-suffix" cleaner applied BEFORE the generic cap),
// standing in for a real `xCleanTitle` the same way other recall tests stand in fixture
// extractors/probes for a domain package's own.
//
// Run with `node test/recall-summary.mjs` (after `npm run build`). Prefers a real `ffmpeg` on
// PATH (this sandbox and CI-Linux both normally have one; no browser needed) but DEGRADES
// GRACEFULLY — never hard-fails the unit lane — when ffmpeg is missing: fixture generation uses
// `spawnSync` (which reports a status/error instead of throwing on ENOENT, unlike
// `execFileSync`), and every assertion that depends on a REAL generated thumbnail/poster is
// skipped (with a clear `SKIP: ffmpeg unavailable` notice) rather than failed. Assertions that
// don't need ffmpeg (cleanTitle, counting/ordering/dedup logic, thumbBudget:0) always run for
// real, whether or not ffmpeg is present.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanTitle, recallSummary, thumbDataUri, videoPoster } from "../dist/recall/summary.js";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const DIR = mkdtempSync(join(tmpdir(), "lucarne-interact-summary-test-"));
const pngPath = join(DIR, "shot.png");
const mp4Path = join(DIR, "watched.mp4");

const pngGen = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x240", "-frames:v", "1", pngPath]);
const mp4Gen = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=320x240:d=1", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", mp4Path]);
const haveFfmpeg = !pngGen.error && pngGen.status === 0 && existsSync(pngPath) && !mp4Gen.error && mp4Gen.status === 0 && existsSync(mp4Path);
if (!haveFfmpeg) {
  console.log("SKIP: ffmpeg unavailable on PATH — skipping this file's ffmpeg-backed thumbnail/poster assertions (fixture generation failed); non-ffmpeg assertions below still run for real.");
}
check("fixture setup: ffmpeg produced the still-image fixture (or SKIP: ffmpeg unavailable)", haveFfmpeg || (!!pngGen.error || pngGen.status !== 0));
check("fixture setup: ffmpeg produced the mp4 fixture (or SKIP: ffmpeg unavailable)", haveFfmpeg || (!!mp4Gen.error || mp4Gen.status !== 0));

// ── sanity precondition: sips is genuinely ABSENT on this host (proves the ffmpeg path below is
//    load-bearing, not a fallback that never gets exercised) ──
const sipsLookup = spawnSync("which", ["sips"]);
check("precondition: 'sips' is NOT on PATH in this sandbox (the Linux/ffmpeg case is genuinely exercised)", sipsLookup.status !== 0);
check("precondition: the real host platform is non-darwin", process.platform !== "darwin", process.platform);

// ── thumbDataUri: the real (non-forced) platform already routes to ffmpeg here ──
if (haveFfmpeg) {
  const uri = await thumbDataUri(pngPath);
  check("thumbDataUri (real platform): returns a data URI, not null", typeof uri === "string" && uri.length > 0);
  check("thumbDataUri (real platform): it's a base64 PNG data URI", uri && uri.startsWith("data:image/png;base64,"));
} else {
  check("thumbDataUri (real platform) section skipped: ffmpeg unavailable in this environment (not a product defect)", true);
}

// ── thumbDataUri: EXPLICITLY forcing the non-darwin path (independent of whatever host runs this) ──
if (haveFfmpeg) {
  const uri = await thumbDataUri(pngPath, { platform: "linux" });
  check("thumbDataUri (forced platform:'linux'): returns a valid data URI via ffmpeg", uri && uri.startsWith("data:image/png;base64,"));
} else {
  check("thumbDataUri (forced platform:'linux') section skipped: ffmpeg unavailable in this environment (not a product defect)", true);
}
if (haveFfmpeg) {
  // a THIRD, arbitrary non-darwin platform value — proves the branch is "darwin vs. everything
  // else", not an allowlist of specific non-darwin strings.
  const uri = await thumbDataUri(pngPath, { platform: "win32" });
  check("thumbDataUri (forced platform:'win32'): still routes to ffmpeg (any non-darwin platform)", uri && uri.startsWith("data:image/png;base64,"));
} else {
  check("thumbDataUri (forced platform:'win32') section skipped: ffmpeg unavailable in this environment (not a product defect)", true);
}

// ── thumbDataUri: absent/missing file → null, never throws (doesn't need ffmpeg to be present —
//    the missing-file check short-circuits before ffmpeg is invoked) ──
{
  const uriMissing = await thumbDataUri(join(DIR, "does-not-exist.png"));
  check("thumbDataUri: a missing file returns null (never throws)", uriMissing === null);
  const uriNullish = await thumbDataUri(null);
  check("thumbDataUri: a null/undefined path returns null", uriNullish === null && (await thumbDataUri(undefined)) === null);
}

// ── videoPoster: ffmpeg frame extraction from the mp4 fixture ──
if (haveFfmpeg) {
  const uri = await videoPoster(mp4Path);
  check("videoPoster: returns a valid PNG data URI extracted from the mp4", uri && uri.startsWith("data:image/png;base64,"));
  const uriMissing = await videoPoster(join(DIR, "nope.mp4"));
  check("videoPoster: a missing file returns null (never throws)", uriMissing === null);
} else {
  check("videoPoster section skipped: ffmpeg unavailable in this environment (not a product defect)", true);
  const uriMissing = await videoPoster(join(DIR, "nope.mp4"));
  check("videoPoster: a missing file returns null (never throws) — doesn't need ffmpeg", uriMissing === null);
}

// ── cleanTitle (LS-32: now a GENERIC trim+cap; no site-specific suffix stripping by default) ──
{
  check("cleanTitle: trims whitespace", cleanTitle("  Some Post  ") === "Some Post");
  check("cleanTitle: does NOT strip any site-specific suffix by default (LS-32 — that's a caller's own injected cleaner now)", cleanTitle("Some Post / X") === "Some Post / X");
  check("cleanTitle: caps length at 76", cleanTitle("x".repeat(200)).length === 76);
  check("cleanTitle: absent/null → ''", cleanTitle(null) === "" && cleanTitle(undefined) === "");
}

// ── recallSummary: a signal stream covering ALL THREE kinds (capture/video/wire) ──
{
  const signals = [
    { kind: "capture", ts: "2026-07-08T09:00:00.000Z", url: "https://example.test/home", title: "Home Feed", reason: "initial", detail: null, by: "human", recordsAdded: 2, ariaFile: "a1.txt", screenshotFile: pngPath },
    { kind: "capture", ts: "2026-07-08T09:01:00.000Z", url: "https://example.test/home", title: "Home Feed", reason: "scrolled", detail: "more", by: "human", recordsAdded: 1, ariaFile: "a2.txt", screenshotFile: pngPath },
    { kind: "capture", ts: "2026-07-08T09:01:05.000Z", url: "https://example.test/home", title: "Home Feed", reason: "scrolled", detail: "more still", by: "human", recordsAdded: 0, ariaFile: "a3.txt", screenshotFile: pngPath },
    { kind: "wire", ts: "2026-07-08T09:02:00.000Z", url: "https://example.test/i/api/graphql/abc/UserPosts", recordsAdded: 3 },
    { kind: "video", ts: "2026-07-08T09:03:00.000Z", url: "https://example.test/home", by: "agent", stopReason: "ended", mp4: mp4Path, watchedRange: [0, 12.4], frames: 60 },
    { kind: "wire", ts: "2026-07-08T09:04:00.000Z", url: "https://example.test/i/api/graphql/def/PostDetail", recordsAdded: 2 },
  ];

  const summary = await recallSummary(signals);
  check("recallSummary: seen counts DISTINCT urls across all signal kinds", summary.seen === 3, summary.seen);
  check("recallSummary: captures counts only 'capture' signals", summary.captures === 3, summary.captures);
  check("recallSummary: videos counts only 'video' signals", summary.videos === 1, summary.videos);
  check("recallSummary: wireCaptures sums recordsAdded across 'wire' signals (LS-14: wire is covered too)", summary.wireCaptures === 5, summary.wireCaptures);
  check("recallSummary: last reflects the chronologically LAST signal's title/url", summary.last === "https://example.test/i/api/graphql/def/PostDetail");

  // recent: newest-first, consecutive (kind,url) duplicates collapsed — the two consecutive
  // 'capture'+'https://example.test/home' entries (scrolled, scrolled) collapse to ONE row.
  const kinds = summary.recent.map((r) => r.kind);
  check("recallSummary.recent: newest-first ordering", summary.recent[0].kind === "wire" && summary.recent[0].url.includes("PostDetail"));
  check("recallSummary.recent: consecutive duplicate (kind,url) captures collapse to one row", kinds.filter((k) => k === "view").length === 1, JSON.stringify(kinds));
  check("recallSummary.recent: a wire entry is included in the SAME timeline (both sensors, one feed)", kinds.includes("wire"));
  check("recallSummary.recent: a wire entry never carries a thumbnail (no visual artifact)", summary.recent.find((r) => r.kind === "wire").thumb === null);
  check("recallSummary.recent: a wire entry's detail reports its record count", /2 records? captured/.test(summary.recent.find((r) => r.url.includes("PostDetail")).detail));

  const videoRow = summary.recent.find((r) => r.kind === "video");
  if (haveFfmpeg) {
    check("recallSummary.recent: the video row got a poster thumbnail (ffmpeg)", videoRow && typeof videoRow.thumb === "string" && videoRow.thumb.startsWith("data:image/png;base64,"));
  } else {
    check("recallSummary.recent: video row thumbnail check skipped: ffmpeg unavailable in this environment (not a product defect)", true);
  }
  check("recallSummary.recent: the video row's dur carries the watchedRange verbatim", videoRow && videoRow.dur[0] === 0 && videoRow.dur[1] === 12.4);

  const viewRow = summary.recent.find((r) => r.kind === "view");
  if (haveFfmpeg) {
    check("recallSummary.recent: the view row got a screenshot thumbnail (ffmpeg)", viewRow && typeof viewRow.thumb === "string" && viewRow.thumb.startsWith("data:image/png;base64,"));
  } else {
    check("recallSummary.recent: view row thumbnail check skipped: ffmpeg unavailable in this environment (not a product defect)", true);
  }
  check("recallSummary.recent: default cleanTitle is pass-through (no injected cleaner) ('Home Feed' -> 'Home Feed')", viewRow && viewRow.title === "Home Feed");
}

// ── recallSummary: title-borrowing — a video/wire row with no title of its own borrows a VIEW's ──
{
  const signals = [
    { kind: "capture", ts: "2026-07-08T10:00:00.000Z", url: "https://example.test/watch/1", title: "A Great Talk", reason: "initial", detail: null, by: "human", recordsAdded: 1, ariaFile: "b1.txt", screenshotFile: pngPath },
    { kind: "video", ts: "2026-07-08T10:01:00.000Z", url: "https://example.test/watch/1", by: "human", stopReason: "ended", mp4: mp4Path, watchedRange: [0, 30], frames: 100 },
  ];
  const summary = await recallSummary(signals, { thumbBudget: 0 });
  const videoRow = summary.recent.find((r) => r.kind === "video");
  check("recallSummary: a video row with a bare-url title borrows the co-located VIEW's real title", videoRow && videoRow.title === "A Great Talk", videoRow && videoRow.title);
  check("recallSummary: thumbBudget:0 suppresses ALL thumbnails (view row too)", summary.recent.every((r) => r.thumb === null));
}

// ── recallSummary: LS-32's `RecallSummaryOptions.cleanTitle` injection — a caller-supplied
//    pre-cap cleaner (standing in for a downstream domain package's own site-suffix stripper, e.g.
//    an `xCleanTitle`) composes with this file's own generic cap, applied BEFORE it ──
{
  const fixtureSiteSuffixCleaner = (t) => String(t || "").replace(/ \/ SITE$/, "");
  const signals = [
    { kind: "capture", ts: "2026-07-08T11:00:00.000Z", url: "https://example.test/p/1", title: "Some Post / SITE", reason: "initial", detail: null, by: "human", recordsAdded: 1, ariaFile: "c1.txt", screenshotFile: pngPath },
  ];
  const withInjectedCleaner = await recallSummary(signals, { cleanTitle: fixtureSiteSuffixCleaner, thumbBudget: 0 });
  const withoutCleaner = await recallSummary(signals, { thumbBudget: 0 });
  check(
    "recallSummary: an injected cleanTitle strips a caller-defined suffix before the generic cap",
    withInjectedCleaner.recent[0]?.title === "Some Post",
    withInjectedCleaner.recent[0]?.title,
  );
  check(
    "recallSummary: WITHOUT an injected cleanTitle, the same raw title passes through untouched (generic cap only)",
    withoutCleaner.recent[0]?.title === "Some Post / SITE",
    withoutCleaner.recent[0]?.title,
  );
}

// ── recallSummary: an empty stream returns a valid, empty shape rather than throwing ──
{
  const empty = await recallSummary([]);
  check("recallSummary([]): valid empty shape", empty.seen === 0 && empty.captures === 0 && empty.videos === 0 && empty.wireCaptures === 0 && empty.last === null && empty.recent.length === 0);
}

// ── recallSummary: recentLimit is honored ──
{
  const many = Array.from({ length: 20 }, (_, i) => ({
    kind: "capture",
    ts: new Date(2026, 6, 8, 9, 0, i).toISOString(),
    url: `https://x.com/p/${i}`,
    title: `Post ${i}`,
    reason: "scrolled",
    detail: null,
    by: "human",
    recordsAdded: 1,
    ariaFile: `f${i}.txt`,
    screenshotFile: null,
  }));
  const summary = await recallSummary(many, { recentLimit: 5 });
  check("recallSummary: recentLimit caps the recent[] length", summary.recent.length === 5, summary.recent.length);
  check("recallSummary: recentLimit keeps the NEWEST entries", summary.recent[0].url === "https://x.com/p/19");
}

rmSync(DIR, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

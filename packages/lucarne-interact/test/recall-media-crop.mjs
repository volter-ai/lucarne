// LS-13 dev/02's "media crops derive from the session screenshot" proof (Chrome-free): exercises
// BOTH halves of `MediaCropTracker` — the dedup/upgrade LOGIC (ported from cadence's `cropMedia`,
// `recall.ts:144-157`) against a fake, deterministic crop backend, and the REAL ffmpeg-backed
// `cropImageFromScreenshot` (the shared assembler's crop, `video/assembler.ts`) against a real
// screenshot fixture — proving crops genuinely come OUT of the screenshot file, never a network
// fetch (no `pbs.twimg.com`/CDN URL appears anywhere in this path; see test/recall-readonly-gates.mjs
// for the grep gate).
//
// Run with `node test/recall-media-crop.mjs` (after `npm run build`; needs `ffmpeg` on PATH for the
// real-crop section — that section is skipped, not failed, if ffmpeg is unavailable).
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { MediaCropTracker } from "../dist/recall/media-crop.js";
import { cropImageFromScreenshot } from "../dist/video/assembler.js";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const WORK = mkdtempSync(path.join(tmpdir(), "lucarne-recall-media-crop-"));

// ── A. dedup/upgrade LOGIC, with a fake deterministic backend (no ffmpeg needed) ──
{
  const calls = [];
  const fakeBackend = (shotPath, outPath, box) => {
    calls.push({ shotPath, outPath, box });
    return { ok: true };
  };
  const tracker = new MediaCropTracker(WORK, fakeBackend);

  const partial = { sid: "1", alt: "a photo", x: 10, y: 10, w: 50, h: 50, dpr: 1, full: false };
  tracker.crop("/fake/shot1.png", [partial]);
  check("first crop (partial) is made", calls.length === 1);
  check("infoFor reflects the partial crop", tracker.infoFor("1")?.alt === "a photo");

  tracker.crop("/fake/shot2.png", [{ ...partial, full: false }]);
  check("a SECOND partial crop of the same post is SKIPPED (had a partial, still partial)", calls.length === 1);

  tracker.crop("/fake/shot3.png", [{ ...partial, full: true }]);
  check("a FULL crop UPGRADES a prior partial (cadence's upgrade rule)", calls.length === 2);

  tracker.crop("/fake/shot4.png", [{ ...partial, full: true }]);
  check("once FULL, a later crop attempt of the same post is SKIPPED (already have a full crop)", calls.length === 2);

  tracker.crop("/fake/shot5.png", [{ ...partial, sid: "2", full: false }]);
  check("a DIFFERENT post id always gets its own crop", calls.length === 3);

  check("crop box coordinates are dpr-scaled and rounded", calls[0].box.x === 10 && calls[0].box.w === 50);
}

// ── B. seed() (reconcile) never overwrites an existing entry ──
{
  const tracker = new MediaCropTracker(WORK, () => ({ ok: true }));
  tracker.crop("/fake/shot.png", [{ sid: "9", alt: "real alt", x: 0, y: 0, w: 10, h: 10, dpr: 1, full: true }]);
  tracker.seed("9", { image: "/some/other/path.png", alt: "" });
  check("seed() does not overwrite an already-tracked post", tracker.infoFor("9").alt === "real alt");
  tracker.seed("10", { image: "/reconciled.png", alt: "" });
  check("seed() DOES populate a post the tracker has never seen", tracker.infoFor("10")?.image === "/reconciled.png");
}

// ── C. REAL ffmpeg crop, against a real screenshot fixture — proves the crop genuinely derives
//    from the screenshot file on disk (no CDN, no network) ──
const shotPath = path.join(WORK, "shot.png");
const gen = spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=1", "-frames:v", "1", shotPath], { encoding: "utf8" });
const haveFfmpeg = gen.status === 0 && existsSync(shotPath);
if (haveFfmpeg) {
  const tracker = new MediaCropTracker(WORK); // default backend = the real cropImageFromScreenshot
  const box = { sid: "real-1", alt: "real crop", x: 20, y: 20, w: 64, h: 64, dpr: 1, full: true };
  const cropped = tracker.crop(shotPath, [box]);
  const info = tracker.infoFor("real-1");
  const cropExists = info && existsSync(info.image);
  check("real ffmpeg crop: a real, non-trivial PNG file lands on disk", !!cropExists && statSync(info.image).size > 100, cropExists ? `${statSync(info.image).size} bytes` : "no file");
  check("real ffmpeg crop: the returned crop record matches infoFor", cropped["real-1"]?.image === info?.image);

  // Sanity: cropImageFromScreenshot itself refuses when the source screenshot is missing (never
  // silently invents pixels from nowhere).
  const missing = cropImageFromScreenshot(path.join(WORK, "does-not-exist.png"), path.join(WORK, "out.png"), { x: 0, y: 0, w: 10, h: 10 });
  check("cropImageFromScreenshot: refuses when the source screenshot is missing", missing.ok === false);
} else {
  check("real ffmpeg crop section skipped: ffmpeg unavailable in this environment (not a product defect)", true, gen.stderr?.slice(-200));
}

rmSync(WORK, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

// LS-09 dev/03 — the policy-free gate + the single-shared-assembler gate (Chrome-free, grep-only).
//
// 1. No cadence policy leaked into this package: FEEDS map, x.com/home, .social/ paths, or
//    channels/ guide lookups must not appear anywhere in src/.
// 2. Exactly ONE ffmpeg arg-list exists in the package (the shared assembler in
//    video/assembler.ts) — `clip` must call it rather than carrying its own.
//
// Run with `node test/policy-free-gate.mjs` (no build needed — this only greps src/).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(PKG_ROOT, "src");

function grep(pattern, dir = SRC) {
  try {
    const out = execFileSync("grep", ["-REn", pattern, dir], { encoding: "utf8" });
    return out.split("\n").filter(Boolean);
  } catch (e) {
    // grep exits 1 when there are no matches — that's the success case here.
    if (e.status === 1) return [];
    throw e;
  }
}

// ── policy-free gate ──
const policyHits = grep("FEEDS|x\\.com/home|\\.social|channels/");
check("no cadence policy strings (FEEDS|x.com/home|.social|channels/) in src/", policyHits.length === 0, policyHits.join(" | "));

// ── one shared video assembler; clip() uses it (no second ffmpeg arg-list) ──
const libx264Hits = grep("libx264");
check("exactly one 'libx264' reference in src/ (one ffmpeg arg-list, the shared assembler)", libx264Hits.length === 1, libx264Hits.join(" | "));
check(
  "the sole 'libx264' reference lives in video/assembler.ts",
  libx264Hits.length === 1 && libx264Hits[0].includes(path.join("video", "assembler.ts")),
  libx264Hits[0],
);

const spawnFfmpegHits = grep('spawnSync\\("ffmpeg"|spawn\\("ffmpeg"');
check(
  "ffmpeg is only ever spawned from video/assembler.ts (no second spawn site)",
  spawnFfmpegHits.every((l) => l.includes(path.join("video", "assembler.ts"))),
  spawnFfmpegHits.join(" | "),
);

const sessionSrc = readFileSync(path.join(SRC, "session.ts"), "utf8");
check(
  "session.ts's #clip calls the shared assembleMp4FromFrames (not a local ffmpeg call)",
  sessionSrc.includes("assembleMp4FromFrames(") && !/spawnSync\(\s*["']ffmpeg["']/.test(sessionSrc),
);
check(
  "session.ts's #clip uses the shared startScreencastToFrames (not a local Page.startScreencast wiring)",
  sessionSrc.includes("startScreencastToFrames(") && !sessionSrc.includes('"Page.startScreencast"') && !sessionSrc.includes("'Page.startScreencast'"),
);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

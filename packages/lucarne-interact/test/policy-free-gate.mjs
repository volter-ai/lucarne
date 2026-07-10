// LS-09 dev/03 — the policy-free gate + the single-shared-assembler gate (Chrome-free, grep-only).
//
// 1. No cadence policy leaked into this package: FEEDS map, x.com/home, .social/ paths, or
//    channels/ guide lookups must not appear anywhere in src/.
// 2. Exactly ONE ffmpeg arg-list exists in the package (the shared assembler in
//    video/assembler.ts) — `clip` must call it rather than carrying its own.
// 3. LS-31/S1: a standing "no domain vocab in lucarne-interact" gate. The whole point of inverting
//    `activate-gate.ts` to a structural default-refuse classifier + DATA-ONLY `ActivatePolicy` is
//    that this package carries ZERO site-specific knowledge — every domain testid/selector lives in
//    the CONSUMER's policy object (cadence's `CADENCE_ACTIVATE_POLICY`), never in this package's
//    source. This fails the build if an X testid literal or generic social-platform vocabulary word
//    ever creeps back into src/ (e.g. a future dev re-adding a per-site allowlist INSIDE this
//    package, exactly the shape LS-31/S1 removed).
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

// ── LS-32: standing "recall's DOM probes are pluggable, not X-hardwired" gate ──
// `mediaProbe`/`visibleProbe`'s concrete X-shaped DOM queries (a status-link selector, a
// photo-testid selector, a media-path image selector), `visible-filter.ts`'s old `rootIdFromUrl`
// (`/status/`), `summary.ts`'s old `cleanTitle` (the x/twitter branding-suffix regex), and
// `dom-probes.ts`'s old `tabSignatureProbe` firstText selector (`article,.thing,.athing`) all moved
// DOWNSTREAM to a domain package's own probes, injected via `StartRecallOptions.probes`
// (`RecallPageProbes`) / `RecallSummaryOptions.cleanTitle`. This package must carry ZERO of those
// literal, site-shaped fragments in src/recall/ — a re-introduced hardcoded probe body is exactly
// the shape LS-32 removed.
const recallProbeLiteralHits = grep('tweetPhoto|/status/|/media/| on X| / X|\\.athing|\\.thing', path.join(SRC, "recall"));
check(
  "no X-shaped DOM-probe literals (tweetPhoto|/status/|/media/| on X| / X|.athing|.thing) in src/recall/ — probes are pluggable, this package bundles none",
  recallProbeLiteralHits.length === 0,
  recallProbeLiteralHits.join(" | "),
);

// ── LS-31/S1: standing "no domain vocab in lucarne-interact" gate ──
// X-specific testid literals (site-authored identifiers, not generic words) — these must live ONLY
// in a CONSUMER's ActivatePolicy (cadence's CADENCE_ACTIVATE_POLICY), never hardcoded in this
// package. `data-testid.*reply` also catches a re-introduced per-site "compose-open testid" set like
// the one LS-31/S1 deleted (SITE_COMPOSE_OPEN_TESTIDS used to hardcode `data-testid="reply"`).
const xTestidHits = grep("tweetButton|dmComposerSend|data-testid.*reply");
check(
  "no X testid literals (tweetButton|dmComposerSend|data-testid.*reply) in src/",
  xTestidHits.length === 0,
  xTestidHits.join(" | "),
);

// Generic social-platform vocabulary — LS-28's blocklist regexes (GENERIC_SUBMIT_RE,
// GENERIC_ACCOUNT_STATE_RE) hardcoded exactly this kind of word list; LS-31/S1 deleted them as
// decision inputs (default-refuse makes them unnecessary). If this vocabulary reappears anywhere in
// src/, it's a sign the blocklist shape is creeping back in.
const socialVocabHits = grep("retweet|upvote|downvote|\\bbookmark\\b");
check(
  "no social-platform vocabulary (retweet|upvote|downvote|bookmark) in src/",
  socialVocabHits.length === 0,
  socialVocabHits.join(" | "),
);

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

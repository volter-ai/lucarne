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
// LS-36 adds a standing gate for the broader CLASS this bug belonged to: site-specific DOM
// selectors (a site-authored `data-testid` VALUE, a site-player CSS class, a site hostname, a
// site URL-path shape) hardcoded anywhere in this "general" interaction layer. X's
// `[data-testid="app-bar-back"]` (session.ts's old `back()` default) and YouTube's
// `.ytp-caption-segment` (session.ts's old `#captions` overlay fallback) were exactly this shape —
// both are now CONSUMER-provided overrides (`back({ inAppSelectors })` /
// `captions(selector, { overlaySelectors })`), sourced from cadence's own config, never
// hardcoded here. See the "LS-36" section below.
//
// Run with `node test/policy-free-gate.mjs` (no build needed — this only greps src/).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

// ── LS-36: standing "no site-specific DOM selectors in lucarne-interact" gate ──
// This is the CLASS gate: it must catch not just the two literals LS-36 removed (X's
// `app-bar-back` testid, YouTube's `.ytp-caption-segment`) but the SHAPE — any future site-authored
// testid value, site-player class, site hostname, or site URL-path pattern hardcoded into src/.
//
// `grepCode` is `grep` with comment-only lines dropped, so illustrative doc-comment EXAMPLES of the
// generic, consumer-supplied `ActivatePolicy` mechanism (activate-gate.ts's `ActivateAllowEntry`
// doc, which uses `"x.com"`/`old.reddit` as prose examples of what a CONSUMER's policy object can
// contain — never a value this package itself reads or acts on) don't false-positive the gate. A
// real hostname literal appearing in actual CODE (not a comment) still gets caught.
function grepCode(pattern, dir = SRC) {
  return grep(pattern, dir).filter((line) => {
    const content = line.replace(/^[^:]*:\d+:/, "");
    return !/^\s*(\/\/|\*|\/\*)/.test(content);
  });
}

// 1. Site-authored `data-testid="<value>"` literals. The generic testid-READING mechanism
//    (activate-gate.ts's classifier, session.ts's `el.getAttribute("data-testid")`) is fine — it
//    reads whatever testid is PRESENT, never hardcodes a site's VALUE. What's banned is a literal
//    `data-testid="..."` STRING baked into this package. A tiny allowlist covers values that are
//    genuinely generic conventions (not one site's authored vocabulary) — currently just
//    `"captions"`, session.ts's generic caption-overlay marker (kept alongside `.captions-text`/
//    video.js's own `.vjs-text-track-cue`; YouTube's `.ytp-caption-segment` was removed — see #2).
const GENERIC_TESTID_VALUES = new Set(["captions"]);
function findTestidOffenders(dir = SRC) {
  const offenders = [];
  for (const line of grepCode('data-testid="[^"]+"', dir)) {
    for (const m of line.matchAll(/data-testid="([^"]+)"/g)) {
      if (!GENERIC_TESTID_VALUES.has(m[1])) offenders.push(`${line} (value="${m[1]}")`);
    }
  }
  return offenders;
}
const testidOffenders = findTestidOffenders();
check(
  'no site-authored data-testid="<value>" literals in src/ (only the generic "captions" value is allowlisted)',
  testidOffenders.length === 0,
  testidOffenders.join(" | "),
);

// 2. Site-player CSS classes — YouTube's `.ytp-` prefix is the one this class of bug actually
//    shipped (session.ts's old caption-overlay fallback). `.vjs-` (video.js) is a generic
//    open-source library used by many unrelated sites, not one site's authorship — NOT banned.
const sitePlayerClassHits = grepCode("\\.ytp-");
check("no YouTube player classes (.ytp-) in src/", sitePlayerClassHits.length === 0, sitePlayerClassHits.join(" | "));

// 3. Site hostnames, in actual code (not doc-comment prose — see grepCode above).
const HOSTNAME_PATTERN = "x\\.com|twitter\\.com|youtube|reddit|hackernews";
const hostnameHits = grepCode(HOSTNAME_PATTERN);
check(
  "no site hostname literals (x.com|twitter.com|youtube|reddit|hackernews) in src/ code (doc-comment examples of the generic ActivatePolicy mechanism are exempt)",
  hostnameHits.length === 0,
  hostnameHits.join(" | "),
);

// 4. Site URL-path shapes — `/status/` (X's tweet-permalink path shape) anywhere in src/, not just
//    src/recall/ (the narrower LS-32 check above only scoped that directory).
const statusPathHits = grepCode("/status/");
check("no '/status/' URL-path literal anywhere in src/", statusPathHits.length === 0, statusPathHits.join(" | "));

// ── non-vacuity demo: prove checks 1-4 actually FAIL when a site literal is present ──
// Runs the same grep-based logic against a throwaway fixture file containing exactly the shapes
// LS-36 removed (X's testid, YouTube's class, X's hostname, X's URL path) planted in real CODE
// (not a comment) — if the gate can't catch its own fixture, it isn't actually standing.
const demoDir = mkdtempSync(path.join(tmpdir(), "policy-free-gate-demo-"));
try {
  writeFileSync(
    path.join(demoDir, "fixture.ts"),
    [
      'const DEFAULT_BACK_SELECTORS = [\'[data-testid="app-bar-back"]\'];',
      'for (const cs of [".ytp-caption-segment"]) {}',
      'const HOSTS = ["x.com"];',
      'const REPLY = "/status/123/reply";',
    ].join("\n"),
  );
  const demoTestidOffenders = findTestidOffenders(demoDir);
  const demoClassHits = grepCode("\\.ytp-", demoDir);
  const demoHostHits = grepCode(HOSTNAME_PATTERN, demoDir);
  const demoStatusHits = grepCode("/status/", demoDir);
  check(
    "non-vacuity: the data-testid check FAILS against a fixture containing X's app-bar-back literal",
    demoTestidOffenders.length > 0,
    `${demoTestidOffenders.length} offender(s) found in fixture, as expected`,
  );
  check(
    "non-vacuity: the site-player-class check FAILS against a fixture containing .ytp-caption-segment",
    demoClassHits.length > 0,
    `${demoClassHits.length} hit(s) found in fixture, as expected`,
  );
  check(
    "non-vacuity: the hostname check FAILS against a fixture containing x.com in code",
    demoHostHits.length > 0,
    `${demoHostHits.length} hit(s) found in fixture, as expected`,
  );
  check(
    "non-vacuity: the /status/ check FAILS against a fixture containing an X status path",
    demoStatusHits.length > 0,
    `${demoStatusHits.length} hit(s) found in fixture, as expected`,
  );
} finally {
  rmSync(demoDir, { recursive: true, force: true });
}

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

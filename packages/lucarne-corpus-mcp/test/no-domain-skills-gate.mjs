// LS-46 (panel-fix-skills) — .claude/skills domain-neutrality gate.
// LS-48 (panel-fix hardening) — closes 2 blind spots the re-panel generality skeptic found:
//   1. This gate used to scan ONLY `.claude/skills/`, missing the SECOND live skills root,
//      `.codex/skills/` (mirrors develop/draft/pm/reviewer for the codex agent runner). A
//      codex-only social skill would have recurred silently. Now scans BOTH roots (and any other
//      `<dir>/skills/` root that shows up in the repo tree — see SKILLS_ROOTS below).
//   2. The banned-vocab list only covered the original x/reddit/HN incident terms and omitted
//      `linkedin` / `youtube` — both LIVE domains of this product (cadence ships
//      `channels/linkedin/`), so a `linkedin-outreach` or `youtube-*` skill would have passed
//      clean. Now banned alongside the original terms.
//
// lucarne is the DOMAIN-AGNOSTIC platform repo (packages/* ship a generic corpus-read primitive
// and generic dev/code-host skills — develop/draft/pm/reviewer). The four x/reddit/HN OPERATOR
// skills (socials-toolkit, review-profile, research-topic, recommend-replies) were shipped into
// this repo's `.claude/skills/` by the earlier split merge — a domain-specific consumer concern
// that belongs in `cadence` (the social consumer repo), not in the platform. They've been removed
// (this commit); this gate is the enforcement so they — or any other social/domain vocabulary —
// can never land back in `.claude/skills/` (or `.codex/skills/`) silently again.
//
// Existing package-clean gates (e.g. this package's own test/package-clean-gate.mjs) only scan a
// single package's `src/` — the repo-root skills dirs were entirely outside their blind spot,
// which is exactly how the four social skills shipped unnoticed. This gate walks the whole repo's
// skills trees instead (three levels up from this file: packages/lucarne-corpus-mcp/test ->
// packages/lucarne-corpus-mcp -> packages -> repo root), independent of which package or agent
// runner (claude vs codex) the violation would land under.
//
// Wired into CI: this file is invoked from THIS package's `test:unit` script (package.json), and
// the repo root's `npm run test:unit` runs `--workspaces`, which `.github/workflows/ci.yml`'s
// `build` job already runs on every push/PR (`- run: npm run test:unit`). No new CI step needed —
// this package's existing CI-run test lane now also covers the repo-root skills trees.
//
// NON-VACUOUS: before scanning the real tree, this gate proves its own detector actually detects —
// it plants each banned term (one at a time, incl. linkedin/youtube) into a throwaway fixture
// directory, asserts the scan catches it; it also plants a social skill under a `.codex/skills`-
// style path and asserts the multi-root walk catches it there too. Then it deletes the fixtures.
// A gate that only ever reports "0 hits" is indistinguishable from a gate that never runs its
// regexes (or never actually walks a second root) at all; the self-test rules that out.
//
// MAINTAINER NOTE: this gate enumerates both the skills roots it walks (SKILLS_ROOTS) and the
// domain vocabulary it bans (BANNED) by hand. When a new channel/domain ships (see
// `channels/<domain>/` in the cadence consumer repo) or a new skills root/agent-runner is added,
// extend both lists here — the gate does not infer either from the product's channel list.
//
// Run with `node test/no-domain-skills-gate.mjs` (no build required — this only greps file text).
import { readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/lucarne-corpus-mcp/test -> packages/lucarne-corpus-mcp -> packages -> repo root
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
// Both live skills roots, confirmed via `git ls-tree -r --name-only <branch> | grep -iE
// '(\.codex|\.claude)/skills'` — no other `<dir>/skills/` root exists in the repo tree today.
// A root that doesn't exist (e.g. a repo checkout with just one agent runner) is skipped, not an
// error — see scanRoots() below.
const SKILLS_ROOTS = [join(REPO_ROOT, ".claude", "skills"), join(REPO_ROOT, ".codex", "skills")];

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// The exact social/domain vocabulary named in the brief. Word-boundaried where the term could
// otherwise collide with innocuous English prose (none of these are common English words, so a
// plain case-insensitive substring match is safe and deliberately broad — catching e.g. "Reddit"
// mid-sentence or "X.com" in a URL is exactly the point).
const BANNED = [
  { name: "x.com", re: /x\.com/i },
  { name: "twitter", re: /twitter/i },
  { name: "tweet", re: /tweet/i },
  { name: "reddit", re: /reddit/i },
  { name: "subreddit", re: /subreddit/i },
  { name: "hackernews", re: /hackernews|hacker news/i },
  { name: "ycombinator", re: /y[- ]?combinator/i },
  { name: "karma", re: /\bkarma\b/i },
  { name: "upvote", re: /upvote/i },
  { name: "downvote", re: /downvote/i },
  { name: "retweet", re: /retweet/i },
  // LS-48: linkedin + youtube are LIVE domains of this product (cadence ships
  // `channels/linkedin/`) — a skill built around either would previously have passed clean.
  { name: "linkedin", re: /linkedin/i },
  { name: "youtube", re: /youtube/i },
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** Scan every file under `dir`; return offender strings `path:line: term: text`. */
function scan(dir) {
  const offenders = [];
  for (const file of walk(dir)) {
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const { name, re } of BANNED) {
        if (re.test(lines[i])) {
          offenders.push(`${file}:${i + 1}: [${name}] ${lines[i].trim()}`);
        }
      }
    }
  }
  return offenders;
}

/**
 * Scan every root in `dirs` that actually exists on disk; roots that don't exist are skipped
 * without error (e.g. a checkout with only one agent runner's skills dir). Returns the combined
 * offender list plus which roots were actually walked, so the real-gate check below can report
 * both.
 */
function scanRoots(dirs) {
  const existingRoots = dirs.filter((d) => statSync(d, { throwIfNoEntry: false })?.isDirectory());
  const offenders = existingRoots.flatMap((d) => scan(d));
  return { existingRoots, offenders };
}

// ---------------------------------------------------------------------------
// Non-vacuity self-test: plant each banned term in isolation, prove `scan()` catches it, then
// clean up. This runs BEFORE the real scan so a broken detector fails loudly here, not as a
// silent false-negative "0 hits" against the real tree below.
// ---------------------------------------------------------------------------
// Each term gets its OWN isolated fixture dir (not one shared dir) — several banned terms are
// legitimately substrings of another banned term's fixture prose (e.g. "subreddit" contains
// "reddit", "retweet" contains "tweet"), which would make a shared-file count assertion brittle
// for the wrong reason. Isolating per-term proves each individual regex independently fires.
const missedTerms = [];
for (const { name } of BANNED) {
  const dir = mkdtempSync(join(tmpdir(), `no-domain-skills-gate-selftest-${name.replace(/[^a-z0-9]/gi, "_")}-`));
  writeFileSync(join(dir, "planted.md"), `Sentence mentioning ${name} in prose, planted for the self-test.\n`);
  const hits = scan(dir).filter((h) => h.startsWith(`${join(dir, "planted.md")}:`) && h.includes(`[${name}]`));
  if (hits.length === 0) missedTerms.push(name);
  rmSync(dir, { recursive: true, force: true });
}
check(
  `non-vacuity: each of the ${BANNED.length} banned terms is independently caught when planted in isolation`,
  missedTerms.length === 0,
  missedTerms.length ? `NOT caught: ${missedTerms.join(", ")}` : "",
);

// And the converse, in its own isolated fixture: an innocuous file with none of the terms scans
// clean, so the detector isn't just matching every file unconditionally.
const cleanFixtureRoot = mkdtempSync(join(tmpdir(), "no-domain-skills-gate-selftest-clean-"));
writeFileSync(join(cleanFixtureRoot, "clean.md"), "A perfectly generic sentence about developing software.\n");
const cleanHits = scan(cleanFixtureRoot);
check("non-vacuity: an innocuous fixture file produces zero hits (detector isn't matching everything)", cleanHits.length === 0, cleanHits.join("\n    "));
rmSync(cleanFixtureRoot, { recursive: true, force: true });

// LS-48: prove the MULTI-ROOT walk itself actually visits a second root, not just that scan()
// works on a single directory. Build a throwaway fixture that mimics the real repo shape — a
// parent dir containing a `.codex/skills/<skill>/SKILL.md` — and confirm scanRoots() (the same
// function the real gate below calls) reports the planted skill as an existing root AND surfaces
// its banned-term hit. A gate whose SKILLS_ROOTS array merely *lists* `.codex/skills` without
// scanRoots() actually walking it would pass this repo's currently-clean tree by accident; this
// self-test would catch that regression because the fixture's planted term is not clean.
const multiRootFixtureParent = mkdtempSync(join(tmpdir(), "no-domain-skills-gate-selftest-multiroot-"));
const codexSkillDir = join(multiRootFixtureParent, ".codex", "skills", "linkedin-outreach");
mkdirSync(codexSkillDir, { recursive: true });
writeFileSync(
  join(codexSkillDir, "SKILL.md"),
  "A codex-only skill for posting to linkedin and youtube, planted for the self-test.\n",
);
const otherRootFixture = join(multiRootFixtureParent, ".claude", "skills");
mkdirSync(otherRootFixture, { recursive: true }); // exists but empty — proves multi-root isn't just "scan whichever root has hits"
const multiRootResult = scanRoots([otherRootFixture, join(multiRootFixtureParent, ".codex", "skills")]);
const multiRootCaughtCodexRoot = multiRootResult.existingRoots.some((r) => r === join(multiRootFixtureParent, ".codex", "skills"));
const multiRootCaughtLinkedin = multiRootResult.offenders.some((h) => h.includes("[linkedin]"));
const multiRootCaughtYoutube = multiRootResult.offenders.some((h) => h.includes("[youtube]"));
check(
  "non-vacuity: multi-root walk finds a .codex/skills-style root and catches a planted social skill's linkedin+youtube terms there",
  multiRootCaughtCodexRoot && multiRootCaughtLinkedin && multiRootCaughtYoutube,
  `codexRootWalked=${multiRootCaughtCodexRoot} linkedinCaught=${multiRootCaughtLinkedin} youtubeCaught=${multiRootCaughtYoutube}`,
);
rmSync(multiRootFixtureParent, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// The real gate: every skills root that exists in this repo checkout must be zero-hit.
// ---------------------------------------------------------------------------
const { existingRoots, offenders } = scanRoots(SKILLS_ROOTS);
check(
  `at least one skills root exists (found ${existingRoots.length}/${SKILLS_ROOTS.length}: ${existingRoots.map((r) => r.replace(REPO_ROOT + "/", "")).join(", ") || "none"})`,
  existingRoots.length > 0,
);

const skillFiles = existingRoots.flatMap((d) => walk(d));
check(`scanned at least one file across the skills roots (found ${skillFiles.length})`, skillFiles.length > 0);

check(
  `grep-clean: zero social/domain-vocab hits (x.com|twitter|tweet|reddit|subreddit|hackernews|ycombinator|karma|upvote|downvote|retweet|linkedin|youtube) across ALL scanned skills roots (${existingRoots.length} root(s))`,
  offenders.length === 0,
  offenders.length ? `${offenders.length} hit(s):\n    ${offenders.slice(0, 20).join("\n    ")}` : "",
);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

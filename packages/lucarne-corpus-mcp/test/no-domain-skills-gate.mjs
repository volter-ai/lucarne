// LS-46 (panel-fix-skills) — .claude/skills domain-neutrality gate.
//
// lucarne is the DOMAIN-AGNOSTIC platform repo (packages/* ship a generic corpus-read primitive
// and generic dev/code-host skills — develop/draft/pm/reviewer). The four x/reddit/HN OPERATOR
// skills (socials-toolkit, review-profile, research-topic, recommend-replies) were shipped into
// this repo's `.claude/skills/` by the earlier split merge — a domain-specific consumer concern
// that belongs in `cadence` (the social consumer repo), not in the platform. They've been removed
// (this commit); this gate is the enforcement so they — or any other social/domain vocabulary —
// can never land back in `.claude/skills/` silently again.
//
// Existing package-clean gates (e.g. this package's own test/package-clean-gate.mjs) only scan a
// single package's `src/` — `.claude/skills/` at the REPO ROOT was entirely outside their blind
// spot, which is exactly how the four social skills shipped unnoticed. This gate walks the whole
// repo's `.claude/skills/` tree instead (three levels up from this file: packages/lucarne-corpus-mcp/test
// -> packages/lucarne-corpus-mcp -> packages -> repo root), independent of which package the
// violation would land under.
//
// Wired into CI: this file is invoked from THIS package's `test:unit` script (package.json), and
// the repo root's `npm run test:unit` runs `--workspaces`, which `.github/workflows/ci.yml`'s
// `build` job already runs on every push/PR (`- run: npm run test:unit`). No new CI step needed —
// this package's existing CI-run test lane now also covers the repo-root `.claude/skills/` tree.
//
// NON-VACUOUS: before scanning the real tree, this gate proves its own detector actually detects —
// it plants each banned term (one at a time) into a throwaway fixture directory, asserts the scan
// catches it, then deletes the fixture. A gate that only ever reports "0 hits" is indistinguishable
// from a gate that never runs its regexes at all; the self-test rules that out.
//
// Run with `node test/no-domain-skills-gate.mjs` (no build required — this only greps file text).
import { readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/lucarne-corpus-mcp/test -> packages/lucarne-corpus-mcp -> packages -> repo root
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const SKILLS_DIR = join(REPO_ROOT, ".claude", "skills");

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

// ---------------------------------------------------------------------------
// The real gate: the whole repo's `.claude/skills/` tree must be zero-hit.
// ---------------------------------------------------------------------------
check(`${SKILLS_DIR} exists`, statSync(SKILLS_DIR, { throwIfNoEntry: false })?.isDirectory() ?? false);

const skillFiles = walk(SKILLS_DIR);
check(`scanned at least one file under .claude/skills/ (found ${skillFiles.length})`, skillFiles.length > 0);

const offenders = scan(SKILLS_DIR);
check(
  `grep-clean: zero social/domain-vocab hits (x.com|twitter|tweet|reddit|subreddit|hackernews|ycombinator|karma|upvote|downvote|retweet) across the WHOLE repo's .claude/skills/`,
  offenders.length === 0,
  offenders.length ? `${offenders.length} hit(s):\n    ${offenders.slice(0, 20).join("\n    ")}` : "",
);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

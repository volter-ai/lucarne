// LS-24c — package cleanliness gate, committed as a re-runnable proof (not just a one-off
// shell command): the WHOLE package's `src` must carry zero references to `cadence`/`__cadence`/
// `.social` — this package is a general records/provenance primitive (§0 of the split spec:
// "nothing general may remain locked in cadence … enforced by grep gates, not intentions"). Citation comments
// ported from the origin app ("ported from the origin app's `recall.ts:159-194`", etc.) are fine —
// they just may never spell out that app's actual name, since a downstream consumer (or cadence
// itself, post-split) must be able to depend on this package without it reading like a fork of a
// still-named product.
//
// LS-29 (generalize-records): EXTENDED with a second class of bans — this package is now
// domain-AGNOSTIC (a general capture-corpus store), so the SOCIAL domain must be equally absent from
// its `src`: no reddit/hackernews/tweet/subreddit/karma vocabulary baked in (that schema + those
// parsers moved to `cadence/src/records/`). Doc comments that need to NAME a domain as an EXAMPLE
// (e.g. "a source string like 'x'/'reddit'/'hackernews'") are reworded to avoid the literal banned
// tokens (e.g. "a code-forge/social/papers source") — same posture as the cadence-token ban above:
// the general engine can talk ABOUT domains in the abstract, never bake one in by name.
//
// Run with `node test/package-clean-gate.mjs` (no build required — this only greps source text).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(__dirname, "..", "src");

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// CASE-INSENSITIVE on the cadence tokens so a capitalized residual ("Cadence", "CADENCE-…") is
// caught too, not just lowercase `cadence`. `.social` stays case-sensitive (it's a literal path
// fragment, never capitalized). The LS-29 domain tokens are case-insensitive too, for the same
// reason (a capitalized "Reddit"/"HackerNews" residual is just as much a regression as lowercase).
const BANNED = [
  /cadence/i,
  /__cadence/i,
  /\.social/,
  /reddit/i,
  /hackernews/i,
  /ycombinator/i,
  /tweet/i,
  /subreddit/i,
  /karma/i,
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

const files = walk(SRC_DIR);
check(`scanned at least one source file under src/ (found ${files.length})`, files.length > 0);

const offenders = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const pattern of BANNED) {
      if (pattern.test(lines[i])) {
        offenders.push(`${file}:${i + 1}: ${lines[i].trim()}`);
      }
    }
  }
}

check(
  "grep-clean: zero cadence/social-app tokens AND zero social-domain tokens (reddit/hackernews/ycombinator/tweet/subreddit/karma) across the WHOLE package src",
  offenders.length === 0,
  offenders.length ? `${offenders.length} hit(s):\n    ${offenders.slice(0, 10).join("\n    ")}` : "",
);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

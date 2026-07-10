// LS-24c — package cleanliness gate, committed as a re-runnable proof (not just a one-off
// shell command): the WHOLE package's `src` must carry zero references to `cadence`/`__cadence`/
// `.social` — this package is a general MCP-surface primitive (§0 of the split spec:
// "nothing general may remain locked in cadence … enforced by grep gates, not intentions"). Citation comments
// ported from the origin app ("ported from the origin app's `recall.ts:159-194`", etc.) are fine —
// they just may never spell out that app's actual name, since a downstream consumer (or cadence
// itself, post-split) must be able to depend on this package without it reading like a fork of a
// still-named product.
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
// fragment, never capitalized).
//
// LS-34 (corpus-mcp-open): the get_timeline `kind`/`sort` args used to be CLOSED `z.enum([...])`s
// carrying social-domain literals (Reddit's 'hot'/'controversial', HN's 'ask'/'show') — a
// source-agnostic corpus reader hardcoding two specific sites' own vocabulary at its tool boundary.
// Those enums are now open strings; these word-boundary patterns assert the platform-tied literals
// left `src/` ENTIRELY (not even as illustrative `.describe()` example text — the describe text was
// rewritten to name only source-agnostic conventions: 'user_posts'/'new'/'top'/'best'/'relevance',
// none of which name a specific platform). `\b` boundaries so this doesn't false-positive on common
// English words used honestly in prose (e.g. "show a hint", "ask the agent") — DUE TO the boundaries,
// those innocuous uses would still trip this gate if reintroduced as bare words, which is intentional:
// it forces any future 'ask'/'show'/'hot' usage to be phrased around, not through, the gate.
const BANNED = [
  /cadence/i,
  /__cadence/i,
  /\.social/,
  /\breddit\b/i,
  /\bhackernews\b/i,
  /\by[- ]?combinator\b/i,
  /\bcontroversial\b/i,
  /\bhot\b/i,
  /\bask\b/i,
  /\bshow\b/i,
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
  "grep-clean: zero cadence-naming hits AND zero social-platform-tied literals (reddit/hackernews/ycombinator/controversial/hot/ask/show) across the WHOLE package src",
  offenders.length === 0,
  offenders.length ? `${offenders.length} hit(s):\n    ${offenders.slice(0, 10).join("\n    ")}` : "",
);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

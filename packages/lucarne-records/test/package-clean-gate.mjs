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
// LS-33 (store-generalize): a THIRD, narrower class of gate — this one checks LOGIC, not vocabulary.
// `store.ts`'s merge used to special-case the literal `kind === "profile"` (routing richest-text into
// `bio` instead of the general `text` field for one hardcoded kind); `query.ts` carried the same
// residue (`findRecord`'s handle lookup, `search`'s `type:"users"` filter). Both are now kind-agnostic
// (see each file's own LS-33 header note) — but their DOC COMMENTS still legitimately mention the word
// "profile" and even the string `kind==="profile"` as prose describing what was REMOVED and why (the
// same "citation comments are fine" posture as the cadence-token gate above). So this check strips
// comments (`/* … */` and `// …`) before scanning for the CODE pattern `kind === "profile"` (any
// quote style, any spacing) — it proves the special case is gone from LOGIC, without banning the
// English word "profile" from documentation the way the vocabulary gate above bans domain tokens
// outright.
//
// LS-39 (gate-uniformity): the FOURTH check below (bare social-kind FILTER literal ban, formerly
// LS-37) is now scanned across the WHOLE package `src`, not just `query.ts` — bringing this package's
// gate scope in line with `lucarne-interact` and `lucarne-corpus-mcp`, which already enforce the same
// class whole-`src` (see each package's own LS-38 gate note). See that check's own comment below for
// the full rationale.
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

// LS-33: strip comments, then grep for the CODE pattern `kind === "profile"` (any quote/spacing) in
// store.ts (must be ZERO — the merge special case is fully gone) and query.ts (ideally zero too — see
// this file's header). Doc-comment mentions of the word "profile" are legitimate and excluded.
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const KIND_PROFILE_LITERAL = /kind\s*(===|==)\s*["']profile["']/;

function grepKindProfile(relPath) {
  const file = join(SRC_DIR, relPath);
  const code = stripComments(readFileSync(file, "utf8"));
  const hits = [];
  code.split("\n").forEach((line, i) => {
    if (KIND_PROFILE_LITERAL.test(line)) hits.push(`${relPath}:${i + 1}: ${line.trim()}`);
  });
  return hits;
}

const storeHits = grepKindProfile("store.ts");
check(
  'grep-clean (LS-33): store.ts CODE (comments stripped) carries ZERO `kind === "profile"` special-casing',
  storeHits.length === 0,
  storeHits.length ? storeHits.join("\n    ") : "",
);

const queryHits = grepKindProfile("query.ts");
check(
  'grep-clean (LS-33): query.ts CODE (comments stripped) carries ZERO `kind === "profile"` special-casing',
  queryHits.length === 0,
  queryHits.length ? queryHits.join("\n    ") : "",
);

// LS-37 (read-kinds generalize) / LS-39 (gate-uniformity): a FOURTH, broader class of gate — this
// package's `src` must carry zero bare social-kind FILTER literals (`e.kind === "comment"`,
// `e.kind !== "post"`, a hardcoded `kind:"post"` ref used as a filter/lookup arg, …) that would
// silently require/assume the social taxonomy on the READ side even though `kind` is an open string
// everywhere else in this package (a schema-blessed non-social record, e.g. `kind:"issue"`, could be
// APPENDED but then get zero query results if any op secretly gated on one of the three social names).
// `query.ts` used to carry exactly this residue (fixed under LS-37 — see that file's own header note);
// every list op is now kind-PARAMETERIZED instead (an optional/required `kind` on the QUERY object,
// never a literal comparison against one of the three social kind names inside the op's own logic).
//
// LS-39 (gate-uniformity): originally this check only scanned `query.ts` (the one file LS-37 touched),
// while the SAME class of gate is enforced whole-`src` in this package's sibling consumers
// (`lucarne-interact`'s `package-clean-gate.mjs`, LS-38; `lucarne-corpus-mcp`'s, also LS-38) — an
// inconsistent scope that would let a future file in THIS package (`store.ts`, `cursor.ts`,
// `validate.ts`, a new file, …) reintroduce a bare social-kind filter literal unnoticed, since only
// `query.ts` was being watched. Widened to scan the WHOLE package `src` (every file `walk(SRC_DIR)`
// already found above), matching the sibling packages' posture exactly. Comments/JSDoc are stripped
// first (same posture as the LS-33 check above and the sibling packages' LS-38 checks — a doc comment
// is allowed to NAME "post"/"comment"/"profile" as a recognized-convention EXAMPLE; only a CODE-level
// filter comparison trips this) and scans for the patterns a hardcoded kind-gate would take:
// `kind === "post"/"comment"/"profile"`, `kind !== "post"`, and a `kind: "post"/"comment"/"profile"`
// object-literal property used as a filter/lookup arg (the old comments-op root
// `findRecord({..., kind:"post", ...})` shape). This is deliberately NOT the same shape as a
// legitimate record-CONSTRUCTION default like `kind: args.kind ?? "post"` — no literal directly
// follows `kind:` there (an identifier/expression sits between the colon and the fallback literal), so
// the regex (which requires `kind:` to be followed, modulo whitespace, directly by the quoted literal)
// never matches it — see `lucarne-corpus-mcp`'s identical note for the same non-match shape.
const SOCIAL_KIND_FILTER_LITERAL =
  /\bkind\s*(===|==|!==|!=)\s*["'](post|comment|profile)["']|\bkind\s*:\s*["'](post|comment|profile)["']/;

const socialKindOffenders = [];
for (const file of files) {
  const code = stripComments(readFileSync(file, "utf8"));
  code.split("\n").forEach((line, i) => {
    if (SOCIAL_KIND_FILTER_LITERAL.test(line)) socialKindOffenders.push(`${file}:${i + 1}: ${line.trim()}`);
  });
}

check(
  'grep-clean (LS-37/LS-39): zero bare social-kind FILTER literals (kind === / !== / : "post"|"comment"|"profile") ' +
    "across the WHOLE package src (comments stripped) — the general read ops are kind-parameterized, not kind-hardcoded, " +
    "and no future file in this package can silently reintroduce the pattern unnoticed",
  socialKindOffenders.length === 0,
  socialKindOffenders.length ? socialKindOffenders.join("\n    ") : "",
);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

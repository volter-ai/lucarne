// LS-14 dev/03 — package cleanliness gate, committed as a re-runnable proof (not just a one-off
// shell command): the WHOLE package's `src` must carry zero references to `cadence`/`__cadence`/
// `.social` — this package is a general engine primitive (§0 of the split spec: "nothing general
// may remain locked in cadence … enforced by grep gates, not intentions"). Citation comments
// ported from the origin app ("ported from the origin app's `recall.ts:159-194`", etc.) are fine —
// they just may never spell out that app's actual name, since a downstream consumer (or cadence
// itself, post-split) must be able to depend on this package without it reading like a fork of a
// still-named product.
//
// LS-38 (kind-agnostic tail): EXTENDED with a second class of gate — this package's `src` must ALSO
// carry zero bare social-kind FILTER literals (`kind === "post"`, `kind !== "post"`, etc. — the same
// class `lucarne-records`' own package-clean-gate bans in `query.ts`, see that file's LS-37 note).
// `recall/lock.ts`'s `reconcileMedia` used to carry exactly this residue (`if (r.kind !== "post")
// continue;`), silently repairing crops for social `kind:"post"` records only even though the crop
// pipeline it walks (`capture.ts`/`dom-probes.ts`/`media-crop.ts`) is fully kind-agnostic — fixed
// alongside this gate extension. Scans the WHOLE package `src` (every file, not just `lock.ts`) so no
// future file can silently reintroduce the pattern unnoticed. Comments/JSDoc/`.describe()` prose are
// stripped first (same posture as the records-package gate) — only a CODE-level filter comparison
// trips this; a record-CONSTRUCTION site legitimately setting `kind: "post"` as a literal value it
// PRODUCES (not filters by) is a different shape (`kind:` inside an object being built, immediately
// followed by other sibling fields on the SAME literal, not a standalone comparison/filter arg) and
// this package has none of those in `src` today.
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
const BANNED = [/cadence/i, /__cadence/i, /\.social/];

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

check("grep-clean: zero 'cadence' | '__cadence' | '.social' hits across the WHOLE package src", offenders.length === 0, offenders.length ? `${offenders.length} hit(s):\n    ${offenders.slice(0, 10).join("\n    ")}` : "");

// LS-38: bare social-kind FILTER literal ban, whole-package `src`. Strip comments first — a doc
// comment or `.describe()` string is allowed to NAME "post"/"comment"/"profile" as a recognized
// convention EXAMPLE; only a CODE-level filter comparison (`kind === "post"`, `kind !== "post"`, or a
// `kind: "post"` object-literal property used as a query/filter arg) is banned.
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const SOCIAL_KIND_FILTER_LITERAL =
  /\bkind\s*(===|==|!==|!=)\s*["'](post|comment|profile)["']|\bkind\s*:\s*["'](post|comment|profile)["']/;

const kindFilterOffenders = [];
for (const file of files) {
  const code = stripComments(readFileSync(file, "utf8"));
  code.split("\n").forEach((line, i) => {
    if (SOCIAL_KIND_FILTER_LITERAL.test(line)) kindFilterOffenders.push(`${file}:${i + 1}: ${line.trim()}`);
  });
}

check(
  'grep-clean (LS-38): zero bare social-kind FILTER literals (kind === / !== / : "post"|"comment"|"profile") ' +
    "across the WHOLE package src (comments stripped) — the crop-reconcile/read paths are kind-agnostic, not kind-hardcoded",
  kindFilterOffenders.length === 0,
  kindFilterOffenders.length ? kindFilterOffenders.join("\n    ") : "",
);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

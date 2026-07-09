// LS-17 dev/01 — the committed, re-runnable "namespacing commit" gate. The task spec's intent (§2 LS-17) was a
// one-commit sweep renaming every `__cadence*` page global / host element id / envelope key to the `ns`-derived
// form (`__lw_<ns>_*`) this package (LS-15/LS-16) was already written with FROM DAY ONE — see `src/ns.ts`'s own
// header. This gate is what LOCKS THAT IN: it is the literal AC from the spec —
//
//   `grep -rn "__cadence" packages/lucarne-widget` → 0 hits
//
// — made case-insensitive (per the AC's "case-insensitive `__cadence` too") and committed as a re-runnable script
// rather than a one-off shell command, so a future change can't silently reintroduce the literal. Distinct from
// `fixture-neutrality-gate.mjs` (LS-16 dev/02, which greps the broader `cadence|candidate|.social` family for
// app-specific *content*): this gate is scoped to the exact `__cadence` PAGE-GLOBAL PREFIX literal LS-17 names,
// so it stays meaningful even if the broader neutrality gate's pattern ever changes.
//
// This file's own filename deliberately avoids spelling the literal it hunts for (unlike the literal itself,
// which necessarily appears below in the regex/detail strings — the same self-referential situation
// `fixture-neutrality-gate.mjs` solves for itself via its own `SELF` exclusion): this gate is listed in that
// gate's `EXEMPT_BASENAMES` for the identical reason.
//
// Run with `node test/no-legacy-global-literal-gate.mjs` (no build required — this only greps source text).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(__dirname, "..");

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const EXCLUDE_DIRS = new Set(["node_modules", "dist", ".git"]);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (EXCLUDE_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const SELF = fileURLToPath(import.meta.url);
// Every text-ish file in the package — mirrors `grep -rn` scanning the whole tree (dist/node_modules excluded,
// same as the underlying grep AC would exclude build output/deps by convention).
const files = walk(PKG_DIR).filter((f) => f !== SELF);
check(`scanned at least one file across packages/lucarne-widget (found ${files.length})`, files.length > 0);

// mirrors `grep -rni "__cadence" packages/lucarne-widget` — case-insensitive per the AC's explicit widening.
const PATTERN = /__cadence/i;
const offenders = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // a binary/unreadable file (none expected in this package) — nothing to grep
  }
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (PATTERN.test(lines[i])) offenders.push(`${relative(PKG_DIR, file)}:${i + 1}: ${lines[i].trim()}`);
  }
}
check(
  `grep -rn "__cadence" packages/lucarne-widget (case-insensitive) → 0 hits`,
  offenders.length === 0,
  offenders.length ? `${offenders.length} hit(s):\n    ${offenders.slice(0, 20).join("\n    ")}` : "",
);

// The flip side: prove the ns-derived replacement actually EXISTS somewhere (a package that just never minted
// any page globals would trivially pass the grep above too) — `nsPrefix`/`hostElementId` etc. from `src/ns.ts`
// are the `__lw_<ns>_*` form the spec calls for.
const nsSource = readFileSync(resolve(PKG_DIR, "src/ns.ts"), "utf8");
check(
  "the ns-derived replacement family (`__lw_<ns>_*`, src/ns.ts's `nsPrefix`) exists in its place",
  /__lw_\$\{assertNs\(ns\)\}/.test(nsSource) || /`__lw_\$\{/.test(nsSource),
  "src/ns.ts:nsPrefix",
);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

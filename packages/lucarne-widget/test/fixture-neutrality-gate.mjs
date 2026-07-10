// LS-16 dev/02 — the fixture-neutrality gate, committed as a re-runnable proof (mirrors
// `framework-free-gate.mjs`'s style): case-insensitive `grep` for app-specific naming
// ("cadence"/"Cadence"/"CADENCE", "candidate", ".social") across the WHOLE package (`src/`, `test/`,
// `README.md`) must be 0 hits outside a CHANGELOG/migration doc (this package ships neither, so in practice
// that carve-out is currently unused). The selftest's own neutral fixture (`test/fixtures/widget-selftest-entry.ts`
// — LS-16's replacement for the cadence-candidate `TESTDATA` the original selftest used) is what this
// primarily protects, but the gate is package-wide so a stray provenance comment can't silently reintroduce
// app-specific naming either.
//
// Run with `node test/fixture-neutrality-gate.mjs` (no build required — this only greps source text).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(__dirname, "..");

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const EXCLUDE_DIRS = new Set(["node_modules", "dist", ".git"]);
// Files this gate deliberately does not scan: a real CHANGELOG/migration doc is explicitly exempt per the
// AC ("0 hits outside CHANGELOG/migration docs") — this package ships neither today, but the exemption is
// wired in so adding one later doesn't require touching this gate. `no-legacy-global-literal-gate.mjs` (LS-17
// dev/01) is also exempt for the SAME reason this file excludes itself below (`SELF`): its entire job is to
// assert a zero count of a specific legacy literal elsewhere in the package, which means its own source
// necessarily spells that literal (in a regex/comment) — that is the gate doing its job, not a regression.
// `package-clean-gate.mjs` (LS-24c) is exempt for the identical reason: it is the src/-scoped sibling of THIS
// gate (same law, narrower scope — src/ only, no test/ or README.md), and its own source necessarily spells
// "cadence"/`.social` in its banned-pattern list and comments describing what it bans.
const EXEMPT_BASENAMES = new Set(["CHANGELOG.md", "no-legacy-global-literal-gate.mjs", "package-clean-gate.mjs"]);
const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".md", ".json"]);

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
const files = walk(PKG_DIR).filter((f) => {
  if (f === SELF) return false; // this file necessarily SPELLS the pattern it greps for — see PATTERN below
  const base = f.split("/").pop();
  if (EXEMPT_BASENAMES.has(base)) return false;
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot) : "";
  return SCAN_EXTENSIONS.has(ext);
});
check(`scanned at least one file (found ${files.length})`, files.length > 0);

// mirrors `grep -REn "cadence|candidate|\.social" packages/lucarne-widget`, case-insensitive
const PATTERN = /cadence|candidate|\.social/i;
const offenders = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (PATTERN.test(lines[i])) offenders.push(`${relative(PKG_DIR, file)}:${i + 1}: ${lines[i].trim()}`);
  }
}
check(
  "grep-clean: zero case-insensitive 'cadence' / 'candidate' / '.social' hits across the package (outside CHANGELOG/migration docs)",
  offenders.length === 0,
  offenders.length ? `${offenders.length} hit(s):\n    ${offenders.slice(0, 20).join("\n    ")}` : "",
);

// The flip side of the same AC: the selftest's own neutral fixture must actually EXIST (a package that simply
// never shipped one would trivially pass the grep above too).
const fixtureEntry = resolve(PKG_DIR, "test/fixtures/widget-selftest-entry.ts");
check("the LS-16 neutral selftest fixture entry exists", (() => {
  try {
    readFileSync(fixtureEntry, "utf8");
    return true;
  } catch {
    return false;
  }
})(), fixtureEntry);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

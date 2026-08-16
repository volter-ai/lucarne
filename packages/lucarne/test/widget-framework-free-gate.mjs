// LS-15 dev/03 — the framework-free-core gate, committed as a re-runnable proof (not just a one-off shell
// command): `grep -rn "preact" packages/lucarne/src/widget --include=*.ts --exclude-dir=preact` must be 0 hits.
// The runtime CORE is plain DOM + a tiny emitter (`src/emitter.ts`) — `src/preact/index.ts` is the ONLY file
// allowed to import `preact`, so a consumer who wants a framework-free panel never pulls it in transitively.
//
// Run with `node test/framework-free-gate.mjs` (no build required — this only greps source text).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(__dirname, "..", "src", "widget");

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

function walk(dir, excludeDirNames) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (excludeDirNames.has(entry)) continue;
      out.push(...walk(p, excludeDirNames));
    } else {
      out.push(p);
    }
  }
  return out;
}

// mirrors `grep -rn "preact" src --include=*.ts --exclude-dir=preact`
const files = walk(SRC_DIR, new Set(["preact"])).filter((f) => f.endsWith(".ts"));
check(`scanned at least one .ts source file outside preact/ (found ${files.length})`, files.length > 0);

const offenders = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("preact")) offenders.push(`${relative(SRC_DIR, file)}:${i + 1}: ${lines[i].trim()}`);
  }
}
check("grep-clean: zero 'preact' hits under src/ (excluding src/preact/)", offenders.length === 0, offenders.length ? `${offenders.length} hit(s):\n    ${offenders.slice(0, 10).join("\n    ")}` : "");

// The flip side of the same AC: `preact` must be imported SOMEWHERE — the adapter subpath — else the gate above
// would trivially pass on a package that simply never shipped a Preact adapter at all.
const preactDir = resolve(SRC_DIR, "preact");
const preactFiles = walk(preactDir, new Set());
const preactImportSites = preactFiles.filter((f) => /from\s+["']preact/.test(readFileSync(f, "utf8")));
check("src/preact/ is the (only) site that actually imports 'preact'", preactImportSites.length > 0, `${preactImportSites.length} file(s) import preact under src/preact/`);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

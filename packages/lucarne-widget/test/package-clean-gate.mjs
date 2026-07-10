// LS-24c — package cleanliness gate, committed as a re-runnable proof (not just a one-off
// shell command): the WHOLE package's `src` must carry zero references to `cadence`/`__cadence`/
// `.social` — this package is a general in-page widget primitive (§0 of the split spec:
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

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

// LS-12 dev/02 — the presence contract is package-INTERNAL: `presence.ts` must NOT be part of the
// package's public export map (index.ts / dist/index.js), even though it IS a real module the
// verbs (session.ts) import directly — a single shared module, not a duplicated/forked one.
//
// NOTE (per the task spec): at LS-12 time only the VERBS are proven to import presence.ts. Recall
// (LS-13) doesn't exist yet in this package — its import is validated when LS-13 lands, not faked
// here.
//
// Run with `node test/presence-export-map.mjs` (after `npm run build`; also greps src/, no build
// needed for that half).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(PKG_ROOT, "src");

function grep(pattern, dir = SRC) {
  try {
    const out = execFileSync("grep", ["-REn", pattern, dir], { encoding: "utf8" });
    return out.split("\n").filter(Boolean);
  } catch (e) {
    if (e.status === 1) return []; // grep: no matches
    throw e;
  }
}

// ── 1. The package root's RUNTIME export map has none of presence.ts's internals on it ──
const mod = await import("../dist/index.js");
const PRESENCE_INTERNALS = ["PresenceTracker", "attributeActor", "presenceTieBreakBonus", "DEFAULT_ATTRIBUTION_STALE_MS"];
for (const name of PRESENCE_INTERNALS) {
  check(`package root export map does NOT have '${name}' (presence internal)`, !(name in mod), Object.keys(mod).join(","));
}
// `checkHumanYield`/`ActivityProbe` etc. ARE public (unchanged LS-10 surface) — presence.ts merely
// implements them now; that's not a leak of the internal module, just its human-presence half's
// existing public name.
check("package root STILL exports checkHumanYield (LS-10's public surface, unbroken by the refactor)", typeof mod.checkHumanYield === "function");

// ── 2. index.ts itself has no import/export STATEMENT naming presence.ts/.js — it only re-exports
//    from yield.ts (the thin public shim), session.ts, etc. — so the internal module can't leak
//    transitively. (A prose *mention* of "presence.ts" in a doc comment, e.g. index.ts's own header
//    explaining the architecture, is not a leak — only an actual module specifier would be.) ──
const indexSrc = readFileSync(path.join(SRC, "index.ts"), "utf8");
const MODULE_SPECIFIER = /from\s*["']\.\/presence(?:\.js)?["']/;
check("src/index.ts has no import/export FROM presence.ts/.js", !MODULE_SPECIFIER.test(indexSrc), indexSrc.match(MODULE_SPECIFIER)?.[0]);

// The compiled root barrel is equally clean (belt-and-suspenders on the actual shipped artifact) —
// tsc preserves doc comments verbatim, so this checks for a real import specifier, not prose.
const distIndexSrc = readFileSync(path.join(PKG_ROOT, "dist", "index.js"), "utf8");
check("dist/index.js (compiled) has no import FROM presence.js", !/from\s*["']\.\/presence\.js["']/.test(distIndexSrc));

// ── 3. The verbs (session.ts) DO import presence.ts directly — a single shared module, not a fork. ──
const sessionPresenceImports = grep('from "\\./presence\\.js"', path.join(SRC, "session.ts"));
check("session.ts imports presence.ts directly (the verbs' single shared module)", sessionPresenceImports.length >= 1, sessionPresenceImports.join(" | "));

// Exactly one presence.ts source file exists in the package (no duplicated/forked copy).
const presenceFiles = execFileSync("find", [SRC, "-name", "presence.ts"], { encoding: "utf8" }).split("\n").filter(Boolean);
check("exactly one presence.ts file exists under src/", presenceFiles.length === 1, presenceFiles.join(","));

// yield.ts (LS-10's public surface) and type-loop.ts (the drive loop) both consume the SAME
// presence.ts — proving it's one shared module behind more than one internal consumer, not a
// side-channel duplicate.
check("yield.ts re-exports from the same presence.ts (thin public shim)", grep('from "\\./presence\\.js"', path.join(SRC, "yield.ts")).length >= 1);
check("type-loop.ts consumes the same presence.ts", grep('from "\\./presence\\.js"', path.join(SRC, "type-loop.ts")).length >= 1);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

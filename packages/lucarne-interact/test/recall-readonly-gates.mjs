// LS-13 dev/02 — the read-only law gates (Chrome-free, grep-only). Safety law 3: the recorder is
// read-only AND makes ZERO synthetic requests.
//
//  1. No `/eval` usage anywhere in recall — the `/eval` REPL + cross-eval `globalThis` state
//     (cadence's `recall.ts:44-60`) is RETIRED; recall holds its own in-process state instead.
//  2. No out-of-session fetch for media — `pbs.twimg.com` (or any CDN) is never contacted; per-post
//     image crops derive from the session's OWN screenshot via the shared assembler
//     (`cropImageFromScreenshot`, `video/assembler.ts`), never a network request.
//  3. No `click`/`goto`/`eval` — recall never drives the page (only reads: ARIA, screenshot,
//     screencast, DOM probes).
//  4. `lucarne-records` is a real dependency; NO `lucarne` (the engine) import exists in src/ —
//     recall talks to a session purely through its `cdpUrl`, same posture as `session.ts`.
//
// Run with `node test/recall-readonly-gates.mjs` (no build needed — this only greps src/ + reads
// package.json).
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
const RECALL_SRC = path.join(SRC, "recall");

function grep(pattern, dir) {
  try {
    const out = execFileSync("grep", ["-REn", pattern, dir], { encoding: "utf8" });
    return out.split("\n").filter(Boolean);
  } catch (e) {
    if (e.status === 1) return []; // grep: no matches
    throw e;
  }
}

// ── 1. no `/eval` usage anywhere in recall (the retired REPL) ──
const evalHits = grep("/eval", RECALL_SRC);
check("no '/eval' usage in src/recall (the eval-server REPL is retired)", evalHits.length === 0, evalHits.join(" | "));

// ── 2. no out-of-session fetch for media / no CDN url ──
const cdnHits = grep("pbs\\.twimg|fetch\\(.*http", RECALL_SRC);
check("no out-of-session fetch (pbs.twimg|fetch(...http) in src/recall — crops derive from the session screenshot", cdnHits.length === 0, cdnHits.join(" | "));

// Belt-and-suspenders: no bare `fetch(` or `XMLHttpRequest` calls anywhere in recall at all (the
// package makes no HTTP requests of its own — its only network-shaped surface is the CDP
// connection itself, which is a debugger protocol, not a site/CDN request).
const fetchCallHits = grep("\\bfetch\\s*\\(", RECALL_SRC);
check("no bare fetch(...) call anywhere in src/recall", fetchCallHits.length === 0, fetchCallHits.join(" | "));
const xhrHits = grep("XMLHttpRequest", RECALL_SRC);
check("no XMLHttpRequest usage anywhere in src/recall", xhrHits.length === 0, xhrHits.join(" | "));

// ── 3. recall never drives the page — no click/goto/eval verb names as method calls ──
const drivingHits = grep("\\.click\\(|\\.goto\\(|page\\.evaluate\\(.*=>.*\\.click|dispatchEvent\\(", RECALL_SRC);
check("no page-driving calls (.click(/.goto() etc) anywhere in src/recall — read-only", drivingHits.length === 0, drivingHits.join(" | "));

// ── 4. lucarne-records is a real dependency; no `lucarne` (engine) import in src/ ──
const pkg = JSON.parse(readFileSync(path.join(PKG_ROOT, "package.json"), "utf8"));
check("lucarne-records is a real (non-dev) dependency of lucarne-interact", !!pkg.dependencies?.["lucarne-records"], JSON.stringify(pkg.dependencies));
check("'lucarne' (the engine) is NOT a runtime dependency (peer-free, session-only posture)", !pkg.dependencies?.lucarne);

const engineImportHits = grep('from\\s*["\']lucarne["\']', SRC);
check("no `from 'lucarne'` import anywhere in src/ (the engine package is never imported by shipped code)", engineImportHits.length === 0, engineImportHits.join(" | "));

const cdpTsImportHits = grep('from\\s*["\'].*\\/cdp\\.js["\']', RECALL_SRC);
check("recall never imports the engine's internal src/cdp.ts (it owns its own playwright-core connection)", cdpTsImportHits.length === 0, cdpTsImportHits.join(" | "));

// ── belt-and-suspenders: the existing package-wide policy-free gate also covers recall now (no
//    cadence-specific strings leaked into the new files) ──
const policyHits = grep("FEEDS|x\\.com/home|\\.social|channels/", RECALL_SRC);
check("no cadence policy strings in src/recall either", policyHits.length === 0, policyHits.join(" | "));

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

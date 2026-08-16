// LS-13/LS-13W dev/02 — the read-only law gates (Chrome-free, grep-only). Safety law 3: the
// recorder is read-only AND makes ZERO synthetic requests.
//
//  1. No `/eval` usage anywhere in recall — the `/eval` REPL + cross-eval `globalThis` state
//     (cadence's `recall.ts:44-60`) is RETIRED; recall holds its own in-process state instead.
//  2. No out-of-session fetch for media — `pbs.twimg.com` (or any CDN) is never contacted; per-post
//     image crops derive from the session's OWN screenshot via the shared assembler
//     (`cropImageFromScreenshot`, `video/assembler.ts`), never a network request.
//  3. No `click`/`goto`/`eval` — recall never drives the page (only reads: ARIA, screenshot,
//     screencast, DOM probes, and — LS-13W — the CDP `Network` domain's passive response tap).
//  4. the records store is an IN-PACKAGE module (src/records), and NO `lucarne` (the engine)
//     dependency or import exists — recall talks to a session purely through its `cdpUrl`, same
//     posture as `session.ts`.
//  5. LS-13W: no `fetch(`/`XMLHttpRequest`/`chrome.windows`/`Fetch.enable`/`Fetch.continueRequest`/
//     `__cs_scroll`/`activeFetch` anywhere in recall — the WIRE sensor is a CDP `Network`-domain tap,
//     never the request-pausing `Fetch` domain, never a MV3-extension-shaped synthetic call. The
//     only CDP domains this package ever `.send()`s/`.enable`s for CAPTURE are `Network` (LS-13W)
//     and the pre-existing `Page.startScreencast` family (LS-13) — asserted directly against the
//     domain names appearing before a `.send(`/`.enable(` call in src/recall.
//
// Run with `node test/recall-readonly-gates.mjs` (no build needed — this only greps src/ + reads
// package.json).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

// ── 4. the records store lives IN this package; no `lucarne` (engine) dependency or import ──
const pkg = JSON.parse(readFileSync(path.join(PKG_ROOT, "package.json"), "utf8"));
check(
  "the records store is an in-package module (src/records/index.ts), not an external dependency",
  existsSync(path.join(SRC, "records", "index.ts")),
  path.join(SRC, "records", "index.ts"),
);
check("'lucarne' (the engine) is NOT a runtime dependency (peer-free, session-only posture)", !pkg.dependencies?.lucarne);

const engineImportHits = grep('from\\s*["\']lucarne["\']', SRC);
check("no `from 'lucarne'` import anywhere in src/ (the engine package is never imported by shipped code)", engineImportHits.length === 0, engineImportHits.join(" | "));

const cdpTsImportHits = grep('from\\s*["\'].*\\/cdp\\.js["\']', RECALL_SRC);
check("recall never imports the engine's internal src/cdp.ts (it owns its own playwright-core connection)", cdpTsImportHits.length === 0, cdpTsImportHits.join(" | "));

// ── belt-and-suspenders: the existing package-wide policy-free gate also covers recall now (no
//    cadence-specific strings leaked into the new files) ──
const policyHits = grep("FEEDS|x\\.com/home|\\.social|channels/", RECALL_SRC);
check("no cadence policy strings in src/recall either", policyHits.length === 0, policyHits.join(" | "));

// ── 5. LS-13W: the exact spec'd banned-pattern grep, 0 hits ──
const bannedPattern = 'fetch\\(|XMLHttpRequest|chrome\\.windows|Fetch\\.(enable|continueRequest)|__cs_scroll|activeFetch';
const bannedHits = grep(bannedPattern, RECALL_SRC);
check("LS-13W banned-pattern gate: 0 hits for fetch(|XMLHttpRequest|chrome.windows|Fetch.(enable|continueRequest)|__cs_scroll|activeFetch in src/recall", bannedHits.length === 0, bannedHits.join(" | "));

// ── 6. LS-13W: `Network` is the ONLY new CDP domain enabled/sent for capture; `Fetch.*` stays 0 ──
// Collect every `<Domain>.<method>` string literal passed to a CDP session's `.send(...)` anywhere
// recall's capture path reaches (src/recall itself, plus src/video/assembler.ts — the shared
// screencast tap `video-watch.ts` calls into) and assert the domain set is exactly the
// pre-LS-13W allowance (`Page` screencast, `Target` for actor-attribution identity) PLUS `Network`
// (LS-13W) — nothing else, and specifically never `Fetch`.
const VIDEO_SRC = path.join(SRC, "video");
function collectSendDomains(dir) {
  const hits = grep('\\.send\\(\\s*["\']([A-Za-z]+)\\.[A-Za-z]+', dir);
  const domains = new Set();
  for (const line of hits) {
    const m = line.match(/\.send\(\s*["']([A-Za-z]+)\./);
    if (m) domains.add(m[1]);
  }
  return domains;
}
const sendDomains = new Set([...collectSendDomains(RECALL_SRC), ...collectSendDomains(VIDEO_SRC)]);
const ALLOWED_DOMAINS = new Set(["Network", "Page", "Target"]);
const unexpectedDomains = [...sendDomains].filter((d) => !ALLOWED_DOMAINS.has(d));
check(
  "the only CDP domains this package ever .send()s for capture are Network (LS-13W) + Page (screencast) + Target (actor-attribution identity) — no other domain, and never Fetch",
  unexpectedDomains.length === 0 && sendDomains.has("Network"),
  `domains seen: ${[...sendDomains].join(",")}`,
);
const fetchDomainHits = grep('["\']Fetch\\.', SRC);
check("no literal 'Fetch.<method>' CDP call anywhere in src/ (the request-pausing domain is categorically never used)", fetchDomainHits.length === 0, fetchDomainHits.join(" | "));

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

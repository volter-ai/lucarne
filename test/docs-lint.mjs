// docs-lint: the two-package world's README contract.
//
// The platform ships TWO packages, and each one's README has to keep saying the things a reader
// needs before they install it:
//
//   - `lucarne` (the engine, widget included) — the widget's unit of trust is CSP-bypassing
//     injection composed at BUILD time, so those two words must appear wherever the engine is
//     documented (its README is the repo's root README).
//   - `lucarne-interact` (the verbs, recall, the records store, and the one `lucarne-mcp`) — the
//     canonical `## Charter` / `## Security posture` headings, plus every safety-law keyword the
//     merged package now covers: the never-automate verbs, enforced pacing, the gated `decideSend`,
//     the read-only zero-synthetic-requests capture law, and the corpus reader's never-fetches /
//     `not_captured` promise.
//
// The root README must name both packages, because a reader arriving at the repo needs to know
// the whole surface is those two.
//
// Node built-ins only — no dependency on anything the repo doesn't already ship.
// Run with `node test/docs-lint.mjs` from the monorepo root.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${!pass && detail ? "  — " + detail : ""}`);
}

function readReadme(pkg) {
  const p = path.join(ROOT, "packages", pkg, "README.md");
  if (!fs.existsSync(p)) {
    check(`${pkg}/README.md exists`, false, `not found at ${p}`);
    return null;
  }
  check(`${pkg}/README.md exists`, true);
  return fs.readFileSync(p, "utf8");
}

/** A literal `##`-level heading line, e.g. `## Charter` — not `###` or inline text. */
function hasHeading(text, heading) {
  const re = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
  return re.test(text);
}

function assertHeadings(pkg, text) {
  if (text == null) return;
  for (const heading of ["Charter", "Security posture"]) {
    check(`${pkg}/README.md has "## ${heading}" heading`, hasHeading(text, heading), `expected a literal "## ${heading}" heading line — none found`);
  }
}

/** keywords: array of { label, re } — every one must match somewhere in the file. */
function assertKeywords(pkg, text, keywords) {
  if (text == null) return;
  for (const { label, re } of keywords) {
    check(`${pkg}/README.md mentions ${label}`, re.test(text), `pattern ${re} not found anywhere in ${pkg}/README.md`);
  }
}

// ── lucarne (engine + widget): CSP-bypass + build-time composition is the widget's unit of trust ──
{
  const pkg = "lucarne";
  const text = readReadme(pkg);
  assertKeywords(pkg, text, [
    { label: "CSP-bypass (bypassCSP)", re: /bypasscsp/i },
    { label: "build-time composition", re: /build-time/i },
  ]);
}

// ── lucarne-interact: the safety-law mechanisms, the capture law, and the corpus reader's promise ──
{
  const pkg = "lucarne-interact";
  const text = readReadme(pkg);
  assertHeadings(pkg, text);
  assertKeywords(pkg, text, [
    { label: "never-automate ban word `click`", re: /`click`/ },
    { label: "never-automate ban word `goto`", re: /`goto`/ },
    { label: "never-automate ban word `eval`", re: /`eval`/ },
    { label: "enforced pacing", re: /enforced/i },
    { label: "gated decideSend", re: /decideSend/ },
    { label: "recorder read-only", re: /read-only/i },
    { label: "zero synthetic requests", re: /zero synthetic requests/i },
    { label: "CDP `Network` domain observation", re: /CDP/ },
    { label: "never Fetch (CDP Fetch domain banned)", re: /`Fetch`/ },
    { label: "screen sensor: ARIA", re: /ARIA/ },
    { label: "screen sensor: pixels", re: /pixels/i },
    { label: "no fetch", re: /fetch/i },
    { label: "no replay", re: /replay/i },
    { label: "no paginate", re: /paginat/i },
    { label: "no auto-scroll", re: /auto-scroll/i },
    // the merged halves: the records store, and the one MCP over it
    { label: "the records store it writes into", re: /records/i },
    { label: "the MCP surface it ships (lucarne-mcp)", re: /lucarne-mcp/ },
    { label: "a corpus miss says so instead of fetching (not_captured / no-egress)", re: /no-egress|not[ _]captured/i },
  ]);
}

// ── root README names both packages ──────────────────────────────────────
{
  const p = path.join(ROOT, "README.md");
  const exists = fs.existsSync(p);
  check("root README.md exists", exists, `not found at ${p}`);
  if (exists) {
    const text = fs.readFileSync(p, "utf8");
    // Word-boundaried so `lucarne` is not satisfied by the string inside `lucarne-interact`.
    for (const { pkg, re } of [
      { pkg: "lucarne", re: /\blucarne\b(?!-)/ },
      { pkg: "lucarne-interact", re: /\blucarne-interact\b/ },
    ]) {
      check(`root README.md names ${pkg}`, re.test(text), `"${pkg}" not found anywhere in root README.md`);
    }
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.error(`\nFAILED (${failed.length}): ${failed.map((r) => r.name).join("; ")}`);
}
process.exit(failed.length ? 1 : 0);

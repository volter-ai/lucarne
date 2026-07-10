// LS-17 dev/02 — the LIVE two-`ns` coexistence proof: mount TWO real `WidgetHost` shells with DIFFERENT `ns`
// values onto the SAME session (so both inject into the same page) and assert each shows ONLY its own marker —
// the live counterpart to `ns-coexistence.mjs`'s Chrome-free reducer-level proof. Extends
// `widget-selftest-acceptance.mjs`'s pattern (LS-16 dev/01) rather than duplicating `WidgetHost.selftest`'s
// five-assertion harness: that harness is scoped to ONE ns/host pair, so this script drives the DOM directly
// (mirroring `src/selftest.ts`'s own `domSnapshot`/`clickPill`/`iframeText` helpers) across both hosts at once.
//
// Needs Google Chrome + the optional peer dependency `playwright-core` installed, PLUS a working Chrome sandbox
// (this dev sandbox has neither) — CI-gated, run via `npm run test:acceptance` (the repo's `acceptance` CI job
// installs Chrome + xvfb, see `.github/workflows/ci.yml`).
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Lucarne } from "lucarne";
import { chromium } from "playwright-core";
import { buildSrcdoc } from "../dist/build.js";
import { SHELL_CSS } from "../dist/index.js";
import { WidgetHost } from "../dist/host.js";
import { hostElementId } from "../dist/ns.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-widget-ns-coexist-"));
process.env.LUCARNE_HOME = HOME;
if (!("LUCARNE_HEADLESS" in process.env)) process.env.LUCARNE_HEADLESS = "1";

const NS_A = "wsftenanta";
const NS_B = "wsftenantb";
const MARKER_A = `tenant A marker ${Date.now()}`;
const MARKER_B = `tenant B marker ${Date.now() + 1}`;

async function domSnapshot(page, hostId) {
  return page.evaluate((h) => {
    const hs = document.querySelectorAll("#" + h);
    const hEl = hs[0];
    const ifr = hEl?.shadowRoot ? hEl.shadowRoot.querySelectorAll("iframe") : [];
    return { hosts: hs.length, iframes: ifr.length };
  }, hostId);
}

function clickPill(page, hostId) {
  return page.evaluate((h) => {
    const hEl = document.getElementById(h);
    const doc = hEl?.shadowRoot?.querySelector("iframe")?.contentWindow?.document;
    const btn = doc?.querySelector(".pill");
    if (btn) btn.click();
    return !!btn;
  }, hostId);
}

function iframeText(page, hostId) {
  return page.evaluate((h) => {
    const hEl = document.getElementById(h);
    const doc = hEl?.shadowRoot?.querySelector("iframe")?.contentWindow?.document;
    return doc?.body ? doc.body.innerText || doc.body.textContent || null : null;
  }, hostId);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ENGINE_PORT = 7824;
const TOKEN = "ns-coexist-acc-token";
const engine = new Lucarne({ port: ENGINE_PORT, token: TOKEN, record: false });
await engine.listen();
let session;
let hostA;
let hostB;
let browser;
try {
  session = await engine.create({ backend: "native", profile: "ns-coexist-acc" });
  const engineOpts = { baseUrl: `http://127.0.0.1:${ENGINE_PORT}`, token: TOKEN };

  const cssA = `${SHELL_CSS}\n.marker { color: #5fd99a; font-weight: 600 }`;
  const cssB = `${SHELL_CSS}\n.marker { color: #d95f8f; font-weight: 600 }`;
  const { html: htmlA } = await buildSrcdoc({
    entryPoints: [resolve(__dirname, "fixtures/widget-selftest-entry.ts")],
    css: cssA,
    title: "lucarne-widget ns-coexistence fixture A",
    define: { __LW_NS__: JSON.stringify(NS_A) },
  });
  const { html: htmlB } = await buildSrcdoc({
    entryPoints: [resolve(__dirname, "fixtures/widget-selftest-entry.ts")],
    css: cssB,
    title: "lucarne-widget ns-coexistence fixture B",
    define: { __LW_NS__: JSON.stringify(NS_B) },
  });
  check("built both ns-tagged fixture bundles", htmlA.trim().toLowerCase().startsWith("<!doctype html>") && htmlB.trim().toLowerCase().startsWith("<!doctype html>"));

  // ── mount BOTH shells onto the SAME session — two sticky injections, two different `ns` values, one page. ──
  hostA = await WidgetHost.attach(session, { ns: NS_A, html: htmlA, engine: engineOpts, identity: { profile: "tenant-a" } });
  hostB = await WidgetHost.attach(session, { ns: NS_B, html: htmlB, engine: engineOpts, identity: { profile: "tenant-b" } });
  check("both WidgetHost.attach calls resolved (two distinct sticky shell registrations on one session)", !!hostA && !!hostB);

  browser = await chromium.connectOverCDP(session.cdpUrl);
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  await page.goto("data:text/html," + encodeURIComponent(`<!doctype html><html><body style="margin:0;background:#0b0d12;height:900px"></body></html>`), { waitUntil: "domcontentloaded" });

  const HOST_A = hostElementId(NS_A);
  const HOST_B = hostElementId(NS_B);

  // ── both shells mount on the SAME page (async sticky-injection discovery — poll, same as widget-selftest-acceptance.mjs). ──
  const deadline = Date.now() + 8000;
  let snapA = await domSnapshot(page, HOST_A);
  let snapB = await domSnapshot(page, HOST_B);
  while ((snapA.hosts !== 1 || snapB.hosts !== 1) && Date.now() < deadline) {
    await sleep(250);
    snapA = await domSnapshot(page, HOST_A);
    snapB = await domSnapshot(page, HOST_B);
  }
  check("shell A mounts exactly once on the shared page", snapA.hosts === 1 && snapA.iframes === 1, JSON.stringify(snapA));
  check("shell B mounts exactly once on the SAME shared page", snapB.hosts === 1 && snapB.iframes === 1, JSON.stringify(snapB));
  check("shell A's host id and shell B's host id are two distinct DOM nodes (disjoint ids on the live page)", HOST_A !== HOST_B);

  // ── push DIFFERENT patches into each — A gets its own marker, B gets its own, DIFFERENT marker. ──
  await hostA.push({ marker: MARKER_A, items: ["tenant A item"] });
  await hostB.push({ marker: MARKER_B, items: ["tenant B item"] });
  await sleep(400);
  await clickPill(page, HOST_A);
  await clickPill(page, HOST_B);
  await sleep(400);

  let textA = await iframeText(page, HOST_A);
  let textB = await iframeText(page, HOST_B);
  const popDeadline = Date.now() + 6000;
  while ((!(textA && textA.includes(MARKER_A)) || !(textB && textB.includes(MARKER_B))) && Date.now() < popDeadline) {
    await sleep(250);
    await hostA.push({ marker: MARKER_A, items: ["tenant A item"] });
    await hostB.push({ marker: MARKER_B, items: ["tenant B item"] });
    await clickPill(page, HOST_A);
    await clickPill(page, HOST_B);
    textA = await iframeText(page, HOST_A);
    textB = await iframeText(page, HOST_B);
  }

  // ── the core AC: each shell shows ONLY its OWN marker — never the other tenant's. ──
  check("shell A's iframe renders ITS OWN pushed marker", !!textA && textA.includes(MARKER_A), textA ?? "(null)");
  check("shell A's iframe NEVER renders shell B's marker (no cross-talk)", !textA || !textA.includes(MARKER_B), textA ?? "(null)");
  check("shell B's iframe renders ITS OWN pushed marker", !!textB && textB.includes(MARKER_B), textB ?? "(null)");
  check("shell B's iframe NEVER renders shell A's marker (no cross-talk)", !textB || !textB.includes(MARKER_A), textB ?? "(null)");

  await page.close({ runBeforeUnload: false }).catch(() => {});
} finally {
  try {
    if (browser) await browser.close();
  } catch {
    /* detach only */
  }
  if (hostA) await hostA.remove().catch(() => {});
  if (hostB) await hostB.remove().catch(() => {});
  if (session) await engine.destroy(session.id).catch(() => {});
  await engine.close().catch(() => {});
  fs.rmSync(HOME, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} acceptance proofs passed`);
process.exit(failed.length ? 1 : 0);

// LS-16 dev/01 acceptance proof — the package's OWN committed re-runnable proof that `WidgetHost.selftest`
// actually mounts + behaves in a real page: mints a REAL lucarne session (native Chrome), builds the NEUTRAL
// fixture bundle (`test/fixtures/widget-selftest-entry.ts` — two generic panels + a pill, zero app-specific
// content, replacing the app-specific test data the prior single-app selftest used), and runs
// `WidgetHost.selftest` against it end-to-end. Needs Google Chrome + the optional peer dependency
// `playwright-core` installed, PLUS a working Chrome sandbox — a locked-down container can have both
// installed and still fail with "No usable sandbox!"; run via `npm run test:acceptance` in CI (the repo's
// acceptance job installs Chrome + xvfb and runs `npm run test:acceptance --workspaces --if-present`).
//
// Prints each of the FIVE assertions `WidgetHost.selftest` reports (singleton / top-frame-only / size-stable /
// survives-reload-populated / responsive) individually, PASS/FAIL, modeled on this repo's other acceptance
// scripts (`packages/lucarne/test/acceptance.mjs`, `packages/lucarne-interact/test/acceptance.mjs`).
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Lucarne } from "lucarne";
import { buildSrcdoc } from "../dist/build.js";
import { SHELL_CSS } from "../dist/index.js";
import { WidgetHost } from "../dist/host.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-widget-selftest-acc-"));
process.env.LUCARNE_HOME = HOME;
if (!("LUCARNE_HEADLESS" in process.env)) process.env.LUCARNE_HEADLESS = "1";

const NS = "wsftest";
const MARKER = `panel content is live ${Date.now()}`;
const FIXTURES = {
  marker: MARKER,
  patch: { marker: MARKER, items: ["first neutral item", "second neutral item"] },
};

const CSS = `${SHELL_CSS}\n.marker { color: #5fd99a; font-weight: 600 }`;
const { html } = await buildSrcdoc({
  entryPoints: [resolve(__dirname, "fixtures/widget-selftest-entry.ts")],
  css: CSS,
  title: "lucarne-widget selftest fixture",
  define: { __LW_NS__: JSON.stringify(NS) },
});
check("built the neutral fixture srcdoc bundle", html.trim().toLowerCase().startsWith("<!doctype html>"), `${html.length} bytes`);

const ENGINE_PORT = 7823;
const TOKEN = "widget-selftest-acc-token";
const engine = new Lucarne({ port: ENGINE_PORT, token: TOKEN, record: false });
await engine.listen();
let session;
try {
  session = await engine.create({ backend: "native", profile: "widget-selftest-acc" });

  const result = await WidgetHost.selftest(session, {
    ns: NS,
    html,
    fixtures: FIXTURES,
    engine: { baseUrl: `http://127.0.0.1:${ENGINE_PORT}`, token: TOKEN },
  });

  // ── the FIVE assertions, individually reported (each is exactly one check() call below, sourced 1:1 from
  // `result.checks` — WidgetHost.selftest is the thing under test, this script only relays its verdicts). ──
  const byPrefix = (prefix) => result.checks.find((c) => c.name.startsWith(prefix));
  const singleton = byPrefix("singleton:");
  const topFrameOnly = byPrefix("top-frame-only:");
  const sizeStable = byPrefix("size-stable:");
  const survivesReloadPopulated = byPrefix("survives-reload-populated:");
  const responsive = byPrefix("responsive:");

  check("selftest reported all five named assertions", [singleton, topFrameOnly, sizeStable, survivesReloadPopulated, responsive].every(Boolean), JSON.stringify(result.checks.map((c) => c.name)));
  if (singleton) check(`1/5 ${singleton.name}`, singleton.pass, singleton.detail);
  if (topFrameOnly) check(`2/5 ${topFrameOnly.name}`, topFrameOnly.pass, topFrameOnly.detail);
  if (sizeStable) check(`3/5 ${sizeStable.name}`, sizeStable.pass, sizeStable.detail);
  if (survivesReloadPopulated) check(`4/5 ${survivesReloadPopulated.name}`, survivesReloadPopulated.pass, survivesReloadPopulated.detail);
  if (responsive) check(`5/5 ${responsive.name}`, responsive.pass, responsive.detail);
  check("WidgetHost.selftest's own overall verdict (result.pass)", result.pass === true, JSON.stringify(result));
} finally {
  if (session) await engine.destroy(session.id).catch(() => {});
  await engine.close().catch(() => {});
  fs.rmSync(HOME, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} acceptance proofs passed`);
process.exit(failed.length ? 1 : 0);

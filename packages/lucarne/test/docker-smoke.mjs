// Docker-backend smoke proof — the other half of "native + docker backends".
// Boots a real container (needs `lucarne-browser:latest` built) and proves the
// SHARED engine code (drive over CDP) works identically on the docker backend.
// Run: npm run build:image && node test/docker-smoke.mjs
import { Lucarne } from "../dist/index.js";
import { chromium } from "playwright";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const TOKEN = "t";
const engine = new Lucarne({ port: 7840, token: TOKEN, record: false });
await engine.listen();
let s;
try {
  // The container publishes CDP to 127.0.0.1; the engine drives it exactly as native.
  s = await engine.create({ backend: "docker", profile: "smoke" });
  check("docker: session reports a docker backend", s.backend === "docker");

  const browser = await chromium.connectOverCDP(s.cdpUrl);
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
  const title = await page.title();
  await browser.close();
  check("docker: connectOverCDP drives the containerized Chrome", title === "Example Domain", title);

  // status reflects the live containerized session
  const st = engine.status(s.id);
  check("docker: status reports the live session", !!st && st.uptimeMs >= 0);
} finally {
  if (s) await engine.destroy(s.id).catch(() => {});
  await engine.close().catch(() => {});
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} docker-smoke proofs passed`);
process.exit(failed ? 1 : 0);

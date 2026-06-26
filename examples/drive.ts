// Run an lucarne daemon first:  npx lucarne serve
// then:  node --experimental-strip-types examples/drive.ts   (Node 22+)
//
// Mints a session, drives it with vanilla Playwright via the returned cdpUrl,
// and prints the viewUrl you'd open (or iframe) to watch + take over.
import { chromium } from "playwright";

const API = process.env.LUCARNE_URL ?? "http://127.0.0.1:7800";

const session = await (
  await fetch(`${API}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile: "demo", backend: "native" }),
  })
).json();

console.log("session:", session);

const browser = await chromium.connectOverCDP(session.cdpUrl);
const page = browser.contexts()[0]!.pages()[0] ?? (await browser.contexts()[0]!.newPage());
await page.goto("https://playwright.dev", { waitUntil: "domcontentloaded" });
console.log("title:", await page.title());
await browser.close(); // detaches; the session keeps running

console.log("\nwatch + control it here:", session.viewUrl);

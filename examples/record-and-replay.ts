// Record + replay: every session records by default (a rolling buffer). Pull the
// segment list and bytes, or open the built-in replay player in a browser.
// Run a daemon first (recording on):  npx lucarne serve
// then:  node --experimental-strip-types examples/record-and-replay.ts   (Node 22+)
import { LucarneClient } from "lucarne";
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const base = process.env.LUCARNE_URL ?? "http://127.0.0.1:7800";
const lucarne = new LucarneClient({ baseUrl: base, token: process.env.LUCARNE_TOKEN });

const s = await lucarne.create({ profile: "demo-rec", backend: "native" });

// do something worth recording
const browser = await chromium.connectOverCDP(s.cdpUrl);
const page = browser.contexts()[0]!.pages()[0]!;
await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
await new Promise((r) => setTimeout(r, 3000)); // let a segment accumulate
await browser.close();

const segments = await lucarne.recordings(s.id);
console.log("segments:", segments);
if (segments[0]) {
  const mp4 = await lucarne.recording(s.id, segments[0]);
  writeFileSync(`/tmp/${segments[0]}`, mp4);
  console.log(`saved /tmp/${segments[0]} (${mp4.length} bytes)`);
}

// …or just open the player (token appended automatically if the daemon needs one):
console.log("replay in a browser:", `${base}/sessions/${s.id}/replay`);

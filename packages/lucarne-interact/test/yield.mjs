// LS-10 dev/02 — yield-to-human, Chrome-free with mocks for BOTH probe paths.
//
// Two layers:
//   A. `checkHumanYield` (the pure decision) — asserted directly for each path.
//   B. `runTypeLoop` (what `InteractSession#type` runs) — driven with mock typeChar/sleep and a mock
//      probe that "turns human" partway through, proving typing ABORTS mid-string and returns
//      `{ yielded: true }`. Covered once via the PREFERRED activity-API path and once via the
//      FALLBACK in-page `__lastInputAt` path.
//
// No browser, no network: every probe/keystroke is an injected callback.
//
// Run with `node test/yield.mjs` (after `npm run build`).
import assert from "node:assert/strict";
import { checkHumanYield, runTypeLoop } from "../dist/index.js";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const THRESH = 1500;

// ══ A. checkHumanYield — the pure decision, both paths ══════════════════════════════════════════

// (a) PREFERRED path: lucarne's actor-tagged activity via now.lastHumanActionMsAgo.
{
  const fresh = await checkHumanYield({ activityProbe: async () => ({ now: { lastHumanActionMsAgo: 200 } }), thresholdMs: THRESH });
  check("activity path: fresh human action (200ms ago) -> yield", fresh.yield === true && fresh.path === "activity", JSON.stringify(fresh));

  const stale = await checkHumanYield({ activityProbe: async () => ({ now: { lastHumanActionMsAgo: 9000 } }), thresholdMs: THRESH });
  check("activity path: stale human action (9000ms ago) -> no yield", stale.yield === false && stale.path === "activity", JSON.stringify(stale));

  // Preference: when BOTH probes are present, the activity path decides and the in-page probe is not consulted.
  let inPageCalled = false;
  const preferred = await checkHumanYield({
    activityProbe: async () => ({ now: { lastHumanActionMsAgo: 100 } }),
    inPageProbe: async () => {
      inPageCalled = true;
      return Date.now();
    },
    thresholdMs: THRESH,
  });
  check("activity path is PREFERRED over the in-page probe when both are present", preferred.path === "activity" && preferred.yield === true && inPageCalled === false);

  // null lastHumanActionMsAgo (human never acted) -> fall through to the in-page probe.
  let fellThrough = false;
  const fall = await checkHumanYield({
    activityProbe: async () => ({ now: { lastHumanActionMsAgo: null } }),
    inPageProbe: async () => {
      fellThrough = true;
      return null;
    },
    thresholdMs: THRESH,
  });
  check("activity path: null lastHumanActionMsAgo falls through to the in-page probe", fellThrough === true && fall.path === "none");
}

// (b) FALLBACK path: in-page window.__lastInputAt (raw page timestamp).
{
  const now = 1_000_000;
  const clock = () => now;
  // A page timestamp 300ms ago, newer than our last keystroke -> a human -> yield.
  const human = await checkHumanYield({ inPageProbe: async () => now - 300, lastAgentInputAt: now - 5000, thresholdMs: THRESH, now: clock });
  check("in-page path: fresh page input (300ms ago, after our last keystroke) -> yield", human.yield === true && human.path === "in-page", JSON.stringify(human));

  // The page timestamp is our OWN echo (== lastAgentInputAt) -> NOT a human -> no yield.
  const ownEcho = await checkHumanYield({ inPageProbe: async () => now - 100, lastAgentInputAt: now - 100, thresholdMs: THRESH, now: clock });
  check("in-page path: our own keystroke echo (ts <= lastAgentInputAt) -> no yield", ownEcho.yield === false && ownEcho.path === "in-page", JSON.stringify(ownEcho));

  // A human input, but stale (older than the threshold) -> no yield.
  const stale = await checkHumanYield({ inPageProbe: async () => now - 5000, lastAgentInputAt: now - 9000, thresholdMs: THRESH, now: clock });
  check("in-page path: stale page input (5000ms ago) -> no yield", stale.yield === false && stale.path === "in-page");

  // No probes at all -> no signal, no yield.
  const none = await checkHumanYield({ thresholdMs: THRESH });
  check("no probes available -> path 'none', no yield", none.yield === false && none.path === "none" && none.msAgo === null);
}

// ══ B. runTypeLoop — a simulated human mid-type ABORTS and returns { yielded: true } ═════════════

const EVERY = 4; // check every 4 chars, so a 26-char string checks several times

// (a) PREFERRED probe path: activity API reports a fresh human action after enough chars are typed.
{
  const typed = [];
  let calls = 0;
  const result = await runTypeLoop(
    "abcdefghijklmnopqrstuvwxyz",
    { yieldCheckEvery: EVERY, yieldThresholdMs: THRESH },
    {
      typeChar: async (ch) => {
        typed.push(ch);
      },
      sleep: async () => {}, // instant
      activityProbe: async () => {
        calls += 1;
        // First check (at char 4): no human yet. Second check (at char 8): a human grabs the wheel.
        return { now: { lastHumanActionMsAgo: calls >= 2 ? 100 : 9000 } };
      },
    },
  );
  check("[activity] runTypeLoop yielded mid-type", result.yielded === true, JSON.stringify(result));
  check("[activity] aborted BEFORE finishing the string", result.typed < result.chars && result.typed === typed.length, `typed=${result.typed}/${result.chars}`);
  check("[activity] yielded at a yield-check boundary (multiple of EVERY)", result.typed % EVERY === 0, `typed=${result.typed}`);
}

// (b) FALLBACK probe path: in-page __lastInputAt turns "fresh & newer than our keystrokes" mid-type.
{
  const typed = [];
  let virtualNow = 5_000_000;
  const clock = () => virtualNow;
  let checks = 0;
  const result = await runTypeLoop(
    "abcdefghijklmnopqrstuvwxyz",
    { yieldCheckEvery: EVERY, yieldThresholdMs: THRESH },
    {
      typeChar: async (ch) => {
        typed.push(ch);
        virtualNow += 10; // our keystrokes advance the clock (and would stamp lastAgentInputAt)
      },
      sleep: async () => {
        virtualNow += 5;
      },
      now: clock,
      inPageProbe: async () => {
        checks += 1;
        // First check: the only input the page ever saw is our own keystrokes (older than our last
        // dispatch → not a human). Later: a REAL human input lands "just now" (virtualNow) — newer
        // than our last keystroke and 0ms ago, so inside the threshold → yield.
        return checks >= 2 ? virtualNow : 1_000; // a stale, pre-typing timestamp on the first check
      },
    },
  );
  check("[in-page] runTypeLoop yielded mid-type", result.yielded === true, JSON.stringify(result));
  check("[in-page] aborted BEFORE finishing the string", result.typed < result.chars && result.typed === typed.length, `typed=${result.typed}/${result.chars}`);
}

// Control: with NO human ever detected, the loop types the WHOLE string and does not yield.
{
  const typed = [];
  const result = await runTypeLoop(
    "hello world",
    { yieldCheckEvery: EVERY, yieldThresholdMs: THRESH },
    {
      typeChar: async (ch) => {
        typed.push(ch);
      },
      sleep: async () => {},
      activityProbe: async () => ({ now: { lastHumanActionMsAgo: 9999 } }), // always stale
    },
  );
  check("control: no human -> types the whole string, does not yield", result.yielded === false && result.typed === result.chars && typed.join("") === "hello world");
}

// Control: the FIRST characters (before the first yield-check at index EVERY) always type, even if a
// human is already present — the check only runs at i % every === 0 with i > 0 (matches browser.ts:187).
{
  const typed = [];
  const result = await runTypeLoop(
    "abcdefgh",
    { yieldCheckEvery: EVERY, yieldThresholdMs: THRESH },
    {
      typeChar: async (ch) => {
        typed.push(ch);
      },
      sleep: async () => {},
      activityProbe: async () => ({ now: { lastHumanActionMsAgo: 10 } }), // human present from the start
    },
  );
  check("control: yield-check cadence — first EVERY chars type before the first check", result.typed === EVERY && result.yielded === true, JSON.stringify(result));
}

assert.ok(true);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

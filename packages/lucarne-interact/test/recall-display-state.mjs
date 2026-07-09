// LS-14 dev/01 — `displayState()` (the five-layer status contract's composition), ported from
// the origin app's `test/recall-status.test.mjs` (assertions ported faithfully, restyled onto this
// package's manual check()/process.exit convention rather than node:test). The load-bearing
// property under test throughout is the STALENESS LAW: a stale or absent snapshot can NEVER report
// a live "recording" state, even if it CLAIMS `activity: 'recording_video'` — a wedged/dead
// recorder must never show as live (the "never falsely claim recording" invariant LS-14 owns).
//
// Imported via the package's OWN subpath export (`lucarne-interact/status`, package.json's
// `exports`) rather than a relative `../dist/...` path — this doubles as the subpath-resolution
// proof itself: if `package.json` mis-wired the export, this import would fail to resolve before a
// single assertion even runs.
//
// Run with `node test/recall-display-state.mjs` (after `npm run build`).
import { displayState, DISPLAY, OBSERVE, ACTIVITY, STALE_MS, heldMs } from "lucarne-interact/status";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const NOW = 1_000_000;
const fresh = (over = {}) => ({ ts: NOW, enabled: true, observe: OBSERVE.OK, activity: ACTIVITY.IDLE, ...over });

// ── absent / null / empty snapshot → OFFLINE, never live (the safety law) ──
for (const s of [null, undefined, {}, { enabled: true }]) {
  const d = displayState(s, NOW);
  check(`absent/null/empty snapshot (${JSON.stringify(s)}) → OFFLINE`, d.state === DISPLAY.OFFLINE);
  check(`absent/null/empty snapshot (${JSON.stringify(s)}) → never live`, d.live === false);
}

// ── stale heartbeat → OFFLINE even if it claims recording (the dark-recorder case) ──
{
  const s = fresh({ ts: NOW - STALE_MS - 1, activity: ACTIVITY.RECORDING_VIDEO });
  const d = displayState(s, NOW);
  check("stale heartbeat claiming recording_video still reads OFFLINE (staleness law)", d.state === DISPLAY.OFFLINE);
  check("stale heartbeat claiming recording_video is NEVER live", d.live === false);
}

// ── liveness is evaluated on the READER clock — the boundary is exclusive ──
{
  check("just-inside the staleness window is honored (still WATCHING)", displayState(fresh({ ts: NOW - (STALE_MS - 1) }), NOW).state === DISPLAY.WATCHING);
  check("exactly AT the staleness window is already OFFLINE (boundary is exclusive)", displayState(fresh({ ts: NOW - STALE_MS }), NOW).state === DISPLAY.OFFLINE);
}

// ── L1 control: disabled → OFF (alive but deliberately dormant, distinct from OFFLINE) ──
{
  const d = displayState(fresh({ enabled: false }), NOW);
  check("L1 disabled → OFF", d.state === DISPLAY.OFF);
  check("L1 disabled → not live", d.live === false);
}

// ── L2 dominates L1: a stale DISABLED snapshot still reads OFFLINE (process-gone trumps intent) ──
{
  const d = displayState(fresh({ enabled: false, ts: NOW - STALE_MS - 1 }), NOW);
  check("L2 (staleness) dominates L1 (control): a stale disabled snapshot is still OFFLINE", d.state === DISPLAY.OFFLINE);
}

// ── L3 observability: no server → RECONNECTING, no page → NO_PAGE (both not live) ──
{
  check("L3 observe:NO_SERVER → RECONNECTING", displayState(fresh({ observe: OBSERVE.NO_SERVER }), NOW).state === DISPLAY.RECONNECTING);
  check("L3 observe:NO_PAGE → NO_PAGE", displayState(fresh({ observe: OBSERVE.NO_PAGE }), NOW).state === DISPLAY.NO_PAGE);
  check("L3 observe:NO_SERVER → not live", displayState(fresh({ observe: OBSERVE.NO_SERVER }), NOW).live === false);
}

// ── precedence: control (off) beats observability ──
{
  const d = displayState(fresh({ enabled: false, observe: OBSERVE.NO_SERVER }), NOW);
  check("precedence: L1 (off) beats L3 (observability)", d.state === DISPLAY.OFF);
}

// ── L4 activity: starting (not live) → idle becomes WATCHING (live) ──
{
  const starting = displayState(fresh({ activity: ACTIVITY.STARTING }), NOW);
  check("L4 activity:starting → STARTING", starting.state === DISPLAY.STARTING);
  check("L4 activity:starting → not live", starting.live === false);
  const watching = displayState(fresh({ activity: ACTIVITY.IDLE }), NOW);
  check("L4 activity:idle → WATCHING", watching.state === DISPLAY.WATCHING);
  check("L4 activity:idle → live", watching.live === true);
}

// ── L4 recording-video → RECORDING + live, carries progress ──
{
  const d = displayState(fresh({ activity: ACTIVITY.RECORDING_VIDEO, progress: { ct: 12.3, dur: 30 } }), NOW);
  check("L4 activity:recording_video → RECORDING", d.state === DISPLAY.RECORDING);
  check("L4 activity:recording_video → live", d.live === true);
  check("L4 activity:recording_video → carries progress verbatim", d.progress && d.progress.ct === 12.3 && d.progress.dur === 30);
}

// ── observability beats activity: no-page wins even while activity says idle ──
{
  const d = displayState(fresh({ observe: OBSERVE.NO_PAGE, activity: ACTIVITY.IDLE }), NOW);
  check("precedence: L3 (no-page) beats L4 (idle)", d.state === DISPLAY.NO_PAGE);
}

// ── heldMs: "how long has this state held" (for "reconnecting for 8s"-style honesty) ──
{
  check("heldMs: null when since is absent", heldMs({}, NOW) === null);
  check("heldMs: null on a null/undefined status", heldMs(null, NOW) === null && heldMs(undefined, NOW) === null);
  check("heldMs: computes now-since when since is present", heldMs({ since: NOW - 4200 }, NOW) === 4200);
  check("heldMs: never negative (clamped at 0)", heldMs({ since: NOW + 5000 }, NOW) === 0);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

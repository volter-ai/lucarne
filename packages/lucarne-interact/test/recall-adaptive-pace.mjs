// LS-13 dev — the idle-backoff poll pacer (Chrome-free): ported from cadence's `recall.ts:289-295`.
// Distinct from `../pacing.ts` (the ACT half's enforced human-paced dwell) — see adaptive-pace.ts's
// header for why the two are unrelated mechanisms.
//
// Run with `node test/recall-adaptive-pace.mjs` (after `npm run build`).
import { adaptivePaceMs, bumpIdle, DEFAULT_ADAPTIVE_PACE, IDLE_COUNTER_CAP } from "../dist/recall/adaptive-pace.js";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

check("idle=0 -> activeMs (500)", adaptivePaceMs(0) === 500);
check("idle grows geometrically (1.6^idle) before the cap", Math.abs(adaptivePaceMs(1) - 500 * 1.6) < 1e-9, String(adaptivePaceMs(1)));
check("idle caps at idleMs (2500) for large idle", adaptivePaceMs(50) === 2500);
check("negative idle is clamped to 0 (never < activeMs)", adaptivePaceMs(-3) === 500);
check("a custom config is honored", adaptivePaceMs(0, { activeMs: 100, idleMs: 900, growth: 2 }) === 100);
check("a custom config's cap is honored", adaptivePaceMs(20, { activeMs: 100, idleMs: 900, growth: 2 }) === 900);
check("DEFAULT_ADAPTIVE_PACE matches cadence's ACTIVE_MS/IDLE_MS (recall.ts:294)", DEFAULT_ADAPTIVE_PACE.activeMs === 500 && DEFAULT_ADAPTIVE_PACE.idleMs === 2500 && DEFAULT_ADAPTIVE_PACE.growth === 1.6);

// pace() is monotonically non-decreasing as idle grows (never snaps back down on its own — only an
// explicit `idle = 0` reset, driven by the caller on activity, does that).
{
  let prev = adaptivePaceMs(0);
  let monotonic = true;
  for (let i = 1; i <= 20; i++) {
    const v = adaptivePaceMs(i);
    if (v < prev) monotonic = false;
    prev = v;
  }
  check("adaptivePaceMs is monotonically non-decreasing in idle", monotonic);
}

check("IDLE_COUNTER_CAP is 12 (cadence's recall.ts:402 'idle < 12')", IDLE_COUNTER_CAP === 12);
check("bumpIdle: increments below the cap", bumpIdle(0) === 1 && bumpIdle(11) === 12);
check("bumpIdle: never increments past the cap once reached", bumpIdle(12) === 12);
check("bumpIdle: an idle value already above the cap is left unchanged (not clamped down)", bumpIdle(50) === 50);
check("bumpIdle: a custom cap is honored", bumpIdle(4, 5) === 5 && bumpIdle(5, 5) === 5);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

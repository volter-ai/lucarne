// LS-13 dev — the publish chokepoint (Chrome-free): ported from cadence's single status-writing
// site (`recall.ts:296-311`). `since` is stamped ONLY when `observe`/`activity` actually change.
//
// Run with `node test/recall-status.mjs` (after `npm run build`).
import { RecallStatusHolder } from "../dist/recall/status.js";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

{
  let now = 1_000_000;
  const holder = new RecallStatusHolder(() => now);
  const initial = holder.snapshot();
  check("starts as enabled:true, observe:'ok', activity:'starting'", initial.enabled === true && initial.observe === "ok" && initial.activity === "starting", JSON.stringify(initial));
  check("the initial 'since' is the construction instant", initial.since === 1_000_000);

  now = 1_000_500;
  const same = holder.publish({ activity: "starting" }); // no actual change
  check("publishing the SAME activity value does not move 'since'", same.since === 1_000_000, JSON.stringify(same));

  now = 1_001_000;
  const changed = holder.publish({ activity: "idle" });
  check("publishing a DIFFERENT activity value moves 'since' to now", changed.activity === "idle" && changed.since === 1_001_000, JSON.stringify(changed));

  now = 1_001_500;
  const observeChanged = holder.publish({ observe: "no_page" });
  check("an observe-only change moves 'since', leaves activity untouched", observeChanged.observe === "no_page" && observeChanged.activity === "idle" && observeChanged.since === 1_001_500, JSON.stringify(observeChanged));

  now = 1_002_000;
  const progressOnly = holder.publish({ progress: { ct: 3.2, dur: 10 } });
  check("a progress-only patch does not move 'since' (progress isn't a state layer)", progressOnly.since === 1_001_500 && progressOnly.progress?.ct === 3.2, JSON.stringify(progressOnly));

  const progressCleared = holder.publish({ progress: null });
  check("progress can be explicitly cleared back to null", progressCleared.progress === null);

  const disabled = holder.publish({ enabled: false });
  check("enabled is echoed from the patch (L1 control, no since-effect)", disabled.enabled === false);

  // ts is always the CURRENT clock read, independent of 'since' (liveness signal vs. state-transition signal).
  now = 1_050_000;
  const laterSnap = holder.snapshot();
  check("ts reflects the current clock on every snapshot (the liveness heartbeat)", laterSnap.ts === 1_050_000);
  check("since is unaffected by a snapshot() with no publish", laterSnap.since === 1_001_500);
}

{
  // Default clock (no injected `now`) actually calls Date.now — sanity, not a determinism check.
  const holder = new RecallStatusHolder();
  const t0 = Date.now();
  const snap = holder.snapshot();
  check("default clock produces a real, current timestamp", snap.ts >= t0 && snap.ts <= Date.now());
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

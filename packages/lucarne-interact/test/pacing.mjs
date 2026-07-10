// LS-09 dev/02 — the pacing statistical proof (Chrome-free).
//
// Ports the pacing behavior of cadence's `pace()` (browser.ts:151-154): a normal-distribution
// dwell, `max(min, mean + sd*N(0,1))`, sampled after every verb. This samples the pacing function
// DIRECTLY (no browser needed) at large N per kind and asserts:
//   1. every sample is >= the configured floor (the "always-positive floor, no way under it" law)
//   2. the sample mean is within tolerance of the configured mean
// Both the DEFAULT pacing table and a CUSTOM one (proving configurability) are checked, plus the
// "floor must be > 0" validation itself.
//
// Run with `node test/pacing.mjs` (after `npm run build`).
import { DEFAULT_PACING, resolvePacing, sampleDwellMs } from "../dist/index.js";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const N = 20000;

function sampleStats(profile, n = N) {
  const samples = new Array(n);
  let min = Infinity;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = sampleDwellMs(profile);
    samples[i] = v;
    if (v < min) min = v;
    sum += v;
  }
  const mean = sum / n;
  // Because of the floor, the TRUE mean of max(min, X) is >= the unfloored mean(profile.mean);
  // when floor << mean (as in every default profile below) the floor's effect on the mean is
  // negligible, so a generous tolerance band around profile.mean is still a meaningful check.
  return { min, mean, samples };
}

// ── every default pacing kind: floor honored, mean in-band ──
for (const [kind, profile] of Object.entries(DEFAULT_PACING)) {
  const { min, mean } = sampleStats(profile);
  check(`[${kind}] every one of ${N} samples >= floor (${profile.min}ms)`, min >= profile.min, `observed min=${min}`);
  // tolerance: the standard error of the mean at N=20000 is sd/sqrt(N); use a wide 6x-stderr band
  // (plus a small floor-clipping allowance) so this is not a flaky test, while still being a real check.
  const stderr = profile.sd / Math.sqrt(N);
  const tolerance = 6 * stderr + profile.sd * 0.02;
  const delta = Math.abs(mean - profile.mean);
  check(
    `[${kind}] sample mean (${mean.toFixed(1)}ms) within tolerance (±${tolerance.toFixed(1)}ms) of configured mean (${profile.mean}ms)`,
    delta <= tolerance,
    `delta=${delta.toFixed(1)}ms`,
  );
}

// ── configurability: a caller-supplied pacing table changes the sampled distribution ──
const custom = resolvePacing({ nav: { mean: 100, sd: 10, min: 40 }, read: { min: 900 } });
check("resolvePacing: custom nav.mean applied", custom.nav.mean === 100);
check("resolvePacing: custom nav.sd applied", custom.nav.sd === 10);
check("resolvePacing: custom nav.min applied", custom.nav.min === 40);
check("resolvePacing: unset read.mean falls back to default", custom.read.mean === DEFAULT_PACING.read.mean);
check("resolvePacing: overridden read.min applied", custom.read.min === 900);
check("resolvePacing: untouched kinds (scroll, act) equal the defaults", custom.scroll.mean === DEFAULT_PACING.scroll.mean && custom.act.mean === DEFAULT_PACING.act.mean);

{
  const { min, mean } = sampleStats(custom.nav, 5000);
  check("[custom nav] every sample >= custom floor (40ms)", min >= 40, `observed min=${min}`);
  const stderr = custom.nav.sd / Math.sqrt(5000);
  check(
    `[custom nav] sample mean (${mean.toFixed(1)}ms) within tolerance of custom mean (100ms)`,
    Math.abs(mean - 100) <= 6 * stderr + 1,
  );
}

// ── the always-positive-floor law: 0 or negative min must be REFUSED, not silently accepted ──
for (const badMin of [0, -1, -1000]) {
  let threw = false;
  try {
    resolvePacing({ read: { min: badMin } });
  } catch {
    threw = true;
  }
  check(`resolvePacing rejects a non-positive floor (min=${badMin})`, threw);
}
{
  let threw = false;
  try {
    sampleDwellMs({ mean: 100, sd: 10, min: 0 });
  } catch {
    threw = true;
  }
  check("sampleDwellMs itself also rejects a non-positive floor", threw);
}

// ── a floor far above the mean still holds (proves the max() clamp, not just typical-case luck) ──
{
  const extreme = { mean: 10, sd: 5, min: 5000 };
  const { min } = sampleStats(extreme, 2000);
  check("an extreme floor (min >> mean) clamps EVERY sample to the floor", min === 5000, `observed min=${min}`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

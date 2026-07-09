// Enforced human pacing — a normal-distribution dwell AFTER every act verb (you can't go bot-fast).
// Ported (mechanism only) from the origin app's `PACE`/`pace()` at browser.ts:150-154, applied at :573-577.
//
// The floor is ALWAYS positive: `resolvePacing` throws if a caller tries to configure a `min` of 0
// (or negative) for any pacing kind. There is no escape hatch that turns pacing off — that would
// defeat the point (the anti-bot-detection law is "every action is followed by an ENFORCED human
// pause", not "unless you ask nicely").

/** One pacing distribution: dwell ~ max(min, mean + sd * N(0,1)), in milliseconds. */
export interface PaceProfile {
  mean: number;
  sd: number;
  min: number;
}

/** The four pacing buckets a verb can fall into. ('act' is reserved for LS-10/11's type/send.) */
export type PaceKind = "nav" | "scroll" | "read" | "act";

/** Caller-supplied overrides, per kind — any field omitted falls back to the default for that kind. */
export type PacingConfig = Partial<Record<PaceKind, Partial<PaceProfile>>>;

// Verbatim from browser.ts:151-152.
export const DEFAULT_PACING: Readonly<Record<PaceKind, PaceProfile>> = Object.freeze({
  nav: Object.freeze({ mean: 2600, sd: 1000, min: 800 }),
  scroll: Object.freeze({ mean: 1100, sd: 450, min: 350 }),
  read: Object.freeze({ mean: 1400, sd: 600, min: 350 }),
  act: Object.freeze({ mean: 1800, sd: 700, min: 500 }),
});

/** Standard-normal sample via Box-Muller — same generator as the origin app's `randn` (browser.ts:153). */
export function randn(): number {
  let u = 0,
    v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Resolve a full per-kind pacing table from optional overrides, validating the always-positive floor. */
export function resolvePacing(overrides?: PacingConfig): Record<PaceKind, PaceProfile> {
  const kinds: PaceKind[] = ["nav", "scroll", "read", "act"];
  const out = {} as Record<PaceKind, PaceProfile>;
  for (const kind of kinds) {
    const base = DEFAULT_PACING[kind];
    const over = overrides?.[kind];
    const profile: PaceProfile = {
      mean: over?.mean ?? base.mean,
      sd: over?.sd ?? base.sd,
      min: over?.min ?? base.min,
    };
    if (!(profile.min > 0)) {
      throw new Error(
        `lucarne-interact: pacing floor for "${kind}" must be > 0 (got ${profile.min}) — ` +
          `enforced pacing has no off switch.`,
      );
    }
    if (!(profile.mean >= 0) || !(profile.sd >= 0)) {
      throw new Error(`lucarne-interact: pacing "${kind}" mean/sd must be >= 0 (got mean=${profile.mean}, sd=${profile.sd})`);
    }
    out[kind] = profile;
  }
  return out;
}

/** Sample one dwell (ms) from a profile — the floored normal draw, ported from browser.ts:153-154. */
export function sampleDwellMs(profile: PaceProfile, rng: () => number = randn): number {
  if (!(profile.min > 0)) throw new Error(`pacing floor must be > 0 (got ${profile.min})`);
  return Math.round(Math.max(profile.min, profile.mean + profile.sd * rng()));
}

/** Sleep for one sampled dwell of the given kind, returning the number of ms actually paced. */
export async function pace(
  kind: PaceKind,
  table: Record<PaceKind, PaceProfile>,
  sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<number> {
  const ms = sampleDwellMs(table[kind]);
  await sleepFn(ms);
  return ms;
}

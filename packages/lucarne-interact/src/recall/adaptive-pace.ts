// Adaptive idle-backoff pacing for recall's poll loop — ported from cadence's `recall.ts:289-295`.
//
// NOTE: this is UNRELATED to `../pacing.ts` (the ACT half's enforced normal-distribution dwell
// after every verb, which exists to make agent actions look human-paced). Recall never acts, so it
// has nothing to pace in THAT sense — this is purely a resource-courtesy backoff: its SIG scan does
// one `page.evaluate` PER OPEN TAB every tick, which wakes every background renderer, so a fixed
// fast poll drags the whole machine once several tabs are open. Stay responsive while something is
// actually happening (a capture, a scroll, a video), back off geometrically when the screen is
// idle (capped at `idleMs`), and snap straight back to `activeMs` the instant activity resumes
// (the caller resets its own `idle` counter to 0 on any capture/change).
export interface AdaptivePaceConfig {
  activeMs: number;
  idleMs: number;
  growth: number;
}

export const DEFAULT_ADAPTIVE_PACE: Readonly<AdaptivePaceConfig> = Object.freeze({ activeMs: 500, idleMs: 2500, growth: 1.6 });

/** cadence's `pace()` (`recall.ts:295`): `Math.min(ACTIVE_MS * 1.6**idle, IDLE_MS)`. */
export function adaptivePaceMs(idle: number, cfg: AdaptivePaceConfig = DEFAULT_ADAPTIVE_PACE): number {
  return Math.min(cfg.activeMs * Math.pow(cfg.growth, Math.max(0, idle)), cfg.idleMs);
}

/** cadence's idle-counter cap (`recall.ts:402`: `else if (idle < 12) idle++`). */
export const IDLE_COUNTER_CAP = 12;

/** Bump the idle counter by one, capped — call on a tick where nothing changed. */
export function bumpIdle(idle: number, cap: number = IDLE_COUNTER_CAP): number {
  return idle < cap ? idle + 1 : idle;
}

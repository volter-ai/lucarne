// Yield-to-human decision logic — PURE, Chrome-free (no Playwright, no fetch, no browser).
//
// `InteractSession#type` yields the keyboard the moment a live human starts typing (cadence's
// `typeHuman`, browser.ts:184-195: "yield if the human grabs the wheel mid-type"). There are TWO
// possible sources for "is a human active right now", tried in order:
//
//   (a) PREFERRED — lucarne's own actor-tagged activity log: `GET /sessions/:id/activity` →
//       `now.lastHumanActionMsAgo` (ROADMAP.md §"Initiative II — Activity log", phase A3). This is
//       attributed AT THE SOURCE (porthole input = human, act()/CDP-driver = agent) — it can never
//       confuse our own keystrokes for a human's. `lucarne-interact` does not import the `lucarne`
//       engine package (peer-free posture), so this is wired by DUCK TYPING: a caller who has a real
//       lucarne session passes an `activity` accessor shaped like `LucarneClient#activity`/
//       `Lucarne#activityNow`'s return value.
//
//   (b) FALLBACK — the in-page `window.__lastInputAt` probe (cadence's browser.ts:186-190). This is
//       weaker: CDP-dispatched keystrokes (what `type()` itself uses) are indistinguishable from a
//       real human's at the DOM level (`isTrusted` is true for both), so a raw "ms since the page
//       last saw ANY input" would immediately yield to ITSELF. `session.ts` compensates by also
//       tracking the instant of its OWN last dispatched keystroke (`lastAgentInputAt`) and only
//       treating a page timestamp NEWER than that as human evidence (see `checkHumanYield` below).
//
// This module only decides, given already-gathered signals; it performs no I/O itself, which is
// what makes it fully unit-testable with mocks (no browser needed) — see test/yield.mjs.

/** Shape-compatible (duck-typed) subset of lucarne's `ActivityNow` (types.ts) — no import needed. */
export interface ActivityNowLike {
  lastHumanActionMsAgo?: number | null;
}

/** Shape-compatible (duck-typed) subset of `{ now, recent }` (lucarne's `GET /sessions/:id/activity`). */
export interface ActivitySnapshotLike {
  now?: ActivityNowLike | null;
}

/** Caller-supplied accessor for lucarne's actor-tagged activity — the PREFERRED probe path. */
export type ActivityProbe = () => Promise<ActivitySnapshotLike | null | undefined>;

/**
 * Caller-supplied accessor for the in-page `window.__lastInputAt` FALLBACK probe. Returns the raw
 * page-reported timestamp (epoch ms, `Date.now()`-comparable) the page last saw an input event, or
 * `null` if the page has never seen one (or the probe couldn't run — e.g. mid-navigation).
 */
export type InPageInputProbe = () => Promise<number | null>;

export type YieldProbePath = "activity" | "in-page" | "none";

export interface YieldCheckInput {
  /** Preferred probe (a). Omit when the session has no activity log available. */
  activityProbe?: ActivityProbe;
  /** Fallback probe (b). Omit only in tests that exercise path (a) in isolation. */
  inPageProbe?: InPageInputProbe;
  /**
   * The instant (epoch ms) of OUR OWN last dispatched keystroke, if any — used to disqualify the
   * in-page probe's own echo of that keystroke from counting as "a human". Irrelevant to path (a),
   * which is attributed at the source and never needs this.
   */
  lastAgentInputAt?: number;
  /** Below this many ms since the detected input, treat it as "a human is active right now". */
  thresholdMs: number;
  /** Injectable clock, for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface YieldCheckResult {
  /** True: a human appears to be active right now — the caller should abort/yield. */
  yield: boolean;
  /** ms since the detected human input, or null if no usable signal was found. */
  msAgo: number | null;
  /** Which probe path produced the decision (or "none" if neither yielded a signal). */
  path: YieldProbePath;
}

/** Decide whether to yield to a human, given whichever probe(s) are available. Pure — no I/O. */
export async function checkHumanYield(input: YieldCheckInput): Promise<YieldCheckResult> {
  const now = input.now ?? Date.now;

  // (a) PREFERRED — lucarne's actor-tagged activity, when the session exposes it.
  if (input.activityProbe) {
    try {
      const snap = await input.activityProbe();
      const msAgo = snap?.now?.lastHumanActionMsAgo;
      if (typeof msAgo === "number") {
        return { yield: msAgo < input.thresholdMs, msAgo, path: "activity" };
      }
    } catch {
      // no activity signal this round — fall through to the in-page probe
    }
  }

  // (b) FALLBACK — the in-page `window.__lastInputAt` probe (browser.ts:186-190).
  if (input.inPageProbe) {
    try {
      const pageTs = await input.inPageProbe();
      if (typeof pageTs === "number") {
        const agent = input.lastAgentInputAt ?? 0;
        // Only a page timestamp NEWER than our own last known keystroke is evidence of a human —
        // otherwise we would yield to the echo of our own last CDP-dispatched keystroke every time.
        if (pageTs <= agent) return { yield: false, msAgo: now() - pageTs, path: "in-page" };
        const msAgo = now() - pageTs;
        return { yield: msAgo < input.thresholdMs, msAgo, path: "in-page" };
      }
    } catch {
      // no in-page signal either
    }
  }

  return { yield: false, msAgo: null, path: "none" };
}

// presence.ts — the presence contract (LS-12): package-INTERNAL machinery where the ACT half of
// lucarne-interact (session.ts's verbs) records which browser target it is driving, and the
// OBSERVE half (recall, LS-13) reads that marker for actor attribution (`by: 'agent'|'human'`)
// and active-tab tie-breaking.
//
// This REPLACES cadence's `p === page` eval-server coupling (`cadence/src/recall.ts:74-78,81-86,
// 100`): the old code worked because the eval-server and recall ran INSIDE THE SAME playwright
// connection, so a live `Page` object literally WAS (or wasn't) the driven page — `p === page`
// was a legitimate identity check, and the "actor" stamp was just `driven ? 'agent' : 'human'`
// (`recall.ts:100`), used both for the +0.5 active-tab tie-break (`:78`) and the capture stamp
// (`:100`). LS-13's architecture gives recall its OWN CDP connection — "a second client of the
// same CDP endpoint" (the split spec's §1.6, and `cdp.ts`'s tap-sharing precedent) — so a
// DIFFERENT playwright connection means DIFFERENT `Page` object instances for the very same
// browser tab: object identity across connections is meaningless. A per-session marker keyed by
// the browser's own CDP `Target.targetId` (stable across every connection to that target) plus a
// staleness check is the connection-independent replacement.
//
// This module is also the SINGLE HOME for "is a human present right now" — the pure decision
// `yield.ts`'s `checkHumanYield` used to hold locally now lives here; `yield.ts` is a thin public
// re-export shim over it (LS-10's typing yield consumes this module's human-presence half; the
// driven-target marker + attribution below is this module's OTHER half, consumed by the verbs
// (write) and, from LS-13 on, recall (read)). Neither half performs I/O itself — everything here
// is pure/decision-only, which is what makes it fully Chrome-free unit-testable (test/presence.mjs).
//
// NOT exported from the package root (index.ts) — see test/presence-export-map.mjs (§2 LS-12 dev/02).

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Half A — the driven-target marker: WRITE (single writer, the verbs) + READ (actor attribution).
// ══════════════════════════════════════════════════════════════════════════════════════════════

/** The per-session marker the ACT half writes on every verb that resolves/acts on a page. */
export interface PresenceMarker {
  /** The browser's own CDP `Target.targetId` for the page a verb just acted on — connection-independent. */
  drivenTargetId: string;
  /** `Date.now()`-comparable instant the marker was last written. */
  ts: number;
}

/**
 * Default staleness window for attribution: a marker older than this is NOT "currently agent-
 * driven" even if its targetId still matches the observed tab — the agent may simply have stopped
 * acting (a human could since have taken that tab back). This is deliberately WIDER than typing's
 * yield threshold (1500ms, `browser.ts:189`): the enforced post-verb pace (`pacing.ts`) already
 * puts multi-second gaps BETWEEN legitimate agent actions, so a window narrower than the paced
 * action cadence would spuriously flip attribution to 'human' between the agent's own actions.
 */
export const DEFAULT_ATTRIBUTION_STALE_MS = 8000;

/**
 * Single-writer holder for the per-session driven-target marker. `InteractSession` owns exactly
 * one instance; every verb that touches a page calls `.record()` on it (session.ts).
 */
export class PresenceTracker {
  #marker: PresenceMarker | null = null;

  /** Write the marker: `drivenTargetId` is now the page the ACT half just acted on. */
  record(drivenTargetId: string, now: () => number = Date.now): PresenceMarker {
    this.#marker = { drivenTargetId, ts: now() };
    return this.#marker;
  }

  /** The current marker, or `null` before any verb has acted on a page. */
  get marker(): PresenceMarker | null {
    return this.#marker;
  }
}

export interface AttributionOptions {
  /** Marker older than this (ms) is treated as stale — attribution falls back to 'human'. Default 8000. */
  staleMs?: number;
  /** Injectable clock, for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface AttributionResult {
  /** 'agent' iff the observed target is the one the marker names AND the marker is fresh; else 'human'. */
  by: "agent" | "human";
  /** Whether the marker's targetId matches the observed target, independent of staleness. */
  driven: boolean;
  /** ms since the marker was last written, or `null` if there is no marker at all yet. */
  ageMs: number | null;
}

/**
 * The OBSERVE-half read: given the per-session marker and an observed target id, decide actor
 * attribution. Pure — no I/O — so it is directly unit-testable with a mock marker/clock (LS-12 dev/01).
 *
 * Ports recall's `driven: t === page` (`recall.ts:100`) + its `by: driven ? 'agent' : 'human'`
 * capture stamp: the identity check (`t === page`) becomes a targetId equality check (works
 * across separate connections), and a staleness threshold is added — the old code never needed
 * one, since object identity has no time axis; a per-session marker does.
 */
export function attributeActor(
  marker: PresenceMarker | null,
  observedTargetId: string,
  opts: AttributionOptions = {},
): AttributionResult {
  const now = opts.now ?? Date.now;
  const staleMs = opts.staleMs ?? DEFAULT_ATTRIBUTION_STALE_MS;
  if (!marker) return { by: "human", driven: false, ageMs: null };
  const driven = marker.drivenTargetId === observedTargetId;
  const ageMs = now() - marker.ts;
  const fresh = ageMs < staleMs;
  return { by: driven && fresh ? "agent" : "human", driven, ageMs };
}

/**
 * The tab TIE-BREAK bonus recall's active-tab scoring adds for the driven tab — the SIG script's
 * `+ (p === page ? 0.5 : 0)` (`recall.ts:78`) — expressed via the same fresh+driven check as
 * `attributeActor` so the two reads can never disagree about which tab is "the one being driven".
 * Recall (LS-13) adds this to its visibility/focus score; it only breaks ties between tabs that
 * are otherwise equally visible (recall.ts:75-77's comment — it never overrides a genuinely more
 * visible tab in the ordinary single-window case).
 */
export function presenceTieBreakBonus(
  marker: PresenceMarker | null,
  observedTargetId: string,
  opts: AttributionOptions = {},
): number {
  return attributeActor(marker, observedTargetId, opts).by === "agent" ? 0.5 : 0;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Half B — human presence: is a live human active right now? (moved here from yield.ts, LS-12;
// LS-10's `checkHumanYield`/`ActivityProbe` are now a thin public re-export — see yield.ts.)
// ══════════════════════════════════════════════════════════════════════════════════════════════
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
// This half only decides, given already-gathered signals; it performs no I/O itself.

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

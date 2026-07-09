// The recording-state contract (LS-14) — ported from the origin app's `recall-status.ts` (its own
// header: "THE recording-state contract. PURE (no fs/node imports) on purpose: this is the ONE
// vocabulary shared by the recorder (the writer), the bridge + CLI (backend readers), and the
// widget (frontend, bundled into the iframe by esbuild)"). Kept PURE here too — no `node:fs`/
// `node:child_process` import in this file — so a bundler can pull just this module into a
// browser/iframe context without dragging in the rest of `recall/` (the wire sensor, CDP,
// playwright-core, …). That purity is also why this is the ONE module re-exported at its OWN
// package subpath, `lucarne-interact/status`, rather than only through `lucarne-interact/recall`.
//
// Recording is FIVE ORTHOGONAL LAYERS, never one flat enum (a flat enum forces a baked priority
// that throws information away the moment two are true at once):
//
//   L1 · Control       should it record?              desired-state, owned by the human  → `enabled`
//   L2 · Liveness      is the recorder alive?          the `ts` stamp's freshness         → STALE_MS window
//   L3 · Observability can it see a page right now?    OBSERVE.*                          → published each tick
//   L4 · Activity      what is it doing this instant?  ACTIVITY.* (+ progress for video)  → published each tick
//   L5 · Events        what just happened?             the RecallSignal stream (`types.ts`) — a
//                      SEPARATE append-only channel (this package's `observers` hook / the summary
//                      layer, `summary.ts` — never re-derived from L1-L4).
//
// The recorder PUBLISHES L1-L4 as one status snapshot (`RecallStatusHolder#publish`/`#snapshot`).
// `displayState()` COMPOSES them into the single label a view shows — the ONE place precedence
// lives, derived from orthogonal truths rather than hidden inside an enum. The safety law (never
// falsely claim "recording") lives in that composition: a stale/absent snapshot can only ever read
// OFFLINE — see `displayState`'s first branch.
//
// WIRE THREADING (LS-14): the screen sensor publishes L3/L4 directly from its own loop
// (`index.ts`'s `status.publish({...})` calls) because it OWNS those layers' transitions tick by
// tick. The wire sensor (LS-13W, `wire.ts`) has no such loop — it's event-driven off CDP callbacks
// and, by design, never touches L3/L4 (a wire capture is not "the screen sensor's activity"). So it
// threads into status a DIFFERENT way: `index.ts`'s ONE observer chokepoint (`emit`, which every
// `RecallSignal` — capture, video, AND wire — already flows through) calls
// `RecallStatusHolder#recordSignal(signal)` on every signal, and this holder is the one place that
// turns a `kind:'wire'` signal into a running `wire` layer (cumulative capture count + last-activity
// timestamp) on the snapshot. Both sensors are covered from that ONE stream — the wire sensor itself
// stays exactly as ignorant of `status.ts` as it was before (no import added to `wire.ts`).
export type RecallObserveState = "ok" | "no_server" | "no_page";
export type RecallActivityState = "starting" | "idle" | "recording_video";

// ── L3: can the recorder observe a capturable page? (the origin app's `OBSERVE`) ──
export const OBSERVE = { OK: "ok", NO_SERVER: "no_server", NO_PAGE: "no_page" } as const satisfies Record<string, RecallObserveState>;
// ── L4: what the recorder's screen sensor is doing (only meaningful while enabled + alive +
//    observing) — the origin app's `ACTIVITY` ──
export const ACTIVITY = { STARTING: "starting", IDLE: "idle", RECORDING_VIDEO: "recording_video" } as const satisfies Record<string, RecallActivityState>;

// The COMPOSED, view-facing states — what the eye actually shows; exactly one at a time.
// Presentation (labels, colours) is the VIEW's concern and lives with the view; this is just the
// shared set of outcomes. Values kept BYTE-IDENTICAL to the origin app's own `DISPLAY` strings (its
// widget/CLI already render these) so a consumer built against that contract (LS-19) sees the same
// vocabulary out of this port.
export const DISPLAY = {
  OFFLINE: "offline", // L2 dead/stale — the recorder process is gone (or wedged). Trumps all (safety).
  OFF: "off", // L1 the human turned it off; the recorder is alive but deliberately dormant.
  RECONNECTING: "reconnecting", // L3 alive, but no page connection to read the page through.
  NO_PAGE: "no-page", // L3 alive + observing, but no capturable tab in focus.
  STARTING: "starting", // L4 booting (singleton lock / orphan sweep / media reconcile) before the loop.
  WATCHING: "watching", // L4 idle — up to date, watching for the next change. LIVE.
  RECORDING: "recording", // L4 recording a watched video (carries progress). LIVE.
} as const;

export type DisplayState = (typeof DISPLAY)[keyof typeof DISPLAY];

/** L2: a `ts` older than this ⇒ the recorder is gone (honest self-decay) — the origin app's `STALE_MS`. */
export const STALE_MS = 12000;

export interface RecallProgress {
  ct: number;
  dur: number | null;
}

/** L4-adjacent, WIRE-sensor-only counters (LS-14, LS-13W): threaded in via `recordSignal`, never via
 *  `publish` (the wire sensor has no per-tick loop to publish FROM — see this file's header). */
export interface RecallWireStatus {
  /** Total records added across every wire capture this process has made (cumulative). */
  captures: number;
  /** `now()` at the most recent wire capture, or `null` if the wire sensor hasn't captured yet. */
  lastAt: number | null;
}

export interface RecallStatusSnapshot {
  ts: number;
  enabled: boolean;
  observe: RecallObserveState;
  activity: RecallActivityState;
  progress: RecallProgress | null;
  since: number;
  /** The wire sensor's own layer (LS-14) — see this file's header ("WIRE THREADING"). Always
   *  present (never `undefined`) so a consumer can read `snapshot.wire.captures` unconditionally. */
  wire: RecallWireStatus;
}

export interface RecallStatusPatch {
  enabled?: boolean;
  observe?: RecallObserveState;
  activity?: RecallActivityState;
  progress?: RecallProgress | null;
}

/** The minimal signal shape `recordSignal` reads — structurally compatible with `types.ts`'s
 *  `RecallSignal` union without importing it (this file stays dependency-free/pure; see header). */
export interface RecallSignalLike {
  kind: string;
  recordsAdded?: number;
}

export class RecallStatusHolder {
  #observe: RecallObserveState = "ok";
  #activity: RecallActivityState = "starting";
  #progress: RecallProgress | null = null;
  #enabled = true;
  #since: number;
  #wireCaptures = 0;
  #wireLastAt: number | null = null;
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
    this.#since = now();
  }

  publish(patch: RecallStatusPatch = {}): RecallStatusSnapshot {
    if ("observe" in patch && patch.observe !== this.#observe) {
      this.#observe = patch.observe!;
      this.#since = this.#now();
    }
    if ("activity" in patch && patch.activity !== this.#activity) {
      this.#activity = patch.activity!;
      this.#since = this.#now();
    }
    if ("progress" in patch) this.#progress = patch.progress ?? null;
    if ("enabled" in patch) this.#enabled = !!patch.enabled;
    return this.snapshot();
  }

  /**
   * Thread a `RecallSignal` (LS-14) into status — the ONE place a `kind:'wire'` signal becomes a
   * status-visible fact, called from `index.ts`'s single observer chokepoint (`emit`) for EVERY
   * signal (capture/video/wire alike). `capture`/`video` signals are a no-op here: the screen sensor
   * already publishes its own L3/L4 transitions directly from its loop (`index.ts`), so re-deriving
   * them from the signal stream would be a second, potentially-inconsistent source of truth for the
   * same fact. Never throws (a signal this doesn't recognize is simply ignored).
   */
  recordSignal(signal: RecallSignalLike): RecallStatusSnapshot {
    if (signal.kind === "wire") {
      this.#wireCaptures += signal.recordsAdded ?? 0;
      this.#wireLastAt = this.#now();
    }
    return this.snapshot();
  }

  snapshot(): RecallStatusSnapshot {
    return {
      ts: this.#now(),
      enabled: this.#enabled,
      observe: this.#observe,
      activity: this.#activity,
      progress: this.#progress,
      since: this.#since,
      wire: { captures: this.#wireCaptures, lastAt: this.#wireLastAt },
    };
  }
}

/**
 * The permissive input shape `displayState`/`heldMs` accept — deliberately WIDER than
 * `RecallStatusSnapshot` (every field optional) because a caller may hand this a partial/corrupt
 * read (e.g. a snapshot deserialized from a persisted file, possibly absent or malformed) — ported
 * from the origin app's own `StatusSnapshot` (`recall-status.ts`), which is read off disk and so
 * makes the identical trust assumption.
 */
export interface DisplayableStatus {
  ts?: number;
  enabled?: boolean;
  observe?: RecallObserveState | string;
  activity?: RecallActivityState | string;
  progress?: RecallProgress | null;
  since?: number;
}

export interface DisplayResult {
  state: DisplayState;
  live: boolean;
  progress?: RecallProgress | null;
}

/**
 * COMPOSE the layers into one display state. `live` = actively recording the screen (the green
 * privacy dot). Precedence, top to bottom: liveness (safety) → control → observability → activity.
 * Pure + deterministic, so every surface (eye, pill, capture face, a `recall status` CLI) renders
 * identically off the same snapshot. Ported verbatim (branch-for-branch) from the origin app's
 * `displayState` (`recall-status.ts:44-52`) — this is the STALENESS LAW: a stale or absent snapshot
 * can ONLY ever read OFFLINE, even if it claims `activity: 'recording_video'` — a wedged/dead
 * recorder must never be shown as live.
 */
export function displayState(status: DisplayableStatus | null | undefined, now: number, staleMs: number = STALE_MS): DisplayResult {
  if (!status || !status.ts || !(now - status.ts < staleMs)) return { state: DISPLAY.OFFLINE, live: false };
  if (status.enabled === false) return { state: DISPLAY.OFF, live: false };
  if (status.observe === OBSERVE.NO_SERVER) return { state: DISPLAY.RECONNECTING, live: false };
  if (status.observe === OBSERVE.NO_PAGE) return { state: DISPLAY.NO_PAGE, live: false };
  if (status.activity === ACTIVITY.STARTING) return { state: DISPLAY.STARTING, live: false };
  if (status.activity === ACTIVITY.RECORDING_VIDEO) return { state: DISPLAY.RECORDING, live: true, progress: status.progress ?? null };
  return { state: DISPLAY.WATCHING, live: true }; // ACTIVITY.IDLE — up to date, watching for the next change
}

/** How long the current state has held (for "reconnecting for 8s"-style honesty); `null` when
 *  unknown. Ported verbatim from the origin app's `heldMs` (`recall-status.ts:55`). */
export function heldMs(status: DisplayableStatus | null | undefined, now: number): number | null {
  return status && status.since ? Math.max(0, now - status.since) : null;
}

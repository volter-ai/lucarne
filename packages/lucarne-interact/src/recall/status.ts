// The publish chokepoint — ported (as an in-memory, package-internal holder) from cadence's single
// status-writing site (`recall.ts:296-311`). Every loop branch in `index.ts` transitions through
// `RecallStatusHolder#publish`, so the recorder's actual-state is never implicit in control flow.
// `since` is stamped ONLY when `observe`/`activity` actually CHANGE (cadence's own rule) so a
// consumer can tell "freshly transitioned" from "been like this a while" (the never-falsely-claim-
// recording staleness law LS-14's `displayState` builds on).
//
// NOTE for LS-14: this is deliberately a SMALL, in-memory stand-in for cadence's full five-layer
// on-disk contract (`recall-status.ts`'s `OBSERVE`/`ACTIVITY` enums + `displayState`, re-exported
// as `lucarne-interact/status`). LS-13 only needs enough of a publish chokepoint to (a) hold state
// between loop ticks and (b) give `startRecall`'s returned handle something to report — LS-14 owns
// widening this into the real public contract (this holder's shape is intentionally close to it so
// that swap is additive, not a rewrite).
export type RecallObserveState = "ok" | "no_server" | "no_page";
export type RecallActivityState = "starting" | "idle" | "recording_video";

export interface RecallProgress {
  ct: number;
  dur: number | null;
}

export interface RecallStatusSnapshot {
  ts: number;
  enabled: boolean;
  observe: RecallObserveState;
  activity: RecallActivityState;
  progress: RecallProgress | null;
  since: number;
}

export interface RecallStatusPatch {
  enabled?: boolean;
  observe?: RecallObserveState;
  activity?: RecallActivityState;
  progress?: RecallProgress | null;
}

export class RecallStatusHolder {
  #observe: RecallObserveState = "ok";
  #activity: RecallActivityState = "starting";
  #progress: RecallProgress | null = null;
  #enabled = true;
  #since: number;
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

  snapshot(): RecallStatusSnapshot {
    return { ts: this.#now(), enabled: this.#enabled, observe: this.#observe, activity: this.#activity, progress: this.#progress, since: this.#since };
  }
}

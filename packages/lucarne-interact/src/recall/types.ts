// Recall's public shared types (LS-13) — the SCREEN sensor's plugin contracts + emitted signal
// shape. Kept in one file so `index.ts` and its sibling modules (tab-scoring, capture, video-watch,
// …) share one vocabulary without a circular import.
import type { Capture, Entity } from "lucarne-records";

/**
 * A per-site extractor PLUGIN — cadence passes LS-05's X ARIA extractor
 * (`lucarne-records/sites`'s `xAriaExtractor`) as one of these. `match` decides whether this
 * extractor understands a given page url; `extract` is PURE (text in, records out — no
 * filesystem/network/DOM access of its own; see `lucarne-records/sites/x-aria.ts`'s header).
 */
export interface RecallExtractor {
  match(url: string): boolean;
  extract(aria: string, capture: Capture): Entity[];
}

/** Who was driving the session when a capture happened (LS-12's `attributeActor` output). */
export type RecallActor = "agent" | "human";

/** Why a static capture fired — cadence's `captureStatic`/change-classification categories (recall.ts:392-397). */
export type RecallCaptureReason = "initial" | "navigated" | "new-content" | "scrolled" | "changed";

/** Why a watched-video recording stopped (recall.ts:219-236's `reason`). */
export type RecallVideoStopReason = "ended" | "looped" | "looked-away" | "cap" | "gone" | "paused";

/** A durable, structured event recall emits for every capture/video it makes — the thing an
 *  `observers` hook (or a future summary pass, LS-14) consumes instead of parsing a raw log. */
export type RecallSignal =
  | {
      kind: "capture";
      ts: string;
      url: string;
      title: string;
      reason: RecallCaptureReason;
      detail: string | null;
      by: RecallActor;
      recordsAdded: number;
      ariaFile: string;
      screenshotFile: string;
    }
  | {
      kind: "video";
      ts: string;
      url: string;
      by: RecallActor;
      stopReason: RecallVideoStopReason;
      mp4: string | null;
      watchedRange: [number, number];
      frames: number;
    };

export type RecallObserverFn = (signal: RecallSignal) => void;

/** Caller-supplied read of the DELIBERATE on/off toggle (cadence's widget switch, e.g.). Recall
 *  never turns itself off — this is only ever a caller's own external state recall OBEYS. Absent
 *  `isEnabled` (or no `toggles` at all) means "always enabled", matching cadence's default-ON law. */
export interface RecallToggles {
  isEnabled?(): boolean;
}

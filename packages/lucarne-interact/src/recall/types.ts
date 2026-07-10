// Recall's public shared types (LS-13) — the SCREEN sensor's plugin contracts + emitted signal
// shape. Kept in one file so `index.ts` and its sibling modules (tab-scoring, capture, video-watch,
// …) share one vocabulary without a circular import.
import type { Capture, Entity } from "lucarne-records";
import type { MediaBox } from "./dom-probes.js";

/**
 * A per-site extractor PLUGIN — a caller passes its own site-specific ARIA extractor (e.g. an X
 * extractor, LS-05) as one of these; this package bundles none of its own (LS-29 — site-specific
 * extractors live downstream, in a domain package). `match` decides whether this extractor
 * understands a given page url; `extract` is PURE (text in, records out — no filesystem/network/DOM
 * access of its own).
 */
export interface RecallExtractor {
  match(url: string): boolean;
  extract(aria: string, capture: Capture): Entity[];
}

/** Who was driving the session when a capture happened (LS-12's `attributeActor` output). */
export type RecallActor = "agent" | "human";

/** Why a static capture fired — the origin app's `captureStatic`/change-classification categories (recall.ts:392-397). */
export type RecallCaptureReason = "initial" | "navigated" | "new-content" | "scrolled" | "changed";

/** Why a watched-video recording stopped (recall.ts:219-236's `reason`). */
export type RecallVideoStopReason = "ended" | "looped" | "looked-away" | "cap" | "gone" | "paused";

/** A durable, structured event recall emits for every capture/video/wire-response it makes — the
 *  thing an `observers` hook (or a future summary pass, LS-14) consumes instead of parsing a raw
 *  log. Both sensors (screen + wire, LS-13W) publish through this ONE union so a consumer never
 *  needs to know which sensor produced a given signal to observe the recorder as a whole. */
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
    }
  | {
      /** The WIRE sensor (LS-13W): a passively CDP-captured GraphQL response was parsed into one or
       *  more `via:'internal-api'` records. `url` is the response's OWN request url (query string
       *  included) — never a url this recorder requested itself. */
      kind: "wire";
      ts: string;
      url: string;
      recordsAdded: number;
    };

export type RecallObserverFn = (signal: RecallSignal) => void;

/**
 * Pluggable per-page DOM probes (LS-32) — the SCREEN sensor's media-crop / viewport-honesty /
 * thread-root / title-cleaning / signature plugins, alongside `RecallExtractor`/`WireSiteAdapter`
 * above. This package bundles NONE of these by default (same LS-29 posture as extractors/wire
 * adapters — no site-specific DOM shape lives in this package); a caller wanting media crops,
 * viewport-honesty filtering, thread-root detection, or a site-cleaned display title passes its own
 * domain's implementation (e.g. a downstream X package's `xMediaProbe`/`xVisibleProbe`/
 * `xRootIdFromUrl`/`xCleanTitle`). Every field is OPTIONAL and defaults to a safe, domain-agnostic
 * no-op — recall degrades to "no crops, no viewport filtering, no thread-root, plain titles" rather
 * than silently assuming any particular site's markup.
 */
export interface RecallPageProbes {
  /** In-page, `page.evaluate`-run function returning this tick's on-screen media bounding boxes
   *  (READ-ONLY DOM reads — see `dom-probes.ts`'s header). Must be self-contained/serializable, same
   *  law as `extractors`. Absent → no crops (`[]`). */
  mediaProbe?: () => MediaBox[];
  /** In-page, `page.evaluate`-run function returning which post/record ids were genuinely on
   *  screen this tick. Absent → `[]`, which `filterVisibleRecords` already treats as "don't
   *  filter" — the correct non-social default (nothing to honestly clip against). */
  visibleProbe?: () => string[];
  /** Node-side, pure: recover a thread/root id from the CAPTURING page's own url, so
   *  `filterVisibleRecords` never drops an off-screen thread root, and so the screen loop can skip
   *  its blocking video-watch branch on a thread page. Absent → `() => null` (no thread model —
   *  nothing is ever treated as an always-kept root, and the video-watch branch is never skipped on
   *  this account). */
  rootIdFromUrl?: (url: string) => string | null;
  /** Node-side, pure: clean a raw page/document title before the summary layer's length cap.
   *  Absent → pass-through (only the length cap applies). */
  cleanTitle?: (title: string) => string;
  /** CSS selector `tabSignatureProbe` reads its `firstText` change-detection field from. Absent →
   *  the probe skips `firstText` entirely (returns `""`) rather than guessing a site's markup. */
  signatureSelector?: string;
}

/** Caller-supplied read of the DELIBERATE on/off toggle (the origin app's widget switch, e.g.). Recall
 *  never turns itself off — this is only ever a caller's own external state recall OBEYS. Absent
 *  `isEnabled` (or no `toggles` at all) means "always enabled", matching the origin app's default-ON law. */
export interface RecallToggles {
  isEnabled?(): boolean;
  /** Same contract as `isEnabled`, scoped to the WIRE sensor (LS-13W) alone — a caller that wants
   *  the screen sensor running without the wire sensor (or vice versa) can differentiate; absent
   *  means "same as `isEnabled`" (both sensors default ON together). */
  isWireEnabled?(): boolean;
}

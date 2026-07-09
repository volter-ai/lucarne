// Viewport-honesty filter — "recall of what was ON SCREEN", not the whole virtualized DOM.
//
// X (and similar virtualized feeds) keep a BUFFER of posts above/below the viewport in the DOM, so
// an ARIA snapshot of the whole body includes posts the viewer never actually SAW. Ported from
// cadence's `recall.ts:178-185`: keep only records whose id was reported as meaningfully on-screen
// by the SAME-instant `VISIBLE_PROBE` (`recall.ts:127-139`, ≥120px of the element's height inside
// the viewport — see `recall/dom-probes.ts`), except the thread ROOT post, which always counts
// even when scrolled above the viewport (dropping it would orphan every comment recorded under
// it — "the bug behind ~⅓ of recorded comments dangling", `recall.ts:180-181`).
//
// Pure — no I/O — so it's directly unit-testable against fixture records + fixture id lists
// (test/recall-visible-filter.mjs).
import type { Entity } from "lucarne-records";

/**
 * Keep only `records` whose `provenance.id` is in `visibleIds`, plus any record whose id equals
 * `rootId` (the thread root, always kept). An EMPTY `visibleIds` means "don't filter" — cadence's
 * own safety valve (`recall.ts:182`: "a non-feed page or a glitch shouldn't silently drop
 * everything").
 */
export function filterVisibleRecords(records: readonly Entity[], visibleIds: readonly string[], rootId: string | null = null): Entity[] {
  if (!visibleIds.length) return [...records];
  const visSet = new Set(visibleIds);
  return records.filter((r) => r.provenance.id === rootId || visSet.has(r.provenance.id));
}

/** Extract the thread-root id from a page url (cadence's `recall.ts:183`: `/status/(\d+)` on the
 *  CAPTURING page's own url). Generalizable per-site later; x's thread model is what recall's
 *  viewport-honesty logic was built against (same source lines the split spec cites). */
export function rootIdFromUrl(url: string | null | undefined): string | null {
  const m = String(url || "").match(/\/status\/(\d+)/);
  return m ? m[1]! : null;
}

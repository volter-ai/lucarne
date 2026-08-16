// Viewport-honesty filter — "recall of what was ON SCREEN", not the whole virtualized DOM.
//
// Virtualized feeds (X and similar) keep a BUFFER of posts above/below the viewport in the DOM, so
// an ARIA snapshot of the whole body includes posts the viewer never actually SAW. Ported from
// the origin app's `recall.ts:178-185`: keep only records whose id was reported as meaningfully
// on-screen by the SAME-instant visibility probe (a caller's own `RecallPageProbes.visibleProbe`,
// `types.ts` — LS-32 made this pluggable, moving the concrete DOM query downstream), except the
// thread ROOT post, which always counts even when scrolled above the viewport (dropping it would
// orphan every comment recorded under it — "the bug behind ~⅓ of recorded comments dangling",
// `recall.ts:180-181`). The root id itself comes from a caller's own
// `RecallPageProbes.rootIdFromUrl` (also LS-32-pluggable) — this file no longer knows or cares how
// a root id is derived from a url, only how to honor one once given.
//
// Pure — no I/O — so it's directly unit-testable against fixture records + fixture id lists
// (test/recall-visible-filter.mjs).
import type { Entity } from "../records/index.js";

/**
 * Keep only `records` whose `provenance.id` is in `visibleIds`, plus any record whose id equals
 * `rootId` (the thread root, always kept). An EMPTY `visibleIds` means "don't filter" — the origin app's
 * own safety valve (`recall.ts:182`: "a non-feed page or a glitch shouldn't silently drop
 * everything") — which is ALSO the correct default for a caller that supplies no `visibleProbe` at
 * all (LS-32): no probe output means nothing to honestly clip against.
 */
export function filterVisibleRecords(records: readonly Entity[], visibleIds: readonly string[], rootId: string | null = null): Entity[] {
  if (!visibleIds.length) return [...records];
  const visSet = new Set(visibleIds);
  return records.filter((r) => r.provenance.id === rootId || visSet.has(r.provenance.id));
}

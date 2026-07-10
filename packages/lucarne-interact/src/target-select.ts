// LS-27 — the pure, Chrome-free target-SELECTION logic behind InteractSession's per-tab targeting
// (`#page()`/`useTarget`/`{ targetId }`, session.ts). Factored out of session.ts so the matching
// RULE itself is unit-testable without a live CDP round trip (test/target-select.mjs); session.ts's
// own use of it (a real Playwright `Page` resolved to a real CDP `Target.targetId` via the cached
// `#targetIdFor`) is exercised end-to-end by the Chrome-gated acceptance suite instead
// (test/multitab-acceptance.mjs, `npm run test:acceptance`).

/**
 * Pick which page a verb should act on, given a (possibly unset) bound target id:
 *  - `targetId` is set AND some page's resolved id matches it → that page.
 *  - `targetId` is unset (`null`/`undefined`), OR set but no page matches (e.g. that tab was
 *    closed) → `pages[0]` — the exact, unconditional fallback `InteractSession` used before
 *    per-tab targeting existed (LS-09..LS-26). This is what keeps an unbound (or stale-bound)
 *    session's behavior IDENTICAL to today's: backward compatible by construction, not by a
 *    separate code path.
 *
 * `resolveId` is injected (rather than baked into this function) so this stays browser-free to
 * test: session.ts passes its cached CDP `Target.targetId` lookup (`#targetIdFor`, one real CDP
 * round trip per Page, memoized); a unit test passes a synchronous mock. Generic over `P` so the
 * unit test can use plain `{ id: string }` fixtures instead of real Playwright `Page` objects.
 */
export async function selectPage<P>(
  pages: readonly P[],
  targetId: string | null | undefined,
  resolveId: (page: P) => Promise<string> | string,
): Promise<P | undefined> {
  if (targetId) {
    for (const p of pages) {
      if ((await resolveId(p)) === targetId) return p;
    }
    // bound target not found among the current pages (closed, or never existed here) — fall
    // through to the same unconditional default an unbound session uses.
  }
  return pages[0];
}

// LS-27 dev/01 — the per-tab target-SELECTION logic behind InteractSession's multi-tab targeting
// (Chrome-free). Proves the pure `selectPage` (target-select.ts) that `session.ts#resolvePage`
// delegates to: a bound target id picks the matching page; unbound (or a stale/closed bound id)
// falls back to `pages[0]` — the EXACT, unconditional default `InteractSession` used before
// per-tab targeting existed, so an unbound session's behavior is provably unchanged. No Playwright,
// no CDP, no browser — plain mock "page" objects with an injected id resolver, so this runs
// entirely offline. The real CDP-backed wiring (a live Playwright `Page` resolved to a real
// `Target.targetId` via `#targetIdFor`, and `useTarget`/`{ targetId }` actually redirecting
// snap/type/send/capture to the right real tab) is exercised end-to-end by the Chrome-gated
// test/multitab-acceptance.mjs (`npm run test:acceptance`).
//
// Run with `node test/target-select.mjs` (no build required for this file's own logic, but it
// imports the compiled module — run `npm run build` first, same as every other test/*.mjs here).
import { selectPage } from "../dist/target-select.js";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const pageA = { id: "A" };
const pageB = { id: "B" };
const pageC = { id: "C" };
const pages = [pageA, pageB, pageC];
const resolveId = (p) => p.id; // sync resolver — selectPage must accept either sync or async

// ── bound to a NON-first tab: picks that tab, not pages[0] ──
{
  const picked = await selectPage(pages, "B", resolveId);
  check("bound targetId picks the matching page (not pages[0])", picked === pageB, JSON.stringify(picked));
}

// ── bound to the first tab explicitly: still resolves correctly (not a "must not be index 0" rule) ──
{
  const picked = await selectPage(pages, "A", resolveId);
  check("bound targetId matching pages[0] still resolves to it", picked === pageA);
}

// ── unbound: undefined ──
{
  const picked = await selectPage(pages, undefined, resolveId);
  check("unbound (undefined) falls back to pages[0] — today's original default", picked === pageA);
}

// ── unbound: null ──
{
  const picked = await selectPage(pages, null, resolveId);
  check("unbound (null) falls back to pages[0]", picked === pageA);
}

// ── unbound: empty string treated as falsy/unset (mirrors `targetId ?? undefined` in useTarget(null)) ──
{
  const picked = await selectPage(pages, "", resolveId);
  check("empty-string targetId treated as unbound, falls back to pages[0]", picked === pageA);
}

// ── bound to a STALE id (that tab closed / never existed here): falls back to pages[0], same as unbound ──
{
  const picked = await selectPage(pages, "nonexistent-target-id", resolveId);
  check("stale/unmatched bound targetId falls back to pages[0] (same as unbound)", picked === pageA);
}

// ── no pages at all: bound or not, returns undefined (caller's job to ctx.newPage()) ──
{
  const pickedBound = await selectPage([], "B", resolveId);
  const pickedUnbound = await selectPage([], undefined, resolveId);
  check("empty pages + bound → undefined (caller creates a new page)", pickedBound === undefined);
  check("empty pages + unbound → undefined (caller creates a new page)", pickedUnbound === undefined);
}

// ── resolveId may be ASYNC (session.ts's real #targetIdFor is: one memoized CDP round trip) ──
{
  const asyncResolveId = async (p) => {
    await new Promise((r) => setTimeout(r, 1));
    return p.id;
  };
  const picked = await selectPage(pages, "C", asyncResolveId);
  check("selectPage works with an async id resolver (session.ts's real #targetIdFor shape)", picked === pageC);
}

// ── selector never scans past a match it doesn't need to reach (documents the intended short-circuit,
// not a hard perf requirement) ──
{
  let calls = 0;
  const countingResolve = (p) => {
    calls++;
    return p.id;
  };
  await selectPage(pages, "A", countingResolve);
  check("resolves no more pages than necessary to find a match at pages[0]", calls === 1, `calls=${calls}`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.error(`FAILED: ${failed.map((f) => f.name).join(", ")}`);
  process.exit(1);
}

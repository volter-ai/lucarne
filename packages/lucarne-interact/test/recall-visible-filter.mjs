// LS-13 dev/01's viewport-honesty half (Chrome-free): `filterVisibleRecords` drops the
// off-viewport buffer a virtualized feed keeps in the DOM but always keeps the thread root —
// ported from cadence's `recall.ts:178-185`. LS-32: the thread-root-id extraction (formerly this
// file's own `rootIdFromUrl`) moved downstream — a domain package's own `xRootIdFromUrl`, injected
// via `RecallPageProbes.rootIdFromUrl` (see test/recall-probes-pluggable.mjs) — so this file only
// exercises the pure, domain-agnostic filter itself; `rootId` below is a plain fixture string.
//
// Run with `node test/recall-visible-filter.mjs` (after `npm run build`).
import { filterVisibleRecords } from "../dist/recall/visible-filter.js";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const rec = (id) => ({ kind: "post", provenance: { source: "x", id, canonicalUrl: `https://x.com/i/status/${id}`, fetchedAt: "2026-01-01T00:00:00.000Z", via: "screen" }, author: { handle: "a", profileUrl: "https://x.com/a" }, text: `post ${id}`, metrics: {} });

{
  const records = [rec("1"), rec("2"), rec("3")];
  const filtered = filterVisibleRecords(records, ["2"], null);
  check("keeps only the visible id when there's no root", filtered.length === 1 && filtered[0].provenance.id === "2", JSON.stringify(filtered.map((r) => r.provenance.id)));
}
{
  // The thread ROOT is kept even when it's NOT in the visible set (scrolled above the viewport) —
  // dropping it would orphan every comment recorded under it.
  const records = [rec("100"), rec("2"), rec("3")]; // "100" is the root, off-screen
  const filtered = filterVisibleRecords(records, ["2", "3"], "100");
  const ids = filtered.map((r) => r.provenance.id).sort();
  check("keeps the off-screen thread ROOT plus the visible set", JSON.stringify(ids) === JSON.stringify(["100", "2", "3"]), JSON.stringify(ids));
}
{
  // An off-screen, non-root post is dropped.
  const records = [rec("100"), rec("2"), rec("999")]; // "999" is buffered off-screen, not the root
  const filtered = filterVisibleRecords(records, ["2"], "100");
  const ids = filtered.map((r) => r.provenance.id).sort();
  check("drops an off-screen buffer post that is neither visible nor the root", JSON.stringify(ids) === JSON.stringify(["100", "2"]), JSON.stringify(ids));
}
{
  // EMPTY visible set -> don't filter (a non-feed page or a glitch shouldn't silently drop everything).
  const records = [rec("1"), rec("2")];
  const filtered = filterVisibleRecords(records, [], null);
  check("empty visibleIds -> no filtering applied (safety valve)", filtered.length === 2, JSON.stringify(filtered.map((r) => r.provenance.id)));
}
{
  const filtered = filterVisibleRecords([], ["1"], null);
  check("empty records array -> empty result, no throw", Array.isArray(filtered) && filtered.length === 0);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

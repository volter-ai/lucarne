// LS-13 dev — the extractor-plugin dispatch (Chrome-free): "extractors are plugins ({match,
// extract})" — a caller passes its own site-specific extractor (e.g. cadence passes its X ARIA
// extractor). `dispatchExtractors` is the PURE selection loop `runStaticCapture` (capture.ts) runs
// against a live page's ARIA text; exercised here directly against fixture strings — both a
// hand-rolled fake extractor (the dispatch LOGIC proof) and a small GENERIC local fixture extractor
// (the whole screen-sensor pipeline proof: match -> extract -> viewport-filter) — without ever
// touching a browser.
//
// LS-29 (generalize-records): this package no longer depends on any site-specific parser
// (`lucarne-records`' X ARIA extractor moved downstream to a domain package) — the "real extractor"
// half of this test now uses a small, fully LOCAL, generic fixture extractor (source:"example"-shaped
// records) instead of importing an X-specific one. The X-specific version of this proof (driving the
// actual `xAriaExtractor`) now lives in the domain package's own test suite.
//
// LS-32: `rootIdFromUrl` is no longer this package's own export (it moved downstream, injected via
// `RecallPageProbes.rootIdFromUrl`) — the "root id recovered from the capturing page's url" half of
// this test now uses a small LOCAL fixture function of the same shape, standing in for a caller's
// own probe exactly the way the fixture extractor above stands in for a caller's own extractor.
//
// Run with `node test/recall-extractor-dispatch.mjs` (after `npm run build`).
import { dispatchExtractors } from "../dist/recall/capture.js";
import { filterVisibleRecords } from "../dist/recall/visible-filter.js";

/** A LOCAL fixture standing in for a caller's own `RecallPageProbes.rootIdFromUrl` (e.g. a domain
 *  package's `xRootIdFromUrl`) — recovers a bare id from a `/status/<id>`-shaped url. Generic
 *  test-only fixture, not a package export. */
const fixtureRootIdFromUrl = (url) => {
  const m = String(url || "").match(/\/status\/(\d+)/);
  return m ? m[1] : null;
};

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// ── A. dispatch LOGIC with fake extractors: match-gated, concatenating, error-isolating ──
{
  const fakeCapture = { page: "https://example.test/", ts: "2026-01-01T00:00:00.000Z", reason: "initial", by: "human" };
  const onlyExample = { match: (url) => url.includes("example.test"), extract: () => [{ tag: "from-example" }] };
  const onlyOther = { match: (url) => url.includes("other.test"), extract: () => [{ tag: "from-other" }] };
  const out = dispatchExtractors("https://example.test/", "aria text", fakeCapture, [onlyExample, onlyOther]);
  check("dispatchExtractors: only the MATCHING extractor's records are included", out.length === 1 && out[0].tag === "from-example", JSON.stringify(out));

  const bothMatch = { match: () => true, extract: () => [{ tag: "a" }] };
  const bothMatch2 = { match: () => true, extract: () => [{ tag: "b" }] };
  const concatenated = dispatchExtractors("u", "a", fakeCapture, [bothMatch, bothMatch2]);
  check("dispatchExtractors: multiple matching extractors' records are CONCATENATED", concatenated.length === 2 && concatenated.map((r) => r.tag).sort().join(",") === "a,b");

  const throwing = { match: () => true, extract: () => { throw new Error("boom"); } };
  const survivor = { match: () => true, extract: () => [{ tag: "survivor" }] };
  const isolated = dispatchExtractors("u", "a", fakeCapture, [throwing, survivor]);
  check("dispatchExtractors: a THROWING extractor never breaks the capture or its siblings", isolated.length === 1 && isolated[0].tag === "survivor", JSON.stringify(isolated));

  const none = dispatchExtractors("https://nowhere.test/", "a", fakeCapture, [onlyExample, onlyOther]);
  check("dispatchExtractors: no extractor matches -> empty array, no throw", Array.isArray(none) && none.length === 0);

  const empty = dispatchExtractors("https://example.test/", "a", fakeCapture, []);
  check("dispatchExtractors: an empty extractor list -> empty array", empty.length === 0);
}

// ── B. a GENERIC local fixture extractor end-to-end (match + extract + viewport-filter), no Chrome,
//    no site-specific parser dependency — proves the whole screen-sensor pipeline generically ──
{
  // A tiny, deliberately simple line-oriented parser: `#<id> root|reply: <text>` lines, mirroring the
  // SHAPE of a real ARIA-snapshot extractor (root vs reply, an id, verbatim text) without depending
  // on any site's actual markup convention.
  function extractExampleRecords(aria, capture = {}) {
    const out = [];
    for (const line of String(aria || "").split("\n")) {
      const m = line.match(/^#(\S+)\s+(root|reply):\s*(.*)$/);
      if (!m) continue;
      const [, id, kindWord, text] = m;
      out.push({
        kind: kindWord === "root" ? "post" : "comment",
        provenance: { source: "example", id, canonicalUrl: `https://example.test/status/${id}`, fetchedAt: "2026-01-01T00:00:00.000Z", via: "screen" },
        text,
        metrics: {},
        capture,
      });
    }
    return out;
  }
  const exampleExtractor = { match: (url) => String(url || "").includes("example.test"), extract: extractExampleRecords };

  check("exampleExtractor.match: recognizes example.test urls", exampleExtractor.match("https://example.test/paulg/status/123"));
  check("exampleExtractor.match: rejects an unrelated url", exampleExtractor.match("https://nowhere.test/x") === false);

  const ROOT_SID = "1234567890123456789";
  const REPLY_SID = "4444444444444444444";
  const aria = [`#${ROOT_SID} root: hello from the root post`, `#${REPLY_SID} reply: a genuine reply`].join("\n");
  const url = `https://example.test/paulg/status/${ROOT_SID}`;
  const capture = { page: url, from: "aria/2026-01-01.txt", screenshot: "view/2026-01-01.png", ts: "2026-01-01T00:00:00.000Z", reason: "navigated", by: "agent" };

  const dispatched = dispatchExtractors(url, aria, capture, [exampleExtractor]);
  check("dispatchExtractors + exampleExtractor: produces one post + one comment", dispatched.length === 2, `got ${dispatched.length}`);
  check("every dispatched record carries provenance.via:'screen'", dispatched.every((r) => r.provenance.via === "screen"), JSON.stringify(dispatched.map((r) => r.provenance.via)));
  check("every dispatched record's capture.by matches what recall stamped ('agent')", dispatched.every((r) => r.capture?.by === "agent"));

  const rootId = fixtureRootIdFromUrl(url);
  // fixtureRootIdFromUrl matches `/status/(\d+)` — a generic-enough convention this package's
  // viewport filter still honors regardless of which domain's probe produced the root id.
  check("a caller's rootIdFromUrl probe recovers the thread root's bare sid from the capturing page's url", rootId === ROOT_SID);

  // Viewport-honesty: only the REPLY was reported visible this tick; the root (off-screen, but the
  // thread root) must still survive the filter, matching capture.ts's own pipeline order.
  const filtered = filterVisibleRecords(dispatched, [REPLY_SID], rootId);
  const ids = filtered.map((r) => r.provenance.id).sort();
  check("viewport-honesty filter: keeps the visible comment AND the off-screen thread root", JSON.stringify(ids) === JSON.stringify([REPLY_SID, ROOT_SID].sort()), JSON.stringify(ids));
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

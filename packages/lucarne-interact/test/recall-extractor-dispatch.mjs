// LS-13 dev — the extractor-plugin dispatch (Chrome-free): "extractors are plugins ({match,
// extract})" — cadence passes LS-05's X ARIA extractor. `dispatchExtractors` is the PURE selection
// loop `runStaticCapture` (capture.ts) runs against a live page's ARIA text; here it's exercised
// directly against fixture strings, plus the REAL `xAriaExtractor` from `lucarne-records/sites` to
// prove the whole screen-sensor pipeline (match -> extract -> viewport-filter) produces genuine
// `via:'screen'` records without ever touching a browser.
//
// Run with `node test/recall-extractor-dispatch.mjs` (after `npm run build` in BOTH this package
// and lucarne-records).
import { dispatchExtractors } from "../dist/recall/capture.js";
import { filterVisibleRecords, rootIdFromUrl } from "../dist/recall/visible-filter.js";
import { xAriaExtractor } from "lucarne-records";

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

// ── B. the REAL xAriaExtractor end-to-end (match + extract + viewport-filter), no Chrome ──
{
  check("xAriaExtractor.match: recognizes x.com/twitter.com urls", xAriaExtractor.match("https://x.com/paulg/status/123") && xAriaExtractor.match("https://twitter.com/home"));
  check("xAriaExtractor.match: rejects an unrelated url", xAriaExtractor.match("https://reddit.com/r/programming") === false);

  const ROOT_SID = "1234567890123456789";
  const REPLY_SID = "4444444444444444444";
  const rootBlock = [
    '- article "Paul Graham @paulg · Jul 1":',
    '  - link "9:00 AM":',
    `    - /url: /paulg/status/${ROOT_SID}`,
    '  - text: "hello from the root post"',
    '  - group "1 replies, 0 reposts, 5 likes":',
  ];
  const replyBlock = [
    '- article "Jane Doe @janedoe · Jul 1":',
    '  - link "10:00 AM":',
    `    - /url: /janedoe/status/${REPLY_SID}`,
    '  - text: "a genuine reply"',
    '  - group "0 replies, 0 reposts, 1 likes":',
  ];
  const aria = [...rootBlock, ...replyBlock].join("\n");
  const url = `https://x.com/paulg/status/${ROOT_SID}`;
  const capture = { page: url, from: "aria/2026-01-01.txt", screenshot: "view/2026-01-01.png", ts: "2026-01-01T00:00:00.000Z", reason: "navigated", by: "agent" };

  const dispatched = dispatchExtractors(url, aria, capture, [xAriaExtractor]);
  check("dispatchExtractors + xAriaExtractor: produces one post + one comment", dispatched.length === 2, `got ${dispatched.length}`);
  check("every dispatched record carries provenance.via:'screen'", dispatched.every((r) => r.provenance.via === "screen"), JSON.stringify(dispatched.map((r) => r.provenance.via)));
  check("every dispatched record's capture.by matches what recall stamped ('agent')", dispatched.every((r) => r.capture?.by === "agent"));

  const rootId = rootIdFromUrl(url);
  check("rootIdFromUrl recovers the thread root's bare sid from the capturing page's url", rootId === ROOT_SID);

  // Viewport-honesty: only the REPLY was reported visible this tick; the root (off-screen, but the
  // thread root) must still survive the filter, matching capture.ts's own pipeline order.
  const filtered = filterVisibleRecords(dispatched, [REPLY_SID], rootId);
  const ids = filtered.map((r) => r.provenance.id).sort();
  check("viewport-honesty filter: keeps the visible comment AND the off-screen thread root", JSON.stringify(ids) === JSON.stringify([REPLY_SID, ROOT_SID].sort()), JSON.stringify(ids));
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

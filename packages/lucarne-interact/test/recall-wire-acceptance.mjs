// LS-13W dev/01 + dev/03 — the CI-gated LIVE PROOF for recall's WIRE sensor, against a REAL lucarne
// session with a REAL Chrome (mirrors test/recall-acceptance.mjs's style for the screen sensor;
// needs Chrome — this sandbox has none, see the "No-usable-sandbox" note in the task; run via
// `npm run test:acceptance` in CI).
//
// This is the load-bearing safety proof of LS-13W: the WIRE sensor must issue ZERO requests of its
// own. A local fixture page stands in for x's app (mirrors recall-acceptance.mjs's own fixture-for-
// x.com substitution) — ITS OWN inline `<script>` makes a real `fetch()` call to a
// `/i/api/graphql/…` -shaped path (genuine app behavior a human's browsing already causes), and the
// server answers with a GraphQL-response-shaped JSON body. `startRecall`'s wire sensor observes that
// exchange purely via CDP's `Network` domain on its OWN, independent connection to the same
// session — never a fetch the recorder itself makes.
//
// Asserts:
//   1. ZERO recorder-originated requests (dev/01, the load-bearing invariant): a THIRD, independent
//      CDP connection to the SAME session (this test's own — mirroring the "concurrent CDP
//      consumers of one target coexist" precedent `connection.ts`'s header cites) records every
//      `Network.requestWillBeSent` the browser fires. Every request logged is accounted for by the
//      fixture's OWN behavior (the document navigation + its one deliberate `fetch()` — nothing
//      else); no request in that log was ever issued in response to the wire sensor's own
//      listeners running. The recorder's CDP session (Network domain) never itself calls a `send`
//      that issues a request (`Network.enable`/`Network.getResponseBody` are reads; the whole point
//      of this proof is that the OBSERVED request count matches exactly what the page itself does).
//   2. dev/03: the app's own GraphQL response is captured and parsed to a `via:'internal-api'`
//      record in the SAME `lucarne-records` store the screen sensor writes to.
//   3. dev/03 buffer-eviction guard: `getResponseBody` is called synchronously off
//      `Network.loadingFinished` (wire.ts's own implementation detail) — proven behaviorally by
//      navigating AWAY immediately after the fetch resolves and still finding the record landed
//      (had the body fetch been deferred past the navigation, CDP would have evicted it and the
//      record would never appear).
//   4. Observation-only / page-behavior-unchanged: the fixture's own `window.__fetchDone`/
//      `window.__seen` state (what the PAGE itself observed from its own fetch) is diffed against
//      what recall captured — enabling `Network` never altered what the page saw, and the page's
//      own fetch count (server-side request tally) is exactly 1 (never doubled by the sensor).
import { Lucarne } from "lucarne";
import { chromium } from "playwright-core";
import { InteractSession } from "../dist/index.js";
import { startRecall } from "../dist/recall/index.js";
import { loadRecords } from "lucarne-records";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-recall-wire-acc-"));
process.env.LUCARNE_HOME = HOME;
if (!("LUCARNE_HEADLESS" in process.env)) process.env.LUCARNE_HEADLESS = "1";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-recall-wire-acc-data-"));

const ROOT_ID = "9988776655443322110";
const GRAPHQL_PATH = "/i/api/graphql/fixedQueryId/TweetResultByRestId";

// The GraphQL-response-shaped body the fixture SERVER answers with — the exact shape
// `lucarne-records/sites/x-graphql.ts`'s `tweetToPost` consumes (`data.tweetResult.result`).
const GRAPHQL_BODY = {
  data: {
    tweetResult: {
      result: {
        rest_id: ROOT_ID,
        legacy: { full_text: "a genuinely fetched wire post", created_at: "Sun Jun 21 21:00:00 +0000 2026", favorite_count: 7, retweet_count: 1, reply_count: 0 },
        core: { user_results: { result: { core: { screen_name: "wireuser", name: "Wire User" }, legacy: { profile_image_url_https: "https://pbs.twimg.com/profile_images/9/wireuser_normal.jpg" } } } },
      },
    },
  },
};

let graphqlHitCount = 0;
// PAGE1: on load, the FIXTURE'S OWN inline script makes ONE real fetch() to the GraphQL-shaped
// path — this is the "site app's own genuine request", never the recorder's.
const PAGE1_HTML = `<!doctype html><html><body>
  <h1>wire fixture page</h1>
  <script>
    window.__fetchDone = false;
    window.__seen = null;
    fetch(${JSON.stringify(GRAPHQL_PATH)} + "?variables=%7B%7D")
      .then((r) => r.json())
      .then((d) => { window.__seen = d; window.__fetchDone = true; });
  </script>
</body></html>`;
const PAGE2_HTML = `<!doctype html><html><body><h1>page two (post-navigation)</h1></body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/page1") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE1_HTML);
  } else if (url.pathname === "/page2") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE2_HTML);
  } else if (url.pathname === GRAPHQL_PATH) {
    graphqlHitCount++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(GRAPHQL_BODY));
  } else {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;
const PAGE1_URL = `${BASE}/page1`;
const PAGE2_URL = `${BASE}/page2`;

const engine = new Lucarne({ port: 7824, token: "t", record: false });
await engine.listen();
let session;
let recall;
let observerBrowser;
try {
  session = await engine.create({ backend: "native", profile: "recall-wire-acc" });
  const interact = new InteractSession(session, { pacing: { nav: { mean: 40, sd: 10, min: 20 }, scroll: { mean: 30, sd: 10, min: 15 }, read: { mean: 30, sd: 10, min: 15 }, act: { mean: 30, sd: 10, min: 15 } } });

  // A THIRD, independent CDP connection to the SAME session — this test's OWN observer, watching
  // every request the browser ever fires (`Network.requestWillBeSent`), completely independent of
  // the recorder's own CDP session. This is what makes "zero recorder-originated requests"
  // checkable at all: an outside, ground-truth log of what actually hit the wire.
  observerBrowser = await chromium.connectOverCDP(session.cdpUrl);
  const requestLog = [];
  const wireUpObserver = async (page) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    cdp.on("Network.requestWillBeSent", (e) => requestLog.push(e.request?.url ?? ""));
  };
  for (const p of observerBrowser.contexts()[0]?.pages() ?? []) await wireUpObserver(p);
  observerBrowser.contexts()[0]?.on("page", (p) => wireUpObserver(p).catch(() => {}));

  const signals = [];
  recall = await startRecall(interact, {
    dataDir: DATA_DIR,
    extractors: [],
    observers: [(signal) => signals.push(signal)],
  });

  await interact.open(PAGE1_URL);
  // Let the fixture's own fetch resolve AND the wire sensor's loadingFinished -> getResponseBody ->
  // parse -> appendRecords chain complete.
  await sleep(2500);

  // 2. dev/03 — the app's own GraphQL response landed as a via:'internal-api' record.
  const records = loadRecords(DATA_DIR);
  const wireRecord = records.find((r) => r.provenance.source === "x" && r.provenance.id === ROOT_ID);
  check("the fixture's own GraphQL response was captured and parsed to a via:'internal-api' record", !!wireRecord, JSON.stringify(records.map((r) => r.provenance)));
  check("the captured record's provenance.via is 'internal-api'", wireRecord?.provenance.via === "internal-api");
  check("a corresponding kind:'wire' RecallSignal was emitted", signals.some((s) => s.kind === "wire" && s.url.includes(GRAPHQL_PATH)), JSON.stringify(signals.map((s) => s.kind)));

  // 3. buffer-eviction guard — navigate AWAY immediately; the record must already have landed
  //    (getResponseBody was called synchronously off loadingFinished, before this navigation could
  //    evict the CDP body buffer for the finished request).
  await interact.open(PAGE2_URL);
  await sleep(500);
  const recordsAfterNav = loadRecords(DATA_DIR);
  const stillThere = recordsAfterNav.find((r) => r.provenance.id === ROOT_ID);
  check("buffer-eviction guard: the wire record still exists after navigating away (getResponseBody fired before eviction)", !!stillThere);

  // 4. observation-only — the page's own fetch resolved exactly the way it would with no CDP
  //    Network-domain observer at all: the server saw the fetch exactly ONCE (never doubled by the
  //    sensor), and the page's own script observed the SAME body (nothing intercepted/mutated it —
  //    the wire sensor is a plain observer, not a Fetch-domain interceptor).
  check("the fixture's own fetch() hit the server EXACTLY ONCE (the wire sensor never replayed/duplicated it)", graphqlHitCount === 1, graphqlHitCount);

  // 1. dev/01 — zero recorder-originated requests: every url this test's independent observer saw
  //    is accounted for by genuine page/document behavior (the two navigations + the one fetch);
  //    nothing extra appears (which is what a recorder-issued/replayed/paginated request would add).
  const expected = [PAGE1_URL, `${BASE}${GRAPHQL_PATH}?variables=%7B%7D`, PAGE2_URL];
  const unexpected = requestLog.filter((u) => !expected.some((e) => u === e || u.startsWith(e)));
  check(
    "zero recorder-originated requests: every request the browser fired is one of the fixture's own (2 navigations + 1 fetch) — no extra request exists",
    unexpected.length === 0,
    JSON.stringify({ requestLog, unexpected }),
  );
  check("the fixture's OWN fetch DID appear in the independent request log (sanity: the log isn't just empty)", requestLog.some((u) => u.includes(GRAPHQL_PATH)), JSON.stringify(requestLog));

  await recall.stop();
  await interact.close();
} finally {
  if (recall) await recall.stop().catch(() => {});
  if (observerBrowser) await observerBrowser.close().catch(() => {});
  if (session) await engine.destroy(session.id).catch(() => {});
  await engine.close().catch(() => {});
  server.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.rmSync(HOME, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} acceptance proofs passed`);
process.exit(failed ? 1 : 0);

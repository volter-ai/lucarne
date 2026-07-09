// LS-13 dev/01 — the CI-gated LIVE PROOF for recall's SCREEN sensor, against a REAL lucarne
// session with a REAL Chrome (mirrors test/acceptance.mjs's style; needs Chrome — this sandbox has
// none, see the "No-usable-sandbox" note in the task; run via `npm run test:acceptance` in CI).
//
// Asserts, end-to-end, with the engine's OWN recorder active (a SECOND CDP screencast consumer of
// the same session, alongside recall's — the "engine recorder active (two screencast consumers)"
// requirement):
//   1. FIRST http navigation -> the first successful capture is legitimately reason:'initial'
//      (a fresh native session launches at about:blank, which is non-http/skipped, so the first
//      http capture has lastParts===null -> classifyChange(null,…) === 'initial' by design —
//      cadence's first capture is 'initial' too, tab-scoring.ts:84).
//   2. a SECOND, DIFFERENT http navigation -> capture-on-change fires with reason:'navigated' and
//      presence-derived by:'agent' on THAT capture (recall is given the driving InteractSession
//      directly — duck-typed presenceSnapshot()). The url path changed between captures, so
//      classifyChange returns 'navigated'.
//   3. via:'screen' records land in the shared `lucarne-records` store at `dataDir`, and
//      viewport-honesty DROPS the off-screen buffered post while KEEPING the on-screen reply AND
//      the thread root (asserted on the post-'navigated' state, before the scroll below).
//   4. scroll -> capture-on-change fires with reason:'scrolled'.
//   5. a perf check: recall keeps making forward progress (a fresh capture within a generous bound)
//      even while the engine's own CCTV recorder is also tapping the same CDP screencast endpoint.
import { Lucarne } from "lucarne";
import { InteractSession } from "../dist/index.js";
import { startRecall } from "../dist/recall/index.js";
import { extractXAriaRecords, loadRecords } from "lucarne-records";
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

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-recall-acc-"));
process.env.LUCARNE_HOME = HOME;
if (!("LUCARNE_HEADLESS" in process.env)) process.env.LUCARNE_HEADLESS = "1";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-recall-acc-data-"));

const ROOT_SID = "1234567890123456789";
const REPLY_SID = "2222222222222222222"; // on-screen
const BUFFERED_SID = "3333333333333333333"; // off-screen buffer post — must be DROPPED by viewport-honesty

// The FIRST page (a plain landing page) exists only so recall's first http capture is a legitimate
// reason:'initial' — establishing lastParts so the SUBSEQUENT navigation to a different url is
// classified 'navigated'.
const LANDING_HTML = `<!doctype html><html><body style="margin:0"><h1>a landing page</h1></body></html>`;

// A thread-page fixture: the ROOT post + an on-screen REPLY (both tall enough — ≥120px — to clear
// the viewport-visibility threshold at the top of the page), then a BUFFERED reply far below the
// fold (X's own virtualization pattern — kept in the DOM, never seen). So at the moment of the
// thread capture, root+reply are visible (non-empty visibleIds => the filter is active) while the
// buffered post is off-screen and gets DROPPED.
const THREAD_HTML = `<!doctype html><html><body style="margin:0">
  <article aria-label="root" style="min-height:220px"><a href="/paulg/status/${ROOT_SID}">9:00 AM</a><p>hello from the root post</p></article>
  <article aria-label="reply" style="min-height:220px"><a href="/janedoe/status/${REPLY_SID}">10:00 AM</a><p>a genuine on-screen reply</p></article>
  <div style="height:6000px">spacer pushing the buffered reply far below the fold</div>
  <article aria-label="buffered" style="min-height:220px"><a href="/faraway/status/${BUFFERED_SID}">11:00 AM</a><p>never actually seen on screen</p></article>
</body></html>`;

const LANDING_PATH = "/home";
const THREAD_PATH = `/paulg/status/${ROOT_SID}`; // x-shaped path — rootIdFromUrl matches `/status/<id>` in the URL
const server = http.createServer((req, res) => {
  if (req.url === LANDING_PATH) {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(LANDING_HTML);
  } else if (req.url === THREAD_PATH) {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(THREAD_HTML);
  } else {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;
const LANDING_URL = `${BASE}${LANDING_PATH}`;
const THREAD_URL = `${BASE}${THREAD_PATH}`;

// The real X ARIA extractor's `match` keys on `x.com`/`twitter.com` hostnames — this proof serves a
// LOCAL fixture at 127.0.0.1, so we wrap the REAL extraction (`extractXAriaRecords`, the
// load-bearing parse) behind a `match` that accepts this fixture's own base url. The parsing/record-
// mapping logic under test is unchanged — only the host predicate is adapted to the local stand-in
// for x.com (cadence passes the unmodified `xAriaExtractor` against real x.com in production).
const fixtureExtractor = { match: (url) => String(url || "").startsWith(BASE), extract: extractXAriaRecords };

// The engine's own recorder (record:true) is a SECOND, independent CDP screencast consumer of the
// SAME session — the "two screencast consumers" case this proof must survive.
const engine = new Lucarne({ port: 7823, token: "t", record: true });
await engine.listen();
let session;
let recall;
try {
  session = await engine.create({ backend: "native", profile: "recall-acc" });
  const interact = new InteractSession(session, { pacing: { nav: { mean: 40, sd: 10, min: 20 }, scroll: { mean: 30, sd: 10, min: 15 }, read: { mean: 30, sd: 10, min: 15 }, act: { mean: 30, sd: 10, min: 15 } } });

  const signals = [];
  recall = await startRecall(interact, {
    dataDir: DATA_DIR,
    extractors: [fixtureExtractor],
    observers: [(signal) => signals.push(signal)],
  });

  // 1. FIRST http navigation -> the first successful capture is legitimately reason:'initial'
  //    (fresh session -> lastParts===null -> classifyChange(null,…) === 'initial').
  await interact.open(LANDING_URL);
  await sleep(3000); // let recall's own poll loop pick up the landing page (sets lastParts)
  const initialCapture = signals.find((s) => s.kind === "capture" && s.reason === "initial");
  check("the FIRST http capture is reason:'initial' (fresh session, no prior parts)", !!initialCapture, JSON.stringify(signals.map((s) => s.kind + ":" + (s.reason ?? s.stopReason))));
  check("the initial capture's url is the landing page", initialCapture?.url === LANDING_URL, initialCapture?.url);

  // 2. a SECOND, DIFFERENT http navigation -> capture-on-change with reason:'navigated', by:'agent'
  //    on THAT capture (the url path changed between captures).
  await interact.open(THREAD_URL);
  await sleep(3000);
  const navCapture = signals.find((s) => s.kind === "capture" && s.reason === "navigated");
  check("the SECOND navigation fires a capture with reason:'navigated'", !!navCapture, JSON.stringify(signals.map((s) => s.kind + ":" + (s.reason ?? s.stopReason))));
  check("the navigated capture is on the thread url (the destination of the second open())", navCapture?.url === THREAD_URL, navCapture?.url);
  check("the navigated capture's by is 'agent' (presence-derived, driven by InteractSession)", navCapture?.by === "agent", navCapture?.by);

  // 3. via:'screen' records land; viewport-honesty drops the off-screen buffered post while keeping
  //    the on-screen reply AND the thread root. Checked HERE, on the post-'navigated' state — page
  //    still at the top, so root+reply are visible and the buffered post is off-screen. This runs
  //    BEFORE the scroll below on purpose: once we scroll the tall articles above the fold, a
  //    capture whose viewport shows only the 6000px spacer has an EMPTY visible set, which (by
  //    design — the safety valve) disables filtering, so the honesty assertion must be made while
  //    the thread capture at the top is the store's latest word on those ids.
  await sleep(1000);
  const records = loadRecords(DATA_DIR);
  const screenRecords = records.filter((r) => r.provenance.via === "screen");
  check("via:'screen' records land in the lucarne-records store", screenRecords.length > 0, `${screenRecords.length} screen records`);
  const bufferedRecord = screenRecords.find((r) => r.provenance.id === BUFFERED_SID);
  check("viewport-honesty: the far-off-screen buffered post is DROPPED", !bufferedRecord);
  const replyRecord = screenRecords.find((r) => r.provenance.id === REPLY_SID);
  check("viewport-honesty: the on-screen reply IS kept", !!replyRecord);
  const rootRecord = screenRecords.find((r) => r.provenance.id === ROOT_SID);
  check("viewport-honesty: the thread ROOT survives (no comment is ever orphaned)", !!rootRecord);

  // 4. scroll -> a subsequent capture-on-change with reason:'scrolled' (url + firstText unchanged,
  //    only the scroll bucket moves).
  await interact.scroll(3);
  await sleep(3000);
  const scrolledCapture = signals.find((s) => s.kind === "capture" && s.reason === "scrolled");
  check("capture-on-change fires with reason:'scrolled' after scroll()", !!scrolledCapture, JSON.stringify(signals.map((s) => s.reason)));

  // 5. perf check: recall keeps making forward progress with the engine's own CCTV recorder ALSO
  //    tapping the same CDP screencast endpoint (two concurrent screencast consumers). A navigation
  //    back to the landing url is a GUARANTEED capture-on-change (the url differs from the thread
  //    url), so this probes latency, not whether a capture happens to fire.
  const before = signals.length;
  await interact.open(LANDING_URL);
  const t0 = Date.now();
  let sawNewSignal = false;
  while (Date.now() - t0 < 8000) {
    if (signals.length > before) {
      sawNewSignal = true;
      break;
    }
    await sleep(200);
  }
  check("perf: recall still makes forward progress within 8s with the engine's own recorder ALSO consuming the screencast (two consumers coexist)", sawNewSignal);

  await recall.stop();
  await interact.close();
} finally {
  if (recall) await recall.stop().catch(() => {});
  if (session) await engine.destroy(session.id).catch(() => {});
  await engine.close().catch(() => {});
  server.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.rmSync(HOME, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} acceptance proofs passed`);
process.exit(failed ? 1 : 0);

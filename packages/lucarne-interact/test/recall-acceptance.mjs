// LS-13 dev/01 — the CI-gated LIVE PROOF for recall's SCREEN sensor, against a REAL lucarne
// session with a REAL Chrome (mirrors test/acceptance.mjs's style; needs Chrome — this sandbox has
// none, see the "No-usable-sandbox" note in the task; run via `npm run test:acceptance` in CI).
//
// Asserts, end-to-end, with the engine's OWN recorder active (a SECOND CDP screencast consumer of
// the same session, alongside recall's — the "engine recorder active (two screencast consumers)"
// requirement):
//   1. navigate -> capture-on-change fires with reason:'navigated' and presence-derived by:'agent'
//      (recall is given the driving InteractSession directly — duck-typed presenceSnapshot()).
//   2. scroll -> capture-on-change fires with reason:'scrolled'.
//   3. viewport-honesty: an off-screen buffered post is DROPPED, the thread root (also off-screen)
//      and the on-screen reply both SURVIVE the filter.
//   4. via:'screen' records land in the shared `lucarne-records` store at `dataDir`.
//   5. a perf check: recall keeps making forward progress (a fresh capture within a generous bound)
//      even while the engine's own CCTV recorder is also tapping the same CDP screencast endpoint.
import { Lucarne } from "lucarne";
import { InteractSession } from "../dist/index.js";
import { startRecall } from "../dist/recall/index.js";
import { loadRecords, xAriaExtractor } from "lucarne-records";
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

// A thread-page fixture: the ROOT post (scrolled just out of view above), an on-screen REPLY, and a
// BUFFERED reply far below the fold (X's own virtualization pattern — kept in the DOM, never seen).
const THREAD_HTML = `<!doctype html><html><body style="margin:0">
  <div style="height:900px">spacer above the root, so it starts off-screen once we scroll</div>
  <article aria-label="root"><a href="/paulg/status/${ROOT_SID}">9:00 AM</a><p>hello from the root post</p></article>
  <article aria-label="reply"><a href="/janedoe/status/${REPLY_SID}">10:00 AM</a><p>a genuine on-screen reply</p></article>
  <div style="height:4000px">spacer pushing the buffered reply far below the fold</div>
  <article aria-label="buffered"><a href="/faraway/status/${BUFFERED_SID}">11:00 AM</a><p>never actually seen on screen</p></article>
</body></html>`;

const THREAD_PATH = `/paulg/status/${ROOT_SID}`; // x-shaped path — rootIdFromUrl/xAriaExtractor match `/status/<id>` in the URL
const server = http.createServer((req, res) => {
  if (req.url === THREAD_PATH) {
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
const THREAD_URL = `${BASE}${THREAD_PATH}`;

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
    extractors: [xAriaExtractor],
    observers: [(signal) => signals.push(signal)],
  });

  // 1. navigate -> capture-on-change with reason:'navigated', by:'agent' (InteractSession drove it).
  await interact.open(THREAD_URL);
  await sleep(3000); // let recall's own poll loop pick it up
  const navCapture = signals.find((s) => s.kind === "capture" && s.reason === "navigated");
  check("capture-on-change fires with reason:'navigated' after open()", !!navCapture, JSON.stringify(signals.map((s) => s.kind + ":" + (s.reason ?? s.stopReason))));
  check("the navigated capture's by is 'agent' (presence-derived, driven by InteractSession)", navCapture?.by === "agent", navCapture?.by);

  // 2. scroll -> a subsequent capture-on-change with reason:'scrolled'.
  await interact.scroll(3);
  await sleep(3000);
  const scrolledCapture = signals.find((s) => s.kind === "capture" && s.reason === "scrolled");
  check("capture-on-change fires with reason:'scrolled' after scroll()", !!scrolledCapture, JSON.stringify(signals.map((s) => s.reason)));

  // 3 & 4. via:'screen' records land in the store; viewport-honesty drops the buffered post, keeps
  //    the on-screen reply AND the (possibly off-screen) thread root.
  await sleep(1000);
  const records = loadRecords(DATA_DIR);
  const screenRecords = records.filter((r) => r.provenance.via === "screen");
  check("via:'screen' records land in the lucarne-records store", screenRecords.length > 0, `${screenRecords.length} screen records`);
  const bufferedRecord = screenRecords.find((r) => r.provenance.id === BUFFERED_SID);
  check("viewport-honesty: the far-off-screen buffered post is DROPPED", !bufferedRecord);
  const replyRecord = screenRecords.find((r) => r.provenance.id === REPLY_SID);
  check("viewport-honesty: the on-screen reply IS kept", !!replyRecord);

  // 5. perf check: recall keeps making forward progress with the engine's own CCTV recorder ALSO
  //    tapping the same CDP screencast endpoint (two concurrent screencast consumers).
  const before = signals.length;
  await interact.scroll(1);
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

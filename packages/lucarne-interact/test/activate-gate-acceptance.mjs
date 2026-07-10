// LS-28 acceptance proof — drives a REAL lucarne session with a REAL Chrome, over InteractSession,
// proving `activate()`'s structural refusal end-to-end (not just the mocked-descriptor unit proof in
// test/activate-gate.mjs). Needs Google Chrome installed (this sandbox has none — see the
// "No-usable-sandbox" note in the task); run via `npm run test:acceptance` in CI (the repo's
// acceptance job installs Chrome+xvfb and runs `npm run test:acceptance --workspaces --if-present`).
//
// The binding proof: `type("banned text")` + `activate("<submit-or-account-action selector>")` must
// NOT publish/act — the classifier (activate-gate.ts) refuses BEFORE the keypress fires, so the
// real page's submit handler / click sentinel is NEVER triggered — while `activate` on a genuine
// navigation target (an `<a href>`, and a plain expand/disclosure button) still works exactly as
// before.
import { Lucarne } from "lucarne";
import { InteractSession } from "../dist/index.js";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-interact-actgate-"));
process.env.LUCARNE_HOME = HOME;
if (!("LUCARNE_HEADLESS" in process.env)) process.env.LUCARNE_HEADLESS = "1";

// A real <form> with a real submit control, an X-like tweetButton (PUBLISH) OUTSIDE the form, an
// account-state "like" control, an X-like COMPOSE-OPEN reply button (`data-testid="reply"` — opens a
// composer, publishes nothing), and two genuine navigation targets (an `<a href>` and a plain
// expand/disclosure button). Every control is instrumented with a sentinel flipped ONLY on its real
// DOM effect (submit / publish-click / like-click / compose-open) — the test's ground truth is the
// sentinel, not InteractSession's own report.
const PAGE_HTML = `<!doctype html><html><body>
  <h1 id="hdr">Activate-Gate Fixture</h1>

  <form id="f" onsubmit="window.__formSubmitted=true;return false;">
    <textarea id="ta" autofocus>a banned draft staged via type()</textarea>
    <button id="submitBtn" type="submit">Post</button>
  </form>

  <button id="tweetBtn" data-testid="tweetButton" onclick="window.__tweetClicked=true">Post</button>
  <button id="likeBtn" data-testid="like" aria-label="Like" onclick="window.__likeClicked=true">&hearts;</button>

  <!-- COMPOSE-OPEN: activating this reveals + focuses the reply composer. It PUBLISHES NOTHING. -->
  <button id="replyBtn" data-testid="reply" aria-label="Reply" onclick="window.__replyOpened=true;document.getElementById('replyBox').style.display='block';document.getElementById('replyBox').focus()">Reply</button>
  <textarea id="replyBox" style="display:none"></textarea>

  <!-- SECURITY-REVIEW EXPLOIT CLASS: a bare-label publish button — NO <form>, NO known testid. It
       must DEFAULT-REFUSE; if activated it would publish. Sentinel proves it never fires. -->
  <button id="barePost" onclick="window.__barePublished=true">Post</button>

  <a id="next" href="/next">go to next page</a>
  <button id="expandBtn" onclick="window.__expanded=true">Show 3 more replies</button>

  <script>
    window.__formSubmitted = false;
    window.__tweetClicked = false;
    window.__likeClicked = false;
    window.__replyOpened = false;
    window.__barePublished = false;
    window.__expanded = false;
  </script>
</body></html>`;
const NEXT_HTML = `<!doctype html><html><body><h1 id="hdr">Next Page</h1></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE_HTML);
  } else if (req.url === "/next") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(NEXT_HTML);
  } else {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;

const engine = new Lucarne({ port: 7823, token: "t", record: false });
await engine.listen();
let session;
try {
  session = await engine.create({ backend: "native", profile: "activate-gate-acc" });

  const FAST_PACING = {
    nav: { mean: 40, sd: 10, min: 20 },
    scroll: { mean: 30, sd: 10, min: 15 },
    read: { mean: 30, sd: 10, min: 15 },
    act: { mean: 30, sd: 10, min: 15 },
  };
  const s = new InteractSession(session, { pacing: FAST_PACING, timeoutMs: 15000 });

  await s.open(BASE + "/");

  // Ground truth: read the page's sentinel flags directly (independent of InteractSession's report).
  const readFlags = async () => {
    // `where()`/`snap()` don't expose page.evaluate — use a fresh CDP-connected inspector, same
    // pattern as acceptance.mjs's ground-truth reads, so this proof never trusts the product's own
    // success report for what actually happened in the page.
    const { chromium } = await import("playwright-core");
    const insp = await chromium.connectOverCDP(session.cdpUrl);
    try {
      const p = insp.contexts()[0].pages()[0];
      return await p.evaluate(() => ({
        formSubmitted: window.__formSubmitted,
        tweetClicked: window.__tweetClicked,
        likeClicked: window.__likeClicked,
        replyOpened: window.__replyOpened,
        barePublished: window.__barePublished,
        expanded: window.__expanded,
        taValue: document.getElementById("ta")?.value,
      }));
    } finally {
      await insp.close().catch(() => {});
    }
  };

  // Stage a "banned" draft the way a real caller would (type() then attempt to fire it via
  // activate() on the submit control instead of the gated send() — the exact hole LS-28 closes).
  {
    const before = await readFlags();
    check("precondition: form not yet submitted", before.formSubmitted === false);

    let threw = null;
    try {
      await s.activate("#submitBtn");
    } catch (e) {
      threw = e;
    }
    const after = await readFlags();
    check("activate(#submitBtn): THROWS (structural refusal)", threw instanceof Error, String(threw));
    check(
      "activate(#submitBtn): refusal message directs to the gated send()",
      !!threw && /gated `send\(\)`/.test(threw.message),
      threw?.message,
    );
    check("activate(#submitBtn): the form was NEVER submitted (onsubmit sentinel untouched)", after.formSubmitted === false, JSON.stringify(after));
  }

  // The X-like tweetButton (compose/submit by known testid) — same proof, a control OUTSIDE any <form>.
  {
    let threw = null;
    try {
      await s.activate('[data-testid="tweetButton"]');
    } catch (e) {
      threw = e;
    }
    const after = await readFlags();
    check("activate([data-testid=tweetButton]): THROWS (structural refusal)", threw instanceof Error, String(threw));
    check("activate([data-testid=tweetButton]): the button's onclick NEVER fired", after.tweetClicked === false, JSON.stringify(after));
  }

  // An account-state affordance (like) — must also refuse, distinct from the compose/submit case.
  {
    let threw = null;
    try {
      await s.activate('[data-testid="like"]');
    } catch (e) {
      threw = e;
    }
    const after = await readFlags();
    check("activate([data-testid=like]): THROWS (structural refusal)", threw instanceof Error, String(threw));
    check(
      "activate([data-testid=like]): refusal message notes account-state actions aren't automatable",
      !!threw && /account-state actions are not automatable/.test(threw.message),
      threw?.message,
    );
    check("activate([data-testid=like]): the like button's onclick NEVER fired", after.likeClicked === false, JSON.stringify(after));
  }

  // COMPOSE-OPEN STILL works (LS-28 refinement): X-like [data-testid="reply"] opens the reply
  // composer — it publishes NOTHING, so it must ALLOW and actually fire. This is the documented X
  // reply-open flow the over-refusal broke; the eventual SEND still goes through gated send().
  {
    let threw = null;
    try {
      await s.activate('[data-testid="reply"]');
    } catch (e) {
      threw = e;
    }
    const after = await readFlags();
    check("activate([data-testid=reply]): does NOT throw (compose-open publishes nothing)", threw === null, String(threw));
    check("activate([data-testid=reply]): the reply composer WAS opened (real activation happened)", after.replyOpened === true, JSON.stringify(after));
    check("activate([data-testid=reply]): nothing was published — form/tweet/like sentinels all still false", after.formSubmitted === false && after.tweetClicked === false && after.likeClicked === false, JSON.stringify(after));
  }

  // SECURITY-REVIEW EXPLOIT CLASS end-to-end: a bare-label <button>Post</button> (no <form>, no
  // known testid) must be structurally REFUSED — otherwise type(draft)+activate(it) publishes
  // ungated. This is the hole the "un-refuse the bare words" first cut left open.
  {
    let threw = null;
    try {
      await s.activate("#barePost");
    } catch (e) {
      threw = e;
    }
    const after = await readFlags();
    check("activate(#barePost, bare <button>Post</button>): THROWS (default-refuse)", threw instanceof Error, String(threw));
    check("activate(#barePost): the bare publish button's onclick NEVER fired (hole stays closed)", after.barePublished === false, JSON.stringify(after));
  }

  // Navigation STILL works: a plain expand/disclosure button (label doesn't match any refuse pattern).
  {
    let threw = null;
    try {
      await s.activate("#expandBtn");
    } catch (e) {
      threw = e;
    }
    const after = await readFlags();
    check("activate(#expandBtn): does NOT throw (plain disclosure button stays allowed)", threw === null, String(threw));
    check("activate(#expandBtn): the button's onclick DID fire (real activation happened)", after.expanded === true, JSON.stringify(after));
  }

  // Navigation STILL works: a real `<a href>` actually navigates the real page.
  {
    await s.activate("#next");
    await new Promise((r) => setTimeout(r, 300));
    const snap = await s.snap("body", 20);
    check("activate(#next, <a href>): the real page actually navigated", /Next Page/.test(snap), snap.slice(0, 80));
  }

  await s.close();
} finally {
  if (session) await engine.destroy(session.id).catch(() => {});
  await engine.close().catch(() => {});
  server.close();
  fs.rmSync(HOME, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} activate-gate acceptance proofs passed`);
process.exit(failed ? 1 : 0);

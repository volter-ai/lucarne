// LS-31/S1 acceptance proof — drives a REAL lucarne session with a REAL Chrome, over InteractSession,
// proving `activate()`'s structural default-REFUSE classifier end-to-end (not just the mocked-
// descriptor unit proof in test/activate-gate.mjs). Needs Google Chrome installed (this sandbox has
// none — see the "No-usable-sandbox" note in the task); run via `npm run test:acceptance` in CI (the
// repo's acceptance job installs Chrome+xvfb and runs `npm run test:acceptance --workspaces
// --if-present`). NOT run in this session — CI-gated, code-reviewed only.
//
// The binding proof: `type("banned text")` + `activate(<any actionable control, INCLUDING one whose
// name appears nowhere in this module's source — the headline exploit class the safety panel found>)`
// must NOT publish/act — the classifier (activate-gate.ts) refuses BEFORE the keypress fires, so the
// real page's submit handler / click sentinel is NEVER triggered — while `activate` on a genuine
// structural navigation target (an `<a href>`, a plain expand/disclosure button) still works exactly
// as before, AND the documented X-style reply-compose-open flow still works, but ONLY when the
// session is constructed with an `activatePolicy` that allowlists it (the consumer-allowlist step) —
// the SAME selector must REFUSE on a session with no policy.
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
// account-state "like" control, a LinkedIn-like "Connect" button (an account-state control whose
// NAME APPEARS NOWHERE IN activate-gate.ts's source — the exploit class the safety panel found: a
// blocklist can never enumerate every site's vocabulary, so default-refuse must catch it structurally,
// not lexically), an X-like COMPOSE-OPEN reply button (`data-testid="reply"` — opens a composer,
// publishes nothing, allowed ONLY via a consumer's `activatePolicy`), and two genuine navigation
// targets (an `<a href>` and a plain expand/disclosure button). Every control is instrumented with a
// sentinel flipped ONLY on its real DOM effect (submit / publish-click / like-click / connect-click /
// compose-open) — the test's ground truth is the sentinel, not InteractSession's own report.
const PAGE_HTML = `<!doctype html><html><body>
  <h1 id="hdr">Activate-Gate Fixture</h1>

  <form id="f" onsubmit="window.__formSubmitted=true;return false;">
    <textarea id="ta" autofocus>a banned draft staged via type()</textarea>
    <button id="submitBtn" type="submit">Post</button>
  </form>

  <button id="tweetBtn" data-testid="tweetButton" onclick="window.__tweetClicked=true">Post</button>
  <button id="likeBtn" data-testid="like" aria-label="Like" onclick="window.__likeClicked=true">&hearts;</button>

  <!-- EXPLOIT-CLASS HEADLINE FIXTURE: a LinkedIn-style account-state control whose name is not
       enumerated anywhere in activate-gate.ts. Must default-refuse STRUCTURALLY. -->
  <button id="connectBtn" onclick="window.__connectClicked=true;window.__connectKeydown=false" onkeydown="window.__connectKeydown=true">Connect</button>

  <!-- COMPOSE-OPEN: activating this reveals + focuses the reply composer. It PUBLISHES NOTHING. Only
       allowed via a consumer's activatePolicy (the CONSUMER ALLOWLIST step). -->
  <button id="replyBtn" data-testid="reply" aria-label="Reply" onclick="window.__replyOpened=true;document.getElementById('replyBox').style.display='block';document.getElementById('replyBox').focus()">Reply</button>
  <textarea id="replyBox" style="display:none"></textarea>

  <!-- a bare-label publish button — NO <form>, NO known testid. Must default-refuse. -->
  <button id="barePost" onclick="window.__barePublished=true">Post</button>

  <a id="next" href="/next">go to next page</a>
  <button id="expandBtn" onclick="window.__expanded=true">Show 3 more replies</button>

  <script>
    window.__formSubmitted = false;
    window.__tweetClicked = false;
    window.__likeClicked = false;
    window.__connectClicked = false;
    window.__connectKeydown = false;
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
  // NO activatePolicy — the default-refuse session. Proves every actionable control (including the
  // exploit-class "Connect" button, whose name is nowhere in this package's source) refuses.
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
        connectClicked: window.__connectClicked,
        connectKeydown: window.__connectKeydown,
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
  // activate() on the submit control instead of the gated send() — the exact hole this closes).
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
    check("activate(#submitBtn): THROWS (structural refusal, non-overridable safety floor)", threw instanceof Error, String(threw));
    check(
      "activate(#submitBtn): refusal message directs to the gated send()",
      !!threw && /gated `send\(\)`/.test(threw.message),
      threw?.message,
    );
    check("activate(#submitBtn): the form was NEVER submitted (onsubmit sentinel untouched)", after.formSubmitted === false, JSON.stringify(after));
  }

  // The X-like tweetButton (compose/submit by known testid) — refuses by DEFAULT now (no blocklist
  // entry needed — this package carries zero X vocabulary; the refusal is structural).
  {
    let threw = null;
    try {
      await s.activate('[data-testid="tweetButton"]');
    } catch (e) {
      threw = e;
    }
    const after = await readFlags();
    check("activate([data-testid=tweetButton]): THROWS (default-refuse, not a structural nav shape)", threw instanceof Error, String(threw));
    check("activate([data-testid=tweetButton]): the button's onclick NEVER fired", after.tweetClicked === false, JSON.stringify(after));
  }

  // An account-state affordance (like) — must also refuse.
  {
    let threw = null;
    try {
      await s.activate('[data-testid="like"]');
    } catch (e) {
      threw = e;
    }
    const after = await readFlags();
    check("activate([data-testid=like]): THROWS (default-refuse)", threw instanceof Error, String(threw));
    check(
      "activate([data-testid=like]): refusal message notes account-state actions aren't automatable",
      !!threw && /account-state actions are not automatable/.test(threw.message),
      threw?.message,
    );
    check("activate([data-testid=like]): the like button's onclick NEVER fired", after.likeClicked === false, JSON.stringify(after));
  }

  // ── THE HEADLINE PROOF (safety panel's exploit class): type("draft") + activate(<button>Connect
  //    </button>) must throw BEFORE ANY KEYPRESS. "Connect" is not a name enumerated anywhere in
  //    activate-gate.ts — this is what proves the classifier is STRUCTURAL default-refuse, not a
  //    blocklist that merely forgot this one word. ──
  {
    const before = await readFlags();
    check("precondition: Connect button untouched, no keydown seen", before.connectClicked === false && before.connectKeydown === false, JSON.stringify(before));

    await s.type("a banned draft staged via type()");
    let threw = null;
    try {
      await s.activate("#connectBtn");
    } catch (e) {
      threw = e;
    }
    const after = await readFlags();
    check(
      "type(draft) + activate(<button>Connect</button>): THROWS BEFORE ANY KEYPRESS (structural default-refuse, not a blocklist match)",
      threw instanceof Error,
      String(threw),
    );
    check("activate(#connectBtn): the button's onclick NEVER fired (no click either)", after.connectClicked === false, JSON.stringify(after));
    check("activate(#connectBtn): NO keydown ever reached the element — press() never dispatched", after.connectKeydown === false, JSON.stringify(after));
  }

  // COMPOSE-OPEN WITHOUT a policy: the SAME selector that will be allowlisted below must REFUSE here
  // — proving the consumer-allowlist step is opt-in per session, not a blanket carve-out.
  {
    let threw = null;
    try {
      await s.activate('[data-testid="reply"]');
    } catch (e) {
      threw = e;
    }
    const after = await readFlags();
    check("activate([data-testid=reply]) with NO activatePolicy: THROWS (default-refuse)", threw instanceof Error, String(threw));
    check("activate([data-testid=reply]) with NO activatePolicy: composer was NOT opened", after.replyOpened === false, JSON.stringify(after));
  }

  // SECURITY-REVIEW EXPLOIT CLASS end-to-end: a bare-label <button>Post</button> (no <form>, no
  // known testid) must be structurally REFUSED — otherwise type(draft)+activate(it) publishes ungated.
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

  // Navigation STILL works: a plain expand/disclosure button (a structural allow shape).
  {
    let threw = null;
    try {
      await s.activate("#expandBtn");
    } catch (e) {
      threw = e;
    }
    const after = await readFlags();
    check("activate(#expandBtn): does NOT throw (plain disclosure button stays allowed, structural)", threw === null, String(threw));
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

  // ── WITH a cadence-shaped activatePolicy: the documented X reply-compose-open flow WORKS. A fresh
  //    InteractSession bound to the SAME underlying CDP session, this time with a data-only policy
  //    naming the reply testid — the consumer-allowlist step now reaches an ALLOW for this one
  //    control, while every other selector above is untouched (still refuses on this session too). ──
  {
    await engine.destroy(session.id).catch(() => {});
    session = await engine.create({ backend: "native", profile: "activate-gate-acc-policy" });
    const sPolicy = new InteractSession(session, {
      pacing: FAST_PACING,
      timeoutMs: 15000,
      activatePolicy: { allow: [{ testids: ["reply"] }] },
    });
    await sPolicy.open(BASE + "/");

    let threw = null;
    try {
      await sPolicy.activate('[data-testid="reply"]');
    } catch (e) {
      threw = e;
    }
    const { chromium } = await import("playwright-core");
    const insp = await chromium.connectOverCDP(session.cdpUrl);
    let replyOpened = false;
    try {
      const p = insp.contexts()[0].pages()[0];
      replyOpened = await p.evaluate(() => window.__replyOpened);
    } finally {
      await insp.close().catch(() => {});
    }
    check("WITH activatePolicy: activate([data-testid=reply]) does NOT throw (consumer-allowlisted compose-open)", threw === null, String(threw));
    check("WITH activatePolicy: the reply composer WAS opened (real activation happened)", replyOpened === true, String(replyOpened));

    // The submit control is STILL refused even on this policy-bearing session — the floor is
    // non-overridable, proven end-to-end (not just in the mocked-descriptor unit test).
    let threwSubmit = null;
    try {
      await sPolicy.activate("#submitBtn");
    } catch (e) {
      threwSubmit = e;
    }
    check("WITH activatePolicy: activate(#submitBtn) STILL THROWS (floor is non-overridable, proven end-to-end)", threwSubmit instanceof Error, String(threwSubmit));

    await sPolicy.close();
  }
} finally {
  if (session) await engine.destroy(session.id).catch(() => {});
  await engine.close().catch(() => {});
  server.close();
  fs.rmSync(HOME, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} activate-gate acceptance proofs passed`);
process.exit(failed ? 1 : 0);

// LS-31/S1 — the `activate()` structural, default-REFUSE target classifier (Chrome-free).
//
// Proves `classifyActivateTarget` (activate-gate.ts) INVERTS the old LS-28 blocklist shape (refuse
// an enumerated set, default-ALLOW everything else) to a structural default-REFUSE allowlist: a
// non-overridable safety floor refuses any form-submit shape FIRST — even against a policy that
// names it; a small set of domain-agnostic STRUCTURAL shapes (real-href links, tabs, disclosure
// toggles, `<summary>`, `<textarea>`, anchor-menuitems) allow; a caller's data-only `ActivatePolicy`
// may allowlist exactly one further compose-open control by host+testid/aria-label; EVERYTHING ELSE
// — every account-state affordance and every publish control, under ANY name, on ANY site, INCLUDING
// names never enumerated anywhere in this module — refuses by DEFAULT. This is the pure decision
// logic `session.ts#activate()` calls after its read-only in-page probe resolves the element
// descriptor — no Playwright, no browser, so this table runs entirely offline under `npm test`. The
// Chrome-gated end-to-end proof lives in test/activate-gate-acceptance.mjs (`npm run test:acceptance`).
//
// Run with `node test/activate-gate.mjs` (after `npm run build`).
import assert from "node:assert/strict";
import { classifyActivateTarget, describeActivateRefusal } from "../dist/activate-gate.js";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const base = () => ({
  tag: "div",
  type: null,
  role: null,
  testid: null,
  ariaLabel: null,
  href: null,
  text: null,
  inForm: false,
  isFormSubmitTrigger: false,
  pageUrl: "https://example.com/some/page",
  ariaExpanded: null,
  ariaHasPopup: null,
});

// An UNRELATED policy — scoped to a different host/testid entirely — used throughout the
// CLASS-refusal matrix to prove refusal is STRUCTURAL, not "just because no policy was supplied".
const UNRELATED_POLICY = {
  allow: [{ hosts: ["unrelated-host.example"], testids: ["someOtherThing"], ariaLabels: ["Some Other Label"], selectors: [".unrelated-allow"] }],
  deny: [{ hosts: ["unrelated-host.example"], selectors: [".unrelated-deny"] }],
};

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 1. CLASS-REFUSAL MATRIX — account-state / publish controls, by name, across sites — INCLUDING an
//    arbitrary word never mentioned anywhere in this module (`<button>Foo</button>`), which proves
//    the refusal is STRUCTURAL (default-refuse-everything-actionable), not a lexical blocklist match.
//    Every one of these must refuse BOTH with no policy AND with an unrelated policy in effect.
// ════════════════════════════════════════════════════════════════════════════════════════════════
const CLASS_REFUSAL_MATRIX = [
  ["LinkedIn <button>Connect</button>", { ...base(), tag: "button", text: "Connect" }],
  ["Reddit <button>Save</button>", { ...base(), tag: "button", text: "Save" }],
  ["<button>Join</button>", { ...base(), tag: "button", text: "Join" }],
  ["<button>Endorse</button> (div role=button)", { ...base(), tag: "div", role: "button", text: "Endorse" }],
  ["<button>Accept</button>", { ...base(), tag: "button", text: "Accept" }],
  ["<button>Mute</button>", { ...base(), tag: "button", text: "Mute" }],
  ["<button>Report</button>", { ...base(), tag: "button", text: "Report" }],
  ["<button>React</button>", { ...base(), tag: "button", text: "React" }],
  ["bare <button>Share</button>", { ...base(), tag: "button", text: "Share" }],
  ["Mastodon <button>Toot!</button>", { ...base(), tag: "button", text: "Toot!" }],
  ["X <button>Post</button> (bare, no testid)", { ...base(), tag: "button", text: "Post" }],
  ["<button>Foo</button> (ARBITRARY WORD — proves STRUCTURAL, not lexical)", { ...base(), tag: "button", text: "Foo" }],
];
for (const [label, d] of CLASS_REFUSAL_MATRIX) {
  const rNoPolicy = classifyActivateTarget(d);
  check(`CLASS-REFUSAL (no policy) — ${label}: REFUSE`, rNoPolicy.allow === false, JSON.stringify(rNoPolicy));
  const rUnrelatedPolicy = classifyActivateTarget(d, UNRELATED_POLICY);
  check(`CLASS-REFUSAL (unrelated policy in effect) — ${label}: REFUSE`, rUnrelatedPolicy.allow === false, JSON.stringify(rUnrelatedPolicy));
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 2. FLOOR NON-OVERRIDABILITY — the safety floor (step 1) is checked BEFORE any policy lookup, so an
//    allowlisted testid/aria-label on a form-submit shape is STILL refused.
// ════════════════════════════════════════════════════════════════════════════════════════════════
{
  const d = { ...base(), tag: "button", type: "submit", inForm: true, isFormSubmitTrigger: true, testid: "definitelyAllowlisted" };
  const policy = { allow: [{ testids: ["definitelyAllowlisted"] }] };
  const r = classifyActivateTarget(d, policy);
  check("FLOOR — button[type=submit] whose testid IS allowlisted: still REFUSE", r.allow === false, JSON.stringify(r));
  check("FLOOR — refusal reason states it cannot be overridden by policy", r.allow === false && /cannot be overridden by policy/.test(r.reason), r.reason);
}
{
  const d = { ...base(), tag: "input", type: "text", inForm: true, ariaLabel: "definitelyAllowlisted" };
  const policy = { allow: [{ ariaLabels: ["definitelyAllowlisted"] }] };
  const r = classifyActivateTarget(d, policy);
  check("FLOOR — text <input> in a <form>, allowlisted: still REFUSE", r.allow === false, JSON.stringify(r));
  check("FLOOR — refusal reason states it cannot be overridden by policy (input case)", r.allow === false && /cannot be overridden by policy/.test(r.reason), r.reason);
}
{
  // <input> with NO explicit type (defaults to "text") inside a form — also the implicit-submit floor.
  const d = { ...base(), tag: "input", type: null, inForm: true };
  const r = classifyActivateTarget(d);
  check("FLOOR — unset-type <input> (defaults text) in a <form>: REFUSE", r.allow === false, JSON.stringify(r));
}
{
  // <textarea> in a form is EXEMPT from the floor — Enter inserts a newline, never submits.
  const d = { ...base(), tag: "textarea", inForm: true };
  const r = classifyActivateTarget(d);
  check("<textarea> in a <form>: ALLOW (exempt from the implicit-submit floor)", r.allow === true, JSON.stringify(r));
}
{
  // input type=submit — refuses regardless of ancestry (bare [type=submit] heuristic).
  const d = { ...base(), tag: "input", type: "submit", inForm: false, isFormSubmitTrigger: true };
  const r = classifyActivateTarget(d);
  check("<input type=submit> (bare, no <form> ancestry needed): REFUSE", r.allow === false, JSON.stringify(r));
}
{
  // <input type=image> — an image-submit control.
  const d = { ...base(), tag: "input", type: "image", inForm: true, isFormSubmitTrigger: true };
  const r = classifyActivateTarget(d);
  check("<input type=image> (image submit): REFUSE", r.allow === false, JSON.stringify(r));
}
{
  // <button> with no explicit type, default-submit inside a <form>.
  const d = { ...base(), tag: "button", type: null, inForm: true, isFormSubmitTrigger: true, text: "Go" };
  const r = classifyActivateTarget(d);
  check("<button> with no explicit type, default-submit inside a <form>: REFUSE", r.allow === false, JSON.stringify(r));
}
{
  // Non-text-like inputs (checkbox) inside a form are NOT the implicit-submit floor case — but a
  // bare checkbox also isn't any of step 2's structural nav/disclosure shapes, so it still refuses
  // by DEFAULT (step 4), just via a different step than the floor. Proves the floor's text-like
  // scoping is precise without accidentally opening a new default-ALLOW path for non-text inputs.
  const d = { ...base(), tag: "input", type: "checkbox", inForm: true };
  const r = classifyActivateTarget(d);
  check("<input type=checkbox> in a <form>: REFUSE (not text-like, but also not a structural allow shape — default-refuse)", r.allow === false, JSON.stringify(r));
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 3. STRUCTURAL ALLOWS — domain-agnostic positive shapes.
// ════════════════════════════════════════════════════════════════════════════════════════════════
{
  const d = { ...base(), tag: "a", href: "/thread/123", role: "link", text: "reply" };
  const r = classifyActivateTarget(d);
  check("real-href anchor with INCIDENTAL text 'reply': ALLOW (structural, not lexical)", r.allow === true, JSON.stringify(r));
}
{
  const d = { ...base(), tag: "a", href: "/next", text: "go to next page" };
  const r = classifyActivateTarget(d);
  check("<a href> (plain navigation link, no role attr): ALLOW", r.allow === true, JSON.stringify(r));
}
{
  const d = { ...base(), tag: "button", role: "tab", text: "Media" };
  const r = classifyActivateTarget(d);
  check("role=tab: ALLOW", r.allow === true, JSON.stringify(r));
}
{
  const d = { ...base(), tag: "button", ariaExpanded: "false", text: "Show 3 more replies" };
  const r = classifyActivateTarget(d);
  check("aria-expanded toggle (disclosure): ALLOW", r.allow === true, JSON.stringify(r));
}
{
  const d = { ...base(), tag: "button", ariaExpanded: "true" };
  const r = classifyActivateTarget(d);
  check("aria-expanded='true' toggle: ALLOW (presence, not value, matters)", r.allow === true, JSON.stringify(r));
}
{
  const d = { ...base(), tag: "textarea" };
  const r = classifyActivateTarget(d);
  check("<textarea> (compose-focus, Enter never submits): ALLOW", r.allow === true, JSON.stringify(r));
}
{
  const d = { ...base(), tag: "summary" };
  const r = classifyActivateTarget(d);
  check("<summary> (native disclosure): ALLOW", r.allow === true, JSON.stringify(r));
}
{
  const d = { ...base(), tag: "a", href: "/settings", role: "menuitem", text: "Settings" };
  const r = classifyActivateTarget(d);
  check("anchor-menuitem (<a href role=menuitem>, nav menu entry): ALLOW", r.allow === true, JSON.stringify(r));
}

// ── STRUCTURAL REFUSALS (shapes that LOOK navigational but aren't) ──
{
  const d = { ...base(), tag: "a", href: "#", ariaLabel: "Like" };
  const r = classifyActivateTarget(d);
  check("href='#' anchor labeled 'Like': REFUSE (href='#' is not a REAL href, so this is not a structural nav link at all — falls to default-refuse)", r.allow === false, JSON.stringify(r));
}
{
  const d = { ...base(), tag: "a", href: "javascript:void(0)", ariaLabel: "Like" };
  const r = classifyActivateTarget(d);
  check("javascript: href anchor labeled 'Like': REFUSE (not a real href — default-refuse)", r.allow === false, JSON.stringify(r));
}
{
  const d = { ...base(), tag: "a", href: "#", text: "Follow" };
  const r = classifyActivateTarget(d);
  check("href='#' anchor with bare text 'Follow' (no policy): REFUSE (not structurally a nav link; falls to default-refuse)", r.allow === false, JSON.stringify(r));
}
{
  const d = { ...base(), tag: "div", role: "menuitem", text: "Repost" };
  const r = classifyActivateTarget(d);
  check("non-anchor role=menuitem 'Repost' (action menuitem): REFUSE", r.allow === false, JSON.stringify(r));
}
{
  const d = { ...base(), tag: "div", role: "textbox", text: "" };
  const r = classifyActivateTarget(d);
  check("contenteditable role=textbox (no policy): REFUSE", r.allow === false, JSON.stringify(r));
}
{
  // An anchor whose role is overridden to something action-like is NOT a nav link.
  const d = { ...base(), tag: "a", href: "/x", role: "button", text: "Follow" };
  const r = classifyActivateTarget(d);
  check("<a href role='button'>Follow</a> (role overrides link semantics): REFUSE", r.allow === false, JSON.stringify(r));
}
{
  // Deliberately-authored aria-label on an otherwise-structural nav link still refuses.
  const d = { ...base(), tag: "a", href: "/i/user/123", ariaLabel: "Like" };
  const r = classifyActivateTarget(d);
  check("<a href aria-label='Like'> (deliberately labeled account-state link): REFUSE", r.allow === false, JSON.stringify(r));
}
{
  // Reddit's "N comments" thread-open link — incidental text, still a structural nav link, still allows.
  const d = { ...base(), tag: "a", href: "/r/foo/comments/abc123/some_title/", text: "5 comments" };
  const r = classifyActivateTarget(d);
  check("Reddit 'N comments' thread-open <a href> (incidental text): ALLOW", r.allow === true, JSON.stringify(r));
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 4. POLICY MATCHING — host-scoped consumer allowlist.
// ════════════════════════════════════════════════════════════════════════════════════════════════
{
  const policy = { allow: [{ hosts: ["x.com"], testids: ["reply"] }] };
  const onX = { ...base(), tag: "button", testid: "reply", pageUrl: "https://x.com/home" };
  const rOnX = classifyActivateTarget(onX, policy);
  check("POLICY — host-scoped entry allows [data-testid=reply] on x.com", rOnX.allow === true, JSON.stringify(rOnX));

  const onOtherHost = { ...base(), tag: "button", testid: "reply", pageUrl: "https://not-x.example/home" };
  const rOther = classifyActivateTarget(onOtherHost, policy);
  check("POLICY — same testid on a DIFFERENT host: REFUSE (host-scoping enforced)", rOther.allow === false, JSON.stringify(rOther));

  const subdomain = { ...base(), tag: "button", testid: "reply", pageUrl: "https://mobile.x.com/home" };
  const rSub = classifyActivateTarget(subdomain, policy);
  check("POLICY — host entry suffix-matches a subdomain (mobile.x.com)", rSub.allow === true, JSON.stringify(rSub));
}
{
  const policy = { allow: [{ hosts: ["x.com", "twitter.com"], testids: ["reply", "tweetTextarea_0"] }] };
  const composer = { ...base(), tag: "div", role: "textbox", testid: "tweetTextarea_0", pageUrl: "https://x.com/compose/tweet" };
  const rNoPolicy = classifyActivateTarget(composer);
  check("POLICY — tweetTextarea_0 with NO policy: REFUSE", rNoPolicy.allow === false, JSON.stringify(rNoPolicy));
  const rWithPolicy = classifyActivateTarget(composer, policy);
  check("POLICY — tweetTextarea_0 allows ONLY via policy", rWithPolicy.allow === true, JSON.stringify(rWithPolicy));
}
{
  // aria-label-based policy match (LinkedIn comment-toolbar case shape).
  const policy = { allow: [{ hosts: ["linkedin.com"], ariaLabels: ["Comment"] }] };
  const d = { ...base(), tag: "button", ariaLabel: "Comment", pageUrl: "https://www.linkedin.com/feed/" };
  const r = classifyActivateTarget(d, policy);
  check("POLICY — aria-label match on the right host: ALLOW", r.allow === true, JSON.stringify(r));
  const dWrongHost = { ...base(), tag: "button", ariaLabel: "Comment", pageUrl: "https://example.com/feed/" };
  const rWrongHost = classifyActivateTarget(dWrongHost, policy);
  check("POLICY — aria-label match on the WRONG host: REFUSE", rWrongHost.allow === false, JSON.stringify(rWrongHost));
}
{
  // A hostless entry (no `hosts` field) applies to ANY host.
  const policy = { allow: [{ testids: ["anyHostTestid"] }] };
  const d = { ...base(), tag: "button", testid: "anyHostTestid", pageUrl: "https://anything.example/whatever" };
  const r = classifyActivateTarget(d, policy);
  check("POLICY — hostless entry (no `hosts` field) matches any host", r.allow === true, JSON.stringify(r));
}
{
  // A policy entry can NEVER reach a form-submit control — proven again here with a REALISTIC
  // policy shape (mirrors cadence's CADENCE_ACTIVATE_POLICY), not just a synthetic testid.
  const policy = { allow: [{ hosts: ["x.com"], testids: ["reply", "tweetTextarea_0"] }] };
  const submitDisguised = { ...base(), tag: "button", type: "submit", inForm: true, isFormSubmitTrigger: true, testid: "reply", pageUrl: "https://x.com/home" };
  const r = classifyActivateTarget(submitDisguised, policy);
  check("POLICY cannot rescue a form-submit shape even under a matching host+testid", r.allow === false, JSON.stringify(r));
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 5. SECURITY-REVIEW FIX PROOFS (LS-31/S1 follow-up) — D1 (deny + own-title defense-in-depth on
//    real-href GET-action anchors), D2 (role="link" now requires a real href), D3 (a narrow
//    selector-based allow rescue for a known-safe control that structurally reads as unsafe), plus
//    the floor/deny precedence proofs the review asked for.
// ════════════════════════════════════════════════════════════════════════════════════════════════

// ── D1(i): a real-href GET-action anchor with NO aria-label/title (HN's actual DOM shape — the
//    "upvote"-style title lives on a CHILD element the probe never reads) REFUSES once a consumer
//    denies it by selector. `matchedSelectors` here stands in for what a real `element.matches()`
//    probe would report for this element against the policy's deny selector — this file tests the
//    pure classifier, not the DOM read itself (that's session.ts's job, exercised end-to-end in
//    test/activate-gate-acceptance.mjs). ──
{
  const HN_DENY_POLICY = { deny: [{ hosts: ["news.ycombinator.com"], selectors: ["a.clicky", 'a[href^="vote?"]'] }] };
  const hnVoteAnchor = {
    ...base(),
    tag: "a",
    href: "vote?id=1&how=up&auth=abcd1234",
    role: null,
    ariaLabel: null,
    title: null,
    text: "",
    pageUrl: "https://news.ycombinator.com/item?id=1",
    matchedSelectors: ["a.clicky", 'a[href^="vote?"]'],
  };
  const rDenied = classifyActivateTarget(hnVoteAnchor, HN_DENY_POLICY);
  check("D1 — HN vote anchor (a#up_1.clicky[href^='vote'], no aria-label/title) REFUSES via a consumer deny selector", rDenied.allow === false, JSON.stringify(rDenied));
  check("D1 — HN vote-anchor deny refusal reason names the deny mechanism", rDenied.allow === false && /policy\.deny/.test(rDenied.reason), rDenied.reason);

  // Without the deny policy, this exact real-href anchor would structurally ALLOW (no aria-label/title
  // to catch it) — this is precisely the hole D1 closes; documented here, not exercised as a "pass".
  const rNoDenyPolicy = classifyActivateTarget(hnVoteAnchor, undefined);
  check("D1 — the SAME HN vote anchor with NO deny policy: ALLOWS structurally (documents the exact hole `policy.deny` closes)", rNoDenyPolicy.allow === true, JSON.stringify(rNoDenyPolicy));

  // HN's thread-open and per-comment reply links are real-href anchors too, but don't match the deny
  // selectors — they must keep ALLOWing under the SAME deny-bearing policy.
  const hnThreadLink = { ...base(), tag: "a", href: "item?id=1", text: "39 comments", pageUrl: "https://news.ycombinator.com/", matchedSelectors: [] };
  const rThread = classifyActivateTarget(hnThreadLink, HN_DENY_POLICY);
  check("D1 — HN 'N comments' thread-open link still ALLOWS under the deny-bearing policy (deny is narrow, not a blanket HN refusal)", rThread.allow === true, JSON.stringify(rThread));

  const hnReplyLink = { ...base(), tag: "a", href: "reply?id=1&goto=item%3Fid%3D1", text: "reply", pageUrl: "https://news.ycombinator.com/item?id=1", matchedSelectors: [] };
  const rReply = classifyActivateTarget(hnReplyLink, HN_DENY_POLICY);
  check("D1 — HN per-comment 'reply' link (real href, opens the reply form) still ALLOWS under the deny-bearing policy", rReply.allow === true, JSON.stringify(rReply));
}

// ── D1(ii): defense-in-depth — an anchor's OWN `title` (not a child's) matching the tight action-word
//    list refuses even with NO deny entry at all. ──
{
  const dTitleUp = { ...base(), tag: "a", href: "/vote?id=1&how=up", title: "upvote", pageUrl: "https://example.com/" };
  const rUp = classifyActivateTarget(dTitleUp);
  check("D1(ii) — anchor with OWN title='upvote' (no deny policy): REFUSE (title defense-in-depth)", rUp.allow === false, JSON.stringify(rUp));

  const dTitleDown = { ...base(), tag: "a", href: "/vote?id=1&how=down", title: "downvote", pageUrl: "https://example.com/" };
  const rDown = classifyActivateTarget(dTitleDown);
  check("D1(ii) — anchor with OWN title='downvote' (no deny policy): REFUSE (title defense-in-depth)", rDown.allow === false, JSON.stringify(rDown));

  const dTitleFlag = { ...base(), tag: "a", href: "/flag?id=1", title: "flag", pageUrl: "https://example.com/" };
  const rFlag = classifyActivateTarget(dTitleFlag);
  check("D1(ii) — anchor with OWN title='flag' (no deny policy): REFUSE (title defense-in-depth)", rFlag.allow === false, JSON.stringify(rFlag));

  // A nav link whose title is innocuous still allows — proves title-checking didn't turn into a
  // blanket "any title refuses" rule.
  const dTitleBenign = { ...base(), tag: "a", href: "/next", title: "Go to the next page", pageUrl: "https://example.com/" };
  const rBenign = classifyActivateTarget(dTitleBenign);
  check("D1(ii) — nav link with an innocuous title: still ALLOWS", rBenign.allow === true, JSON.stringify(rBenign));
}

// ── D2: bare `role="link"` now REQUIRES a real href too — 3 shapes that used to bypass the
//    real-href tightening all REFUSE. ──
{
  const d1 = { ...base(), tag: "a", href: "#", role: "link", text: "Like" };
  const r1 = classifyActivateTarget(d1);
  check('D2 — <a href="#" role="link" onclick=like>: REFUSE (href="#" is not real)', r1.allow === false, JSON.stringify(r1));

  const d2 = { ...base(), tag: "span", role: "link", href: null, text: "Connect" };
  const r2 = classifyActivateTarget(d2);
  check('D2 — <span role="link">Connect</span> (no href at all): REFUSE', r2.allow === false, JSON.stringify(r2));

  const d3 = { ...base(), tag: "a", href: "javascript:void(0)", role: "link", text: "Follow" };
  const r3 = classifyActivateTarget(d3);
  check('D2 — <a href="javascript:void(0)" role="link">: REFUSE', r3.allow === false, JSON.stringify(r3));

  // Sanity: role="link" WITH a genuine real href still ALLOWS — the fix narrows, it doesn't remove,
  // the role="link" carve-out.
  const d4 = { ...base(), tag: "span", role: "link", href: "/thread/123", text: "5 comments" };
  const r4 = classifyActivateTarget(d4);
  check('D2 — role="link" WITH a real href (non-<a> element): still ALLOWS', r4.allow === true, JSON.stringify(r4));
}

// ── D3: a narrow selector-based allow rescues old.reddit's per-comment reply toggle (real DOM shape:
//    no real href, no testid, no aria-label — none of ActivatePolicy's other fields can reach it), and
//    a companion proof that the same selector-bearing policy does NOT rescue a save/report/vote anchor
//    in the same comment block (the selector is narrow, not a blanket `<a onclick>` allow). ──
{
  const REDDIT_REPLY_SELECTOR = '.comment a[onclick*="reply("]';
  const REDDIT_POLICY = { allow: [{ hosts: ["reddit.com"], selectors: [REDDIT_REPLY_SELECTOR] }] };

  const replyToggle = {
    ...base(),
    tag: "a",
    href: "javascript:void(0)",
    text: "reply",
    pageUrl: "https://old.reddit.com/r/foo/comments/abc123/some_title/",
    matchedSelectors: [REDDIT_REPLY_SELECTOR],
  };
  const rReplyNoPolicy = classifyActivateTarget(replyToggle);
  check("D3 — reddit per-comment reply toggle with NO policy: REFUSE (no real href, no testid/aria-label)", rReplyNoPolicy.allow === false, JSON.stringify(rReplyNoPolicy));
  const rReplyWithPolicy = classifyActivateTarget(replyToggle, REDDIT_POLICY);
  check("D3 — reddit per-comment reply toggle ALLOWS via the narrow selector policy", rReplyWithPolicy.allow === true, JSON.stringify(rReplyWithPolicy));

  // Companion: a save/report/vote anchor IN THE SAME comment block, under the SAME policy — its
  // onclick doesn't contain "reply(" so `element.matches()` would never report the selector as
  // matched (simulated here by simply omitting it from matchedSelectors, exactly as a real DOM
  // probe would for this element).
  for (const [label, onclickAction] of [["save", "save"], ["report", "report"], ["upvote", "vote"]]) {
    const actionAnchor = {
      ...base(),
      tag: "a",
      href: "javascript:void(0)",
      text: label,
      pageUrl: "https://old.reddit.com/r/foo/comments/abc123/some_title/",
      matchedSelectors: [], // the REDDIT_REPLY_SELECTOR does NOT match this element's onclick
    };
    const r = classifyActivateTarget(actionAnchor, REDDIT_POLICY);
    check(`D3 — reddit '${onclickAction}' comment-action anchor (same policy, same page) still REFUSES (selector is narrow, not a blanket <a onclick> allow)`, r.allow === false, JSON.stringify(r));
  }
}

// ── Precedence proofs the review explicitly asked for ──
{
  // A floor control that ALSO matches an allow-selector: the floor still wins (step 1 returns before
  // step 4's selector check ever runs).
  const policy = { allow: [{ selectors: ['button[type="submit"]'] }] };
  const d = { ...base(), tag: "button", type: "submit", isFormSubmitTrigger: true, matchedSelectors: ['button[type="submit"]'] };
  const r = classifyActivateTarget(d, policy);
  check("PRECEDENCE — floor control that ALSO matches an allow-selector: still REFUSE (floor overrides allow)", r.allow === false, JSON.stringify(r));
}
{
  // A control matching BOTH a deny selector and an allow selector: deny wins (checked at step 2,
  // before the consumer-allowlist step 4 is ever reached).
  const policy = { deny: [{ selectors: [".both"] }], allow: [{ selectors: [".both"] }] };
  const d = { ...base(), tag: "button", matchedSelectors: [".both"] };
  const r = classifyActivateTarget(d, policy);
  check("PRECEDENCE — element matching BOTH a deny selector and an allow selector: REFUSE (deny wins)", r.allow === false, JSON.stringify(r));
}

// ── the refusal message directs to the gated paths, and mentions the policy escape hatch ──
{
  const msg = describeActivateRefusal('[data-testid="foo"]', "not a recognized navigation/disclosure affordance");
  check("refusal message names the selector", msg.includes("foo"), msg);
  check("refusal message directs to the gated send()", /gated `send\(\)`/.test(msg), msg);
  check("refusal message states account-state actions are not automatable", /account-state actions are not automatable/.test(msg), msg);
  check("refusal message mentions activatePolicy", /activatePolicy/.test(msg), msg);
}

// ── belt-and-suspenders hard assertions (fails loudly under `node --test` too) ──────────────────
assert.equal(classifyActivateTarget({ ...base(), tag: "button", text: "Foo" }).allow, false); // arbitrary word
assert.equal(classifyActivateTarget({ ...base(), tag: "button", text: "Connect" }).allow, false);
assert.equal(classifyActivateTarget({ ...base(), tag: "button", type: "submit", inForm: true, isFormSubmitTrigger: true, testid: "x" }, { allow: [{ testids: ["x"] }] }).allow, false);
assert.equal(classifyActivateTarget({ ...base(), tag: "a", href: "/next" }).allow, true);
assert.equal(classifyActivateTarget({ ...base(), tag: "button", ariaExpanded: "false" }).allow, true);
assert.equal(classifyActivateTarget({ ...base(), tag: "textarea" }).allow, true);
assert.equal(
  classifyActivateTarget({ ...base(), tag: "button", testid: "reply", pageUrl: "https://x.com/home" }, { allow: [{ hosts: ["x.com"], testids: ["reply"] }] }).allow,
  true,
);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

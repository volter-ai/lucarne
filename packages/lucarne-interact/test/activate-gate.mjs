// LS-28 dev/01 — the `activate()` structural target classifier (Chrome-free).
//
// Proves `classifyActivateTarget` (activate-gate.ts) is a default-refuse decision table: any
// form-submit control, per-site or generic compose/send/post/reply/DM control, or per-site/generic
// account-state affordance (like/follow/repost/subscribe/bookmark/block/vote) is REFUSED, while
// plain navigation (`<a href>`, disclosure/expand buttons, tab/menu nav) stays ALLOWED. This is the
// pure decision logic `session.ts#activate()` calls after its read-only in-page probe resolves the
// element descriptor — no Playwright, no browser, so this table runs entirely offline under `npm
// test`. The Chrome-gated end-to-end proof (a real `<form>` submit + an X-like tweetButton actually
// refused, zero keypress, while nav still works) lives in test/activate-gate-acceptance.mjs
// (`npm run test:acceptance`).
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
});

// ── the binding matrix, straight from the brief ─────────────────────────────────────────────────

// 1. X's tweetButton → refuse
{
  const d = { ...base(), tag: "button", testid: "tweetButton", ariaLabel: "Post" };
  const r = classifyActivateTarget(d);
  check("tweetButton (X compose/submit testid): REFUSE", r.allow === false, JSON.stringify(r));
  check("tweetButton: reason mentions the testid", r.allow === false && r.reason.includes("tweetButton"));
}
{
  const d = { ...base(), tag: "button", testid: "tweetButtonInline", ariaLabel: "Reply" };
  const r = classifyActivateTarget(d);
  check("tweetButtonInline (X reply-send testid): REFUSE", r.allow === false, JSON.stringify(r));
}

// 2. a <form> submit button → refuse
{
  const d = { ...base(), tag: "button", type: "submit", inForm: true, isFormSubmitTrigger: true, text: "Submit" };
  const r = classifyActivateTarget(d);
  check("<button type=submit> in a <form>: REFUSE", r.allow === false, JSON.stringify(r));
}
{
  // the HTML default: a <button> with NO explicit type inside a <form> IS a submit trigger
  const d = { ...base(), tag: "button", type: null, inForm: true, isFormSubmitTrigger: true, text: "Go" };
  const r = classifyActivateTarget(d);
  check("<button> with no explicit type, default-submit inside a <form>: REFUSE", r.allow === false, JSON.stringify(r));
}
{
  // <input type=submit> — even the bare [type=submit] generic heuristic, regardless of ancestry
  const d = { ...base(), tag: "input", type: "submit", inForm: false, isFormSubmitTrigger: true };
  const r = classifyActivateTarget(d);
  check("<input type=submit>: REFUSE (generic [type=submit] heuristic)", r.allow === false, JSON.stringify(r));
}
{
  // <input type=image> — an image-submit control
  const d = { ...base(), tag: "input", type: "image", inForm: true, isFormSubmitTrigger: true };
  const r = classifyActivateTarget(d);
  check("<input type=image> (image submit): REFUSE", r.allow === false, JSON.stringify(r));
}
{
  // HN/Reddit-style: <input type=submit value="reply"> for a comment form
  const d = { ...base(), tag: "input", type: "submit", inForm: true, isFormSubmitTrigger: true, text: "reply" };
  const r = classifyActivateTarget(d);
  check("HN-style <input type=submit value=reply>: REFUSE", r.allow === false, JSON.stringify(r));
}

// 3. like → refuse
{
  const d = { ...base(), tag: "button", testid: "like", ariaLabel: "Like" };
  const r = classifyActivateTarget(d);
  check("like (X account-state testid): REFUSE", r.allow === false, JSON.stringify(r));
}
{
  const d = { ...base(), tag: "div", role: "button", ariaLabel: "Like this post" };
  const r = classifyActivateTarget(d);
  check("generic aria-label 'Like this post' (no testid): REFUSE", r.allow === false, JSON.stringify(r));
}

// 4. follow → refuse
{
  const d = { ...base(), tag: "button", testid: "follow", ariaLabel: "Follow @someone" };
  const r = classifyActivateTarget(d);
  check("follow (X account-state testid): REFUSE", r.allow === false, JSON.stringify(r));
}
{
  const d = { ...base(), tag: "button", ariaLabel: "Follow" };
  const r = classifyActivateTarget(d);
  check("generic aria-label 'Follow' (no testid): REFUSE", r.allow === false, JSON.stringify(r));
}

// additional account-state coverage: repost/retweet, subscribe, bookmark, block, vote
for (const [label, d] of [
  ["retweet (testid)", { ...base(), tag: "button", testid: "retweet" }],
  ["repost (generic aria-label)", { ...base(), tag: "button", ariaLabel: "Repost" }],
  ["subscribe (generic aria-label)", { ...base(), tag: "button", ariaLabel: "Subscribe to this thread" }],
  ["bookmark (testid)", { ...base(), tag: "button", testid: "bookmark" }],
  ["block (testid)", { ...base(), tag: "button", testid: "block" }],
  ["upvote (Reddit-style aria-label)", { ...base(), tag: "button", ariaLabel: "upvote" }],
  ["downvote (Reddit-style aria-label)", { ...base(), tag: "button", ariaLabel: "downvote" }],
]) {
  const r = classifyActivateTarget(d);
  check(`${label}: REFUSE`, r.allow === false, JSON.stringify(r));
}

// generic compose/submit-by-name coverage (Reddit/HN comment forms, DM send, etc — no per-site testid)
for (const [label, d] of [
  ["Reddit-style 'Comment' submit button", { ...base(), tag: "button", text: "Comment" }],
  ["generic 'Post' button", { ...base(), tag: "button", ariaLabel: "Post" }],
  ["generic 'Send' (DM) button", { ...base(), tag: "button", ariaLabel: "Send" }],
  ["generic 'Publish' button", { ...base(), tag: "button", text: "Publish" }],
  ["generic 'Share your thoughts' composer trigger", { ...base(), tag: "button", ariaLabel: "Share your thoughts" }],
]) {
  const r = classifyActivateTarget(d);
  check(`${label}: REFUSE`, r.allow === false, JSON.stringify(r));
}

// 5. `<a href>` → allow
{
  const d = { ...base(), tag: "a", href: "/next", role: "link", text: "go to next page" };
  const r = classifyActivateTarget(d);
  check("<a href> (plain navigation link): ALLOW", r.allow === true, JSON.stringify(r));
}
{
  const d = { ...base(), tag: "a", href: "/home", testid: "AppTabBar_Home_Link", ariaLabel: "Home" };
  const r = classifyActivateTarget(d);
  check("<a href> tab-bar navigation link: ALLOW", r.allow === true, JSON.stringify(r));
}

// ── regression: navigation links whose INCIDENTAL text/testid contains a generic-regex word must
// still ALLOW — this is the false-positive a naive "check all visible text" design would introduce
// (cadence's Reddit guide documents exactly these two flows: channels/reddit/guide.md:16,25). ──
{
  // Reddit's "N comments" thread-open link — a pure navigation count-label, not a submit/compose act.
  const d = { ...base(), tag: "a", href: "/r/foo/comments/abc123/some_title/", text: "5 comments" };
  const r = classifyActivateTarget(d);
  check("Reddit 'N comments' thread-open <a href> (incidental 'comment' substring): ALLOW", r.allow === true, JSON.stringify(r));
}
{
  // Reddit's per-comment "reply" link — opens an inline reply FORM (disclosure), doesn't itself submit.
  const d = { ...base(), tag: "a", href: "#reply_t1_abc123", text: "reply" };
  const r = classifyActivateTarget(d);
  check("Reddit per-comment 'reply' disclosure <a href> (incidental 'reply' text): ALLOW", r.allow === true, JSON.stringify(r));
}
{
  // But an explicit aria-label authored directly onto a link IS still honored — the rare real case
  // of a link-styled account-state affordance.
  const d = { ...base(), tag: "a", href: "/i/user/123", ariaLabel: "Like" };
  const r = classifyActivateTarget(d);
  check("<a href aria-label='Like'> (deliberately labeled account-state link): REFUSE", r.allow === false, JSON.stringify(r));
}
{
  // An anchor whose role is overridden to something action-like is NOT treated as a nav link — full
  // word-matching still applies.
  const d = { ...base(), tag: "a", href: "#", role: "button", text: "Follow" };
  const r = classifyActivateTarget(d);
  check("<a href role='button'>Follow</a> (role overrides link semantics): REFUSE", r.allow === false, JSON.stringify(r));
}

// 6. expand-replies plain button → allow
{
  const d = { ...base(), tag: "button", ariaLabel: "Show 3 more replies", testid: "expandReplies" };
  const r = classifyActivateTarget(d);
  check("expand-replies plain button ('Show 3 more replies'): ALLOW", r.allow === true, JSON.stringify(r));
}
{
  const d = { ...base(), tag: "button", text: "Show more", ariaLabel: null };
  const r = classifyActivateTarget(d);
  check("generic 'Show more' disclosure button: ALLOW", r.allow === true, JSON.stringify(r));
}
{
  const d = { ...base(), tag: "button", role: "tab", text: "Media" };
  const r = classifyActivateTarget(d);
  check("tab-navigation button ('Media' profile tab): ALLOW", r.allow === true, JSON.stringify(r));
}
{
  const d = { ...base(), tag: "div", role: "menuitem", text: "Settings" };
  const r = classifyActivateTarget(d);
  check("menu-navigation item ('Settings'): ALLOW", r.allow === true, JSON.stringify(r));
}
{
  // a plain <button> with NO type, NOT inside a form — does nothing on its own (HTML default
  // outside a form is "button", not "submit") — must still allow.
  const d = { ...base(), tag: "button", type: null, inForm: false, isFormSubmitTrigger: false, text: "Expand" };
  const r = classifyActivateTarget(d);
  check("plain <button> outside any <form> (no submit semantics): ALLOW", r.allow === true, JSON.stringify(r));
}

// ── the refusal message directs to the gated paths ──────────────────────────────────────────────
{
  const msg = describeActivateRefusal('[data-testid="tweetButton"]', "known compose/submit control");
  check("refusal message names the selector", msg.includes('tweetButton'), msg);
  check("refusal message directs to the gated send()", /gated `send\(\)`/.test(msg), msg);
  check("refusal message states account-state actions are not automatable", /account-state actions are not automatable/.test(msg), msg);
}

// ── belt-and-suspenders hard assertions (fails loudly under `node --test` too) ──────────────────
assert.equal(classifyActivateTarget({ ...base(), tag: "button", testid: "tweetButton" }).allow, false);
assert.equal(classifyActivateTarget({ ...base(), tag: "button", type: "submit", isFormSubmitTrigger: true }).allow, false);
assert.equal(classifyActivateTarget({ ...base(), tag: "button", testid: "like" }).allow, false);
assert.equal(classifyActivateTarget({ ...base(), tag: "button", testid: "follow" }).allow, false);
assert.equal(classifyActivateTarget({ ...base(), tag: "a", href: "/next" }).allow, true);
assert.equal(classifyActivateTarget({ ...base(), tag: "button", ariaLabel: "Show 3 more replies" }).allow, true);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

// activate-gate.ts — LS-28: the structural, default-refuse target classifier for `activate()`.
//
// The safety hole this closes: `InteractSession.activate(selector)` was byte-identical to the
// GATED send-submit gesture (`session.ts`'s `pressSubmit`) — `locator(sel).first().press("Enter")`
// with only the pacing wrapper, NO `decideSend`/approval/content/rate/burst/composer guard. So
// `type("banned text")` + `activate("<submit-button-selector>")` could publish a reply/comment/
// tweet, or flip account state (like/follow/repost/...), with zero gate. Convention ("use `send`
// to send") is not a structural guarantee — this module makes it one.
//
// `activate` stays usable for NAVIGATION (open a post/thread, expand replies, follow an in-page
// link) but STRUCTURALLY REFUSES any target whose activation could (a) submit composed content or
// (b) change account state. `session.ts#activate()` runs a fixed, read-only in-page probe
// (tag/type/role/attrs/ancestry/testid/aria-label — NOT a general eval surface) on the located
// element, then hands the resulting descriptor to `classifyActivateTarget` below — a PURE function,
// no Playwright, no browser — so the decision logic is fully unit-testable (test/activate-gate.mjs)
// and runs under `npm test` with no Chrome required.
//
// DEFAULT-REFUSE only for the submit/action classes documented on each check below; everything else
// (plain buttons, `<a href>`, disclosure/expand controls, tab/menu navigation) allows, unchanged.

/** What `session.ts`'s read-only in-page probe reports about the element `activate()` located. */
export interface ActivateTargetDescriptor {
  /** Lower-cased tag name, e.g. "button", "a", "input", "div". */
  tag: string;
  /** The element's `type` attribute (buttons/inputs), or null. */
  type?: string | null;
  /** The element's `role` attribute, or null. */
  role?: string | null;
  /** `data-testid` (or `data-test-id`), or null. */
  testid?: string | null;
  /** `aria-label`, or null. */
  ariaLabel?: string | null;
  /** `href` (anchors), or null. */
  href?: string | null;
  /** Trimmed visible text content, bounded — part of the "accessible name" signal. */
  text?: string | null;
  /** True if the element sits inside a `<form>` (via `closest("form")`). */
  inForm: boolean;
  /**
   * True if the probe determined this element IS the form's submit trigger: a `<button>` with no
   * explicit `type` (the HTML default inside a form is "submit") or an explicit `type="submit"`,
   * or an `<input type="submit"|"image">`.
   */
  isFormSubmitTrigger: boolean;
}

export type ActivateDecision = { allow: true } | { allow: false; reason: string };

// ── per-site known testids (checked verbatim, case-sensitive — the sites' own casing) ──────────

// The core distinction (LS-28 refinement): a control that OPENS a composer (X's reply button)
// PUBLISHES NOTHING — the actual publish is a SEPARATE, later gesture (X's `tweetButton`, a
// `<button type=submit>`, ...). Refusing the compose-open button adds zero safety (the draft isn't
// sent by opening a box) while breaking the documented reply flow. BUT compose-open is allowed ONLY
// via an explicit, known-safe per-site testid allowlist (`SITE_COMPOSE_OPEN_TESTIDS`, checked FIRST
// below) — NOT by globally un-refusing the words: a bare-label actionable button with no known
// testid and no `<form>` (`<button>Post</button>`, `<div role="button">Tweet</div>`) is AMBIGUOUS,
// and the module's default-refuse contract for this HIGH-severity invariant requires it to REFUSE
// (a false ALLOW there is an ungated-publish hole). Only two paths allow an actionable control:
// (a) an explicit compose-open testid, or (b) `<a href>`/`role=link` NAV whose refuse-signal is
// merely INCIDENTAL text (Reddit's "5 comments"/"reply" link labels — see `isNavLink`).

/** X/Twitter: known PUBLISH controls (these actually SUBMIT composed content). */
const SITE_SUBMIT_TESTIDS = new Set(["tweetButton", "tweetButtonInline", "tweetButtonInline2", "dmComposerSendButton"]);

/**
 * X/Twitter: known COMPOSE-OPEN controls — they reveal/focus a composer but publish nothing. These
 * ALLOW (navigation), and are listed explicitly so the generic net can never catch them. The real
 * publish (`tweetButton*`, above) is what stays refused.
 */
const SITE_COMPOSE_OPEN_TESTIDS = new Set(["reply"]);

/** X/Twitter: known account-state affordances. */
const SITE_ACCOUNT_STATE_TESTIDS = new Set([
  "like",
  "unlike",
  "retweet",
  "unretweet",
  "follow",
  "unfollow",
  "bookmark",
  "removeBookmark",
  "block",
  "unblock",
]);

// ── generic, site-agnostic accessible-name / testid patterns (fallback for actionable controls
// that aren't one of the per-site testids above). DEFAULT-REFUSE for the HIGH-severity invariant:
// an ambiguous actionable button/`[role=button]` whose name carries a submit/publish/compose signal
// must refuse. ──

/**
 * A publish/submit/compose CTA by name — INCLUDING the bare, ambiguous words `post`/`reply`/`tweet`/
 * `comment` (as whole words). These are restored to the refuse path deliberately: a bare-label
 * actionable control (`<button>Post</button>`, `<div role="button">Tweet</div>` — LinkedIn/Bluesky/
 * YouTube/SPA-generic publish buttons with no `<form>` and no known testid) would otherwise
 * DEFAULT-ALLOW and let `type(draft)` + `activate(that button)` publish ungated (the security
 * review's exploit class). The ONLY sanctioned way an actionable compose-open control is allowed is
 * an explicit, known-safe per-site testid in `SITE_COMPOSE_OPEN_TESTIDS` (checked FIRST, before this
 * regex) — NOT a global un-refusing of the words. `<a href>`/`role=link` NAV links are separately
 * exempt from this name-match on their INCIDENTAL text (see `isNavLink` below), so Reddit's
 * "5 comments"/"reply" nav-link labels still allow.
 *
 * Whole-word (`\b…\b`) matching keeps genuinely different words from tripping it: "replies" (an
 * expand-disclosure label) does NOT match `\breply\b`, "Repost" does NOT match `\bpost\b` (it is an
 * account-state control, caught by the account regex below), "comments" does NOT match `\bcomment\b`.
 */
const GENERIC_SUBMIT_RE = /\b(?:send|submit|publish|post|reply|tweet|comment)\b|share your/i;

/** An account-state-by-name control (like/follow/repost/subscribe/bookmark/vote/block). */
const GENERIC_ACCOUNT_STATE_RE = /like|unlike|follow|unfollow|repost|retweet|unretweet|subscribe|unsubscribe|bookmark|block|unblock|upvote|downvote|\bvote\b/i;

/**
 * Classify a probed `activate()` target: `{ allow: true }` for navigation, or
 * `{ allow: false, reason }` for anything that could submit composed content or change account
 * state. Pure — no I/O, no browser — deterministic on the descriptor alone.
 */
export function classifyActivateTarget(d: ActivateTargetDescriptor): ActivateDecision {
  const tag = (d.tag || "").toLowerCase();
  const type = (d.type || "").toLowerCase();
  const role = (d.role || "").toLowerCase();
  const testid = d.testid || "";

  // 1. Form-submit control — the generic structural heuristic: `<button type=submit>` (or a
  //    `<button>` with no explicit type, which defaults to "submit" inside a `<form>` — the probe
  //    folds that into `isFormSubmitTrigger`), or `<input type=submit|image>`. This check does NOT
  //    require `inForm` to be true — a bare `[type=submit]` control refuses regardless of ancestry.
  if (d.isFormSubmitTrigger || (tag === "button" && type === "submit") || (tag === "input" && (type === "submit" || type === "image"))) {
    return { allow: false, reason: "form-submit control (button/input type=submit, or the form's default submit trigger)" };
  }

  // 2. Per-site known PUBLISH/SUBMIT testid (X: tweetButton, tweetButtonInline, DM send) — these
  //    actually publish composed content. Exact-match against a small, deliberate set — checked
  //    regardless of tag, since these are precise site-authored identifiers (not generic words), so
  //    there is no navigation-link false-positive risk the way there is for the word-based checks below.
  if (testid && SITE_SUBMIT_TESTIDS.has(testid)) {
    return { allow: false, reason: `known publish/submit control (data-testid="${testid}")` };
  }

  // 3. Per-site known account-state testid (X: like, retweet, follow, bookmark, block, ...).
  if (testid && SITE_ACCOUNT_STATE_TESTIDS.has(testid)) {
    return { allow: false, reason: `known account-state control (data-testid="${testid}")` };
  }

  // 3b. Per-site known COMPOSE-OPEN testid (X: `reply` — opens the reply composer, publishes
  //     nothing). ALLOW, short-circuiting before the generic net so this compose-open affordance is
  //     never mistaken for a publish. The real publish (`tweetButton*`, checked at 2) stays refused;
  //     the eventual SEND still goes through the gated `send()`.
  if (testid && SITE_COMPOSE_OPEN_TESTIDS.has(testid)) {
    return { allow: true };
  }

  // A plain NAVIGATION link — `<a href>` with no role (or an explicit role="link"), or any element
  // explicitly marked `role="link"` — is exempt from the generic WORD-based checks below on its
  // INCIDENTAL visible text / testid. This is what keeps ordinary navigation intact: Reddit's
  // `"N comments"` thread-open link, or LinkedIn/X's `"N comments"`/`"N replies"` counters, contain
  // the substrings "comment"/"reply" purely as a COUNT LABEL, not because the link submits or acts —
  // matches the brief's explicit "ALLOW ... `<a href>`, role=link" navigation rule. An explicit
  // `aria-label` authored directly onto the link is still honored (the rare real case of a
  // link-styled account-state affordance, e.g. `<a aria-label="Like">`) — only its bare visible TEXT
  // and testid are exempted, not a deliberately-authored aria-label. An anchor whose role is
  // overridden to something action-like (`role="button"`, etc.) is NOT a nav link and gets the full
  // check, same as any other control.
  const isNavLink = (tag === "a" && !!d.href && (role === "" || role === "link")) || role === "link";
  const genericTestid = isNavLink ? "" : testid;
  // The "accessible name" proxy this probe can cheaply compute: aria-label first, else (for
  // non-nav-link controls) visible text.
  const genericName = isNavLink ? d.ariaLabel || "" : [d.ariaLabel, d.text].filter(Boolean).join(" ");

  // 4. Generic publish/submit/compose-by-name (testid or accessible-name match). Includes the bare
  //    ambiguous words post/reply/tweet/comment (whole-word) — the DEFAULT-REFUSE net for a
  //    bare-label actionable button that isn't caught by the structural form-submit net or an
  //    explicit compose-open testid (which was already checked, and allows, at 3b above).
  if (GENERIC_SUBMIT_RE.test(genericTestid) || GENERIC_SUBMIT_RE.test(genericName)) {
    return {
      allow: false,
      reason: "publish/submit/compose control (accessible name/testid matches send|submit|publish|post|reply|tweet|comment)",
    };
  }

  // 5. Generic account-state-by-name.
  if (GENERIC_ACCOUNT_STATE_RE.test(genericTestid) || GENERIC_ACCOUNT_STATE_RE.test(genericName)) {
    return {
      allow: false,
      reason: "account-state control (accessible name/testid matches like|follow|repost|subscribe|bookmark|vote|block)",
    };
  }

  // Everything else — `<a href>`, role=link, plain non-submit buttons (disclosure/expand), tab/menu
  // navigation — is navigation and stays allowed.
  return { allow: true };
}

/**
 * The refusal Error message `session.ts#activate()` throws — directs the caller to the actually
 * gated paths (LS-28's binding requirement: no ungated path can submit or change account state).
 */
export function describeActivateRefusal(selector: string, reason: string): string {
  return (
    `activate(): refused — ${reason} (selector: ${selector}). ` +
    "to send a composed draft use the gated `send()`; account-state actions are not automatable — do them yourself."
  );
}

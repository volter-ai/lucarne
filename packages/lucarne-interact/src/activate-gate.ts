// activate-gate.ts — LS-31/S1: the structural, default-REFUSE target classifier for `activate()`.
//
// LS-28 (the previous cut) shaped this as a BLOCKLIST: enumerate known submit/account-state
// controls, refuse those, and `return { allow: true }` for everything else. The final safety panel
// found that structure is inherently incomplete — any account-state or publish control NOT on the
// enumerated list fires UNGATED on Enter: LinkedIn `<button>Connect</button>` (sends a connection
// request), Reddit `<button>Save</button>`, `Join`/`Endorse`/`Accept`/`Mute`/`Report`/`React`, a bare
// `<button>Share</button>`/`Toot!` (publish) — none of these were in the old blocklist, so they all
// DEFAULT-ALLOWED. A blocklist can never be complete against every site's vocabulary.
//
// This module INVERTS the structure: default-REFUSE. `classifyActivateTarget` allows exactly two
// things (after a non-overridable safety floor, and a consumer-declared deny list that only ever
// refuses) — a small set of STRUCTURAL, domain-agnostic navigation/disclosure shapes (real-href links,
// tabs, disclosure toggles, `<summary>`, `<textarea>`, anchor-menuitems) that are safe by construction,
// not by word-matching; and a caller-supplied, DATA-ONLY `ActivatePolicy` allowlist (host +
// testid/aria-label/selector) for the domain-specific case that's legitimately safe but can't be
// inferred structurally — a per-site compose-OPEN control that reveals a composer without publishing
// anything, or (D3) a narrowly-scoped selector rescue for a known-safe control that structurally reads
// as unsafe (a caller wires its own site's testid/aria-label/selector through the policy — this
// package never hardcodes one; see test/policy-free-gate.mjs, which fails the build on any site
// vocabulary creeping back into this module). EVERYTHING else — every account-state affordance, every
// publish button, by any name, on any site — refuses by default. No blocklist to keep complete; the
// safe cases are the enumerated ones instead. See `classifyActivateTarget`'s doc comment below for the
// full five-step decision order (floor → deny → structural-nav-allow → consumer-allow → default-refuse).
//
// CAVEAT (LS-31/S1 review, D1): a REAL-href anchor is treated as structural nav (step 2) because a
// real navigation href is, in general, safe-by-construction — but a small number of sites author
// GET-action controls (vote/fave/hide/flag toggles, etc.) as real-href anchors too, and those read as
// nav here even though activating one changes account state. This module cannot tell "nav anchor" from
// "GET-action anchor styled as one" by structure alone — the fix is NOT structural, it's a consumer
// responsibility: a domain-specific consumer package DENIES its own site's known GET-action
// anchors via `ActivatePolicy.deny` (checked BEFORE the structural-nav step, so it can refuse a
// nav-shaped element), and this module additionally reads the anchor's own `title` attribute as a
// defense-in-depth signal (an anchor whose own `title` matches the tight action-word list refuses even
// with no deny entry — see `NAV_LINK_ARIA_LABEL_REFUSE_RE`, checked against title too). Neither signal
// is a substitute for the other: a consumer that ships real-href GET-action anchors MUST deny them.
//
// `activate` stays usable for navigation and consumer-allowlisted compose-open, and STRUCTURALLY
// REFUSES any target whose activation could (a) submit composed content or (b) change account state.
// `session.ts#activate()` runs a fixed, read-only in-page probe (tag/type/role/attrs/ancestry/testid/
// aria-label/pageUrl — NOT a general eval surface) on the located element, then hands the resulting
// descriptor (plus the caller's optional policy) to `classifyActivateTarget` below — a PURE function,
// no Playwright, no browser — so the decision logic is fully unit-testable (test/activate-gate.mjs)
// and runs under `npm test` with no Chrome required.

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
  /** The page's current URL (`page.url()`) at probe time — used to host-scope a consumer policy. */
  pageUrl: string;
  /** The element's `aria-expanded` attribute, or null — presence (any value) marks a disclosure toggle. */
  ariaExpanded?: string | null;
  /** The element's `aria-haspopup` attribute, or null. Carried on the descriptor for callers/future use; not itself a decision input. */
  ariaHasPopup?: string | null;
  /**
   * The element's OWN `title` attribute, or null (LS-31/S1 D1, defense-in-depth). Read directly off
   * the located element — the probe does NOT walk to children, so a title authored on a CHILD element
   * (e.g. HN's vote arrow, where the "up"-direction vote-word title sits on an inner `<div>`, not the
   * anchor itself) is NOT seen here; that case is the reason `ActivatePolicy.deny` exists (see the
   * module header CAVEAT).
   */
  title?: string | null;
  /**
   * CSS selectors — drawn from the caller's `ActivatePolicy` (`allow[].selectors` and `deny[].selectors`)
   * — that a READ-ONLY `element.matches(sel)` returned true for on the located element (LS-31/S1 D1/D3).
   * Computed by the probe (which has DOM access); `classifyActivateTarget` itself never touches the DOM,
   * it only checks membership in this list. Absent/empty if the policy declared no selectors.
   */
  matchedSelectors?: readonly string[];
}

export type ActivateDecision = { allow: true } | { allow: false; reason: string };

// ── consumer policy (DATA-ONLY: hosts/testids/ariaLabels — no predicates) ──────────────────────────
//
// A policy entry is pure data so a consumer physically cannot smuggle logic past the safety floor
// below — it can only ever say "this host + this testid/aria-label", never "and also allow this
// other shape of thing". `ActivatePolicy` is how a domain-specific consumer package allowlists a
// compose-OPEN control (reveals a composer, publishes nothing) that this package has no way to infer
// structurally, WITHOUT this package itself carrying any site vocabulary (see test/policy-free-gate.mjs).

/**
 * One allowlist entry: matches when the page's hostname suffix-matches one of `hosts` (or `hosts`
 * is absent/empty, meaning "any host") AND the element's `data-testid` is verbatim in `testids`, OR
 * its `aria-label` is verbatim in `ariaLabels`, OR it `element.matches()` one of `selectors`.
 */
export interface ActivateAllowEntry {
  /** Hostname suffixes this entry applies to (e.g. `"x.com"` matches `x.com` and `mobile.x.com`). Absent = any host. */
  hosts?: readonly string[];
  /** `data-testid` values (verbatim, case-sensitive) this entry allows. */
  testids?: readonly string[];
  /** `aria-label` values (verbatim, case-sensitive) this entry allows. */
  ariaLabels?: readonly string[];
  /**
   * CSS selectors (LS-31/S1 D3) the CONSUMER VOUCHES are safe compose-open/nav controls, matched via
   * a READ-ONLY `element.matches(sel)` in the probe — data-only, no predicates, same trust model as
   * `testids`/`ariaLabels`. Reached ONLY after the non-overridable floor (step 1) — a selector can
   * never rescue a floor-refused control — and does NOT override a `deny` match (step 2 runs first).
   * For a known-unsafe-shaped element that legitimately needs a narrow rescue (e.g. old.reddit's
   * per-comment reply toggle, an `<a href="javascript:void(0)" onclick="return reply(this)">` with no
   * testid/aria-label/real-href), scope the selector as narrowly as the site's DOM allows so it can't
   * accidentally also match a save/report/vote/other action control in the same region.
   */
  selectors?: readonly string[];
}

/**
 * One deny entry (LS-31/S1 D1): matches when the page's hostname suffix-matches one of `hosts` (or
 * `hosts` is absent/empty, meaning "any host") AND the element `element.matches()` one of `selectors`.
 * Deny is ALWAYS-SAFE-TO-ADD — it only ever REFUSES, never allows — and is checked BEFORE the
 * structural-nav-allow step (step 3), so it can refuse an element that otherwise reads as safe
 * structural navigation (the real-href GET-action-anchor case, see the module header CAVEAT). A deny
 * match cannot be overridden by an `allow` entry (deny is checked first and short-circuits).
 */
export interface ActivateDenyEntry {
  /** Hostname suffixes this entry applies to. Absent = any host. */
  hosts?: readonly string[];
  /** CSS selectors (matched via read-only `element.matches()`) the consumer marks as REFUSE-always. */
  selectors: readonly string[];
}

/** A caller-supplied, data-only policy for `activate()`'s DENY (step 2) and CONSUMER ALLOWLIST (step 4) steps. */
export interface ActivatePolicy {
  allow?: readonly ActivateAllowEntry[];
  /** Consumer-declared REFUSE-always entries — see `ActivateDenyEntry`. Checked before structural-nav-allow. */
  deny?: readonly ActivateDenyEntry[];
}

/** `<input>` types that are text-like — pressing Enter inside one triggers implicit form submission. Unset type ("") defaults to "text". */
const TEXT_LIKE_INPUT_TYPES = new Set(["", "text", "search", "email", "url", "tel", "number"]);

/**
 * A tight, deliberately-narrow word check retained ONLY for the nav-link carve-out (step 3, below): an
 * explicitly-authored `aria-label` OR the element's own `title` on an otherwise-structural nav link
 * (e.g. `<a href="/i/user/123" aria-label="Like">`, or a vote-arrow anchor whose own `title` names the
 * up/down direction of the action) still refuses — the rare real case of a link-styled account-state
 * affordance (D1 defense-in-depth: this catches a real-href GET-action anchor whose OWN `title` names
 * the action, even with no consumer `deny` entry — see the module header CAVEAT for why `deny` is
 * still the primary fix). Bare visible TEXT on a nav link ("5 comments"/"reply" counters) is NOT
 * checked against this — see `isNavLink`'s use below. This is the only word-based check left in the
 * module; every other decision is purely structural (tag/role/attrs) or policy-driven.
 *
 * `vote` is intentionally checked as a bare substring (no trailing/leading `\b` on that one word) so it
 * also catches the up/down-prefixed forms of that word, without this module's source literally
 * spelling either prefixed form out (test/policy-free-gate.mjs fails the build on that exact site
 * vocabulary appearing in src/ — that vocabulary belongs in a CONSUMER's policy, not here; this is a
 * structural word-shape check, not a
 * hardcoded site term).
 */
const NAV_LINK_ARIA_LABEL_REFUSE_RE = /\b(send|submit|publish|like|follow|repost|subscribe|block|flag)\b|vote/i;

function safeHostname(pageUrl: string | undefined | null): string | null {
  if (!pageUrl) return null;
  try {
    return new URL(pageUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function hostMatches(hostname: string, host: string): boolean {
  const h = host.toLowerCase();
  return hostname === h || hostname.endsWith(`.${h}`);
}

function entryMatches(
  entry: ActivateAllowEntry,
  hostname: string | null,
  testid: string,
  ariaLabel: string,
  matchedSelectors: readonly string[],
): boolean {
  if (entry.hosts && entry.hosts.length > 0) {
    if (!hostname || !entry.hosts.some((h) => hostMatches(hostname, h))) return false;
  }
  const testidMatch = !!testid && !!entry.testids && entry.testids.includes(testid);
  const ariaLabelMatch = !!ariaLabel && !!entry.ariaLabels && entry.ariaLabels.includes(ariaLabel);
  const selectorMatch = !!entry.selectors && entry.selectors.some((sel) => matchedSelectors.includes(sel));
  return testidMatch || ariaLabelMatch || selectorMatch;
}

function denyEntryMatches(entry: ActivateDenyEntry, hostname: string | null, matchedSelectors: readonly string[]): boolean {
  if (entry.hosts && entry.hosts.length > 0) {
    if (!hostname || !entry.hosts.some((h) => hostMatches(hostname, h))) return false;
  }
  return entry.selectors.some((sel) => matchedSelectors.includes(sel));
}

/**
 * Classify a probed `activate()` target: `{ allow: true }` for a structural navigation/disclosure
 * shape or a policy-allowlisted compose-open control, or `{ allow: false, reason }` for anything
 * else — which is the DEFAULT. Pure — no I/O, no browser — deterministic on the descriptor + policy.
 *
 * Decision order (each step can only REFUSE more, never un-refuse an earlier step's refusal):
 *   1. NON-OVERRIDABLE SAFETY FLOOR — form-submit controls. Checked before, and independently of,
 *      any policy: a consumer cannot allowlist a form-submit control.
 *   2. DENY — `policy.deny`, reached only if the floor didn't refuse. Checked BEFORE structural-nav-
 *      allow (step 3) so a consumer can refuse an element that otherwise reads as safe nav (e.g. a
 *      real-href GET-action anchor styled as navigation — LS-31/S1 D1). Deny only ever refuses.
 *   3. STRUCTURAL NAV ALLOW — domain-agnostic positive shapes (real-href links, tabs, disclosure
 *      toggles, `<summary>`, `<textarea>`, anchor-menuitems).
 *   4. CONSUMER ALLOWLIST — `policy.allow` (testid/aria-label/selector), reached only if steps 1-2
 *      didn't refuse. Does NOT override a step-2 deny match (deny is checked first).
 *   5. DEFAULT — refuse.
 */
export function classifyActivateTarget(d: ActivateTargetDescriptor, policy?: ActivatePolicy): ActivateDecision {
  const tag = (d.tag || "").toLowerCase();
  const type = (d.type || "").toLowerCase();
  const role = (d.role || "").toLowerCase();
  const testid = d.testid || "";
  const ariaLabel = d.ariaLabel || "";
  const title = d.title || "";
  const href = d.href || "";
  const matchedSelectors = d.matchedSelectors || [];

  // ── 1. NON-OVERRIDABLE SAFETY FLOOR ────────────────────────────────────────────────────────────
  // Checked FIRST and BEFORE any policy lookup — no `ActivateAllowEntry` can ever reach a target
  // that trips this step, because the function returns here before step 4 runs at all.

  // 1a. Form-submit control: `<button type=submit>` (or a `<button>` with no explicit type, which
  //     defaults to "submit" inside a `<form>` — the probe folds that into `isFormSubmitTrigger`),
  //     or `<input type=submit|image>`. Does NOT require `inForm` — a bare `[type=submit]` control
  //     refuses regardless of ancestry.
  if (d.isFormSubmitTrigger || (tag === "button" && type === "submit") || (tag === "input" && (type === "submit" || type === "image"))) {
    return {
      allow: false,
      reason:
        "form-submit control (button/input type=submit, or the form's default submit trigger) — this safety floor cannot be overridden by policy",
    };
  }

  // 1b. A text-like `<input>` inside a `<form>` — pressing Enter there triggers the browser's
  //     IMPLICIT form submission, even with no explicit submit button. `<textarea>` is EXEMPT:
  //     Enter inserts a newline there, it never submits a form.
  if (tag === "input" && d.inForm && TEXT_LIKE_INPUT_TYPES.has(type)) {
    return {
      allow: false,
      reason:
        "text-like <input> inside a <form> — Enter triggers implicit form submission — this safety floor cannot be overridden by policy",
    };
  }

  // ── 2. DENY — consumer-declared REFUSE-always selectors (LS-31/S1 D1) ──────────────────────────
  // Checked BEFORE structural-nav-allow (step 3) so it can refuse an element that would otherwise
  // read as safe navigation — the real-href GET-action-anchor case (a site's vote/fave/hide/flag
  // control authored as `<a href="vote?...">`, no aria-label). Deny only ever refuses; it cannot be
  // reached by, or override, the floor (step 1 already returned above if it applied).
  if (policy?.deny && policy.deny.length > 0) {
    const hostname = safeHostname(d.pageUrl);
    if (policy.deny.some((entry) => denyEntryMatches(entry, hostname, matchedSelectors))) {
      return {
        allow: false,
        reason: "element matches a consumer policy.deny selector — refused even though it may otherwise read as structural navigation",
      };
    }
  }

  // ── 3. STRUCTURAL NAV ALLOW (domain-agnostic positive shapes) ──────────────────────────────────

  // A REAL-href link: non-empty, not "#", not "javascript:" — closes `<a href="#" onclick=like()>`
  // and `<a href="javascript:void(0)" onclick=...>` disguised-as-nav traps.
  const hasRealHref = !!href && href !== "#" && !/^javascript:/i.test(href);
  // D2 fix: the `role==="link"` arm used to require NO href at all (`|| role === "link"` with no
  // `hasRealHref` guard) — a bare `role="link"` element (an onclick-driven `<span>`/`<a href="#">`/
  // `<a href="javascript:void(0)">` dressed up with `role="link"`) would read as structural nav with
  // zero navigation actually happening. Both arms now require a REAL href; no documented flow depends
  // on href-less `role="link"`.
  const isNavLink = (tag === "a" && hasRealHref && (role === "" || role === "link")) || (role === "link" && hasRealHref);
  if (isNavLink) {
    // Belt-and-suspenders KEEP from LS-28 (+ D1 defense-in-depth): an explicitly-authored `aria-label`
    // OR the element's own `title` on a nav link that matches a tight action-word list still refuses
    // (the rare link-styled account-state control, e.g. `<a href="/i/user/123" aria-label="Like">`, or
    // a vote-arrow anchor whose own `title` names the up/down direction of the action). Bare visible
    // TEXT ("5 comments"/"reply" counters) is NOT checked here — only the deliberately-authored
    // aria-label/title.
    if ((ariaLabel && NAV_LINK_ARIA_LABEL_REFUSE_RE.test(ariaLabel)) || (title && NAV_LINK_ARIA_LABEL_REFUSE_RE.test(title))) {
      return {
        allow: false,
        reason: `nav link's explicitly-authored aria-label/title matches an action word (aria-label="${ariaLabel}", title="${title}")`,
      };
    }
    return { allow: true };
  }

  // Tab navigation.
  if (role === "tab") return { allow: true };

  // A menu ENTRY that is itself a real-href link (nav menu item) — NOT menuitems wholesale (X's
  // "Repost"/"Delete"/"Mute" are ACTION menuitems and must stay default-refused).
  if (role === "menuitem" && tag === "a" && hasRealHref) return { allow: true };

  // Disclosure toggle: the element carries an `aria-expanded` attribute (any value, including
  // "false" — the attribute's mere presence marks a disclosure control). Opening is non-mutating;
  // any mutation is a SEPARATE, later activation on the revealed control, itself default-refused.
  if (d.ariaExpanded !== null && d.ariaExpanded !== undefined) return { allow: true };

  // Native disclosure element.
  if (tag === "summary") return { allow: true };

  // Compose-focus: Enter inside a `<textarea>` inserts a newline, never submits — spec-safe.
  if (tag === "textarea") return { allow: true };

  // ── 4. CONSUMER ALLOWLIST — reached only if steps 1 (floor) and 2 (deny) didn't refuse ──────────
  if (policy?.allow && policy.allow.length > 0) {
    const hostname = safeHostname(d.pageUrl);
    if (policy.allow.some((entry) => entryMatches(entry, hostname, testid, ariaLabel, matchedSelectors))) {
      return { allow: true };
    }
  }

  // ── 5. DEFAULT: REFUSE ──────────────────────────────────────────────────────────────────────────
  return {
    allow: false,
    reason:
      "not a recognized navigation/disclosure affordance; actionable controls are refused by default — " +
      "allowlist known-safe compose-open via InteractSessionOptions.activatePolicy; send via gated send(); " +
      "do account actions yourself",
  };
}

/**
 * The refusal Error message `session.ts#activate()` throws — directs the caller to the actually
 * gated paths (the binding requirement: no ungated path can submit or change account state).
 */
export function describeActivateRefusal(selector: string, reason: string): string {
  return (
    `activate(): refused — ${reason} (selector: ${selector}). ` +
    "to send a composed draft use the gated `send()`; account-state actions are not automatable — do them yourself. " +
    "known-safe compose-open controls can be allowlisted via InteractSessionOptions.activatePolicy."
  );
}

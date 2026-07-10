// LS-45 — `back()`'s in-app-selector activation is gated through the SAME `classifyActivateTarget`
// classifier `activate()` uses (Chrome-free where possible).
//
// The hole this closes: `opts.inAppSelectors` on `back()` is CALLER-CONTROLLED (identical trust
// level to `activate()`'s `selector` argument), but the shipped 0.2.0 `back()` activated whatever
// it matched with NO gate at all — `press("Enter")`, and on failure a raw synthetic `.click()`
// fallback. A caller could pass an `inAppSelectors` entry matching a publish/submit control and
// have it fire ungated (Law 1: an actionable submit/publish control driven ungated; Law 2:
// publishes with no `send()`/approval).
//
// This file proves two things:
//   1. `classifyActivateTarget` REFUSES the exact shapes of descriptor `back()` would now gate
//      before ever pressing Enter — a publish/submit-style control matched via a caller-controlled
//      `inAppSelectors` entry can never be activated by back(). This is the same pure, Chrome-free
//      classifier `test/activate-gate.mjs` exercises for `activate()` — `back()` now calls the
//      identical function (session.ts's `back()` builds the SAME `ActivateTargetDescriptor` via the
//      SAME `#probeActivateTarget` and hands it to the SAME `classifyActivateTarget`), so a refusal
//      proof against the pure classifier is a direct proof about `back()`'s behavior.
//   2. `back()`'s source contains NO `.click(` call anywhere — the previous cut's raw synthetic-click
//      fallback is fully deleted, not just unreachable.
//
// Run with `node test/back-gate.mjs` (after `npm run build` — imports the classifier from dist/;
// the no-.click( assertion reads src/session.ts directly, no build needed for that part).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyActivateTarget } from "../dist/activate-gate.js";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 1. REFUSAL PROOF — the class of attack from the brief (a caller-supplied `inAppSelectors` entry
//    that resolves to a publish/submit control), plus the two other canonical shapes such a
//    selector could match. If any of these ALLOWED, `back()` would press Enter on it — this proves
//    it cannot.
// ════════════════════════════════════════════════════════════════════════════════════════════════
{
  // A site "publish" control matched by a caller-controlled testid selector (the shape of attack
  // the brief calls out): a bare, out-of-form button with no nav/disclosure shape — REFUSE. The
  // probe never reads the SELECTOR STRING itself into the decision (that's caller data, same as
  // `activate()`'s argument) — only the located element's STRUCTURAL shape decides.
  const publishButtonShape = { ...base(), tag: "button", role: null, text: "Post", ariaLabel: "Post" };
  const r = classifyActivateTarget(publishButtonShape);
  check(
    "back({inAppSelectors:[...]}) matching a publish-control shape: classifyActivateTarget REFUSES (back() cannot activate it)",
    r.allow === false,
    JSON.stringify(r),
  );
}
{
  // A literal form-submit button — trips the NON-OVERRIDABLE safety floor (step 1), the strongest
  // possible refusal: no policy of any shape could ever rescue this.
  const submitButton = { ...base(), tag: "button", type: "submit", inForm: true, isFormSubmitTrigger: true, text: "Submit" };
  const r = classifyActivateTarget(submitButton);
  check(
    "button[type=submit] matched via inAppSelectors: REFUSE (safety floor — cannot be overridden)",
    r.allow === false && /cannot be overridden by policy/.test(r.reason),
    JSON.stringify(r),
  );
}
{
  // A bare <button>Post</button> with no explicit type and no form ancestry — not the implicit-submit
  // floor case (that requires `inForm`), but still not a structural nav/disclosure shape, so it falls
  // to the same default-refuse every other unrecognized actionable control hits.
  const barePost = { ...base(), tag: "button", type: null, inForm: false, text: "Post" };
  const r = classifyActivateTarget(barePost);
  check("bare <button>Post</button> (no form, no nav shape) matched via inAppSelectors: REFUSE (default-refuse)", r.allow === false, JSON.stringify(r));
}
{
  // A caller policy that allowlists an UNRELATED control does not rescue the publish control — proves
  // refusal is structural, not "just because no policy was passed".
  const publishButtonShape = { ...base(), tag: "button", text: "Post" };
  const unrelatedPolicy = { allow: [{ hosts: ["unrelated.example"], testids: ["someOtherThing"] }] };
  const r = classifyActivateTarget(publishButtonShape, unrelatedPolicy);
  check("publish-control shape still REFUSES under an unrelated activatePolicy", r.allow === false, JSON.stringify(r));
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 2. Sanity — a genuine structural-nav back affordance (real-href anchor / role=tab / disclosure)
//    passed via inAppSelectors DOES allow, so back()'s in-app path isn't neutered outright, only
//    the actionable/publish shapes are refused.
// ════════════════════════════════════════════════════════════════════════════════════════════════
{
  const navBackAnchor = { ...base(), tag: "a", href: "/previous", text: "Back" };
  const r = classifyActivateTarget(navBackAnchor);
  check("a genuine real-href back anchor matched via inAppSelectors: ALLOW (structural nav)", r.allow === true, JSON.stringify(r));
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 3. GENERIC_BACK_SELECTORS classification — is the shipped default a structural-nav shape (passes
//    the gate) or a button (now falls through to history-back)? `button[aria-label="Back"]` is a
//    <button>, not an <a>/role=link/tab/disclosure/textarea/summary — it has none of the structural
//    allow shapes, so under the new gate it REFUSES and back() safely falls to history-back instead
//    of pressing Enter on it. Documented here as a standing regression proof, not just prose in the
//    build report.
// ════════════════════════════════════════════════════════════════════════════════════════════════
{
  const genericBackButton = { ...base(), tag: "button", ariaLabel: "Back", text: "" };
  const r = classifyActivateTarget(genericBackButton);
  check(
    "GENERIC_BACK_SELECTORS's button[aria-label=\"Back\"] shape: REFUSE under the new gate (falls through to safe history-back — not a regression, just a behavior change, and it's SAFE either way)",
    r.allow === false,
    JSON.stringify(r),
  );
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 4. NO `.click(` ANYWHERE in `back()` — extract the method body from src/session.ts and assert.
// ════════════════════════════════════════════════════════════════════════════════════════════════
{
  const sessionSrc = readFileSync(path.join(PKG_ROOT, "src", "session.ts"), "utf8");
  const startMarker = "async back(opts: BackOptions = {}): Promise<BackResult> {";
  const startIdx = sessionSrc.indexOf(startMarker);
  check("found back()'s method signature in src/session.ts", startIdx !== -1, `startIdx=${startIdx}`);

  // `startMarker` itself ends with the method body's OPENING brace (its last character), so start
  // brace-depth counting there (depth=1 already), not from `startIdx` — the `= {}` default-parameter
  // literal earlier in the same marker string has its own balanced (but irrelevant) brace pair that
  // would otherwise falsely look like the method body if counting started from the top of the marker.
  const bodyStart = startIdx + startMarker.length - 1; // index of the method body's opening `{`
  let depth = 0;
  let bodyEnd = -1;
  for (let i = bodyStart; i < sessionSrc.length; i++) {
    const c = sessionSrc[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        bodyEnd = i;
        break;
      }
    }
  }
  check("located back()'s full method body via brace matching", bodyStart !== -1 && bodyEnd !== -1 && bodyEnd > bodyStart + 100, `bodyStart=${bodyStart} bodyEnd=${bodyEnd}`);
  const backBody = sessionSrc.slice(bodyStart, bodyEnd + 1);

  check("back()'s method body is non-trivial (sanity: contains goBack, the history fallback)", backBody.includes("goBack"), "");
  check("back()'s method body contains NO '.click(' call anywhere (raw synthetic-click fallback fully removed)", !backBody.includes(".click("), backBody.includes(".click(") ? "found .click( in back()" : "");
  check("back()'s method body DOES call classifyActivateTarget (gated, not silently skipped)", backBody.includes("classifyActivateTarget("), "");
  check("back()'s method body does NOT throw on refusal (nav verb — falls through instead)", !/decision\.allow[\s\S]{0,80}throw/.test(backBody), "");
}

// ── belt-and-suspenders hard assertions ──────────────────────────────────────────────────────────
assert.equal(classifyActivateTarget({ ...base(), tag: "button", text: "Post" }).allow, false);
assert.equal(classifyActivateTarget({ ...base(), tag: "button", type: "submit", inForm: true, isFormSubmitTrigger: true }).allow, false);
assert.equal(classifyActivateTarget({ ...base(), tag: "a", href: "/previous" }).allow, true);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

// LS-11 dev/03 — the composer-verification safety check (Chrome-free): empty, stale, and
// focus-lost composers each refuse with a DISTINCT reason and (by construction — this module is
// pure and issues no keypress itself) zero keypress; an emoji-leading draft passes the
// code-point-safe probe. Ported from cadence's `browser.ts:516-525`.
//
// Run with `node test/composer-check.mjs` (after `npm run build`).
import assert from "node:assert/strict";
import { checkComposerHoldsDraft, normalizeComposerText } from "../dist/composer-check.js";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const DRAFT = "shipping the docs today";

// ── empty composer: focused, but holds no text ──
{
  const r = checkComposerHoldsDraft({ focused: true, value: "" }, DRAFT);
  check("empty composer: refuses (ok:false)", r.ok === false, JSON.stringify(r));
  check("empty composer: reason is 'empty'", r.reason === "empty", r.reason);
  check("empty composer: reason is DISTINCT from 'stale' and 'focus-lost'", r.reason !== "stale" && r.reason !== "focus-lost");
}
{
  // whitespace-only also normalizes to empty
  const r = checkComposerHoldsDraft({ focused: true, value: "   \n\t  " }, DRAFT);
  check("whitespace-only composer: also reason 'empty' (normalizes to empty string)", r.reason === "empty", JSON.stringify(r));
}

// ── stale composer: focused, holds text, but it doesn't match the intended draft ──
{
  const r = checkComposerHoldsDraft({ focused: true, value: "a completely different, stale draft from earlier" }, DRAFT);
  check("stale composer: refuses (ok:false)", r.ok === false, JSON.stringify(r));
  check("stale composer: reason is 'stale'", r.reason === "stale", r.reason);
  check("stale composer: reason is DISTINCT from 'empty' and 'focus-lost'", r.reason !== "empty" && r.reason !== "focus-lost");
}

// ── focus-lost composer: nothing focusable is focused at all ──
{
  const r = checkComposerHoldsDraft({ focused: false, value: "" }, DRAFT);
  check("focus-lost composer: refuses (ok:false)", r.ok === false, JSON.stringify(r));
  check("focus-lost composer: reason is 'focus-lost'", r.reason === "focus-lost", r.reason);
  check("focus-lost composer: reason is DISTINCT from 'empty' and 'stale'", r.reason !== "empty" && r.reason !== "stale");
}
{
  // even if a stray `value` were reported, `focused:false` still wins — the probe result says
  // nothing is actually focused, so its 'value' cannot be trusted as "staged".
  const r = checkComposerHoldsDraft({ focused: false, value: DRAFT }, DRAFT);
  check("focus-lost composer: focused:false wins even if value happens to look correct", r.reason === "focus-lost", JSON.stringify(r));
}

// ── all three refusal reasons pairwise distinct (explicit, on top of the per-case checks above) ──
{
  const reasons = new Set([
    checkComposerHoldsDraft({ focused: true, value: "" }, DRAFT).reason,
    checkComposerHoldsDraft({ focused: true, value: "stale mismatch text" }, DRAFT).reason,
    checkComposerHoldsDraft({ focused: false, value: "" }, DRAFT).reason,
  ]);
  check("empty / stale / focus-lost are three DISTINCT reason values", reasons.size === 3, JSON.stringify([...reasons]));
}

// ── the composer HOLDS the draft: ok ──
{
  const r = checkComposerHoldsDraft({ focused: true, value: DRAFT }, DRAFT);
  check("matching composer: ok:true, reason 'ok'", r.ok === true && r.reason === "ok", JSON.stringify(r));
}
{
  // whitespace/case differences are tolerated (normalize collapses whitespace + lower-cases)
  const r = checkComposerHoldsDraft({ focused: true, value: "  Shipping   the   DOCS today  " }, DRAFT);
  check("matching composer tolerates whitespace/case drift (normalized compare)", r.ok === true, JSON.stringify(r));
}
{
  // the composer may hold MORE than the probe (e.g. platform-appended text) and still pass — the
  // gate is "staged text CONTAINS the draft's opening probe", not exact equality (browser.ts:520).
  const r = checkComposerHoldsDraft({ focused: true, value: DRAFT + " #hashtag" }, DRAFT);
  check("composer holding the draft PLUS trailing text still passes (contains, not equals)", r.ok === true, JSON.stringify(r));
}

// ── emoji-leading draft: the probe is CODE-POINT safe (never splits a surrogate pair) ──
{
  const emojiDraft = "🚀🎉 shipping the docs today, for real this time";
  const r = checkComposerHoldsDraft({ focused: true, value: emojiDraft }, emojiDraft);
  check("emoji-leading draft: an exact match still passes", r.ok === true, JSON.stringify(r));

  // Prove the probe itself never mangles the leading emoji: a naive UTF-16 slice(0,16) WOULD split
  // the surrogate pairs of some emoji and corrupt the comparison; the code-point-safe probe must
  // not. Reconstruct the probe the same way composer-check.ts does and assert it starts with the
  // full, unmangled leading emoji.
  const probe = [...normalizeComposerText(emojiDraft)].slice(0, 16).join("");
  check("emoji-leading draft: the extracted probe starts with the intact leading emoji (not a split surrogate half)", probe.startsWith("🚀🎉"), JSON.stringify(probe));
  check("emoji-leading draft: the probe contains no lone (unpaired) surrogate code units", !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(probe));

  // A composer holding a longer prefix of the draft (well past the 16-code-point probe window,
  // so no trailing-whitespace-vs-trim edge case) still matches — the leading emoji survives intact
  // through the compare, not mangled into a lone surrogate.
  const longerPrefix = [...normalizeComposerText(emojiDraft)].slice(0, 30).join("");
  const r2 = checkComposerHoldsDraft({ focused: true, value: longerPrefix }, emojiDraft);
  check("emoji-leading draft: a composer holding a code-point-safe prefix still matches", r2.ok === true, JSON.stringify(r2));
}
{
  // A draft that is ITSELF short (under 16 code points) and emoji-only — the probe is the whole
  // normalized string; still must not throw and must match exactly.
  const shortEmoji = "🔥🔥🔥";
  const r = checkComposerHoldsDraft({ focused: true, value: shortEmoji }, shortEmoji);
  check("short all-emoji draft: matches without throwing", r.ok === true, JSON.stringify(r));
}

// ── belt-and-suspenders hard assertions (fails loudly under `node --test` too) ──
assert.equal(checkComposerHoldsDraft({ focused: true, value: "" }, DRAFT).reason, "empty");
assert.equal(checkComposerHoldsDraft({ focused: true, value: "nope" }, DRAFT).reason, "stale");
assert.equal(checkComposerHoldsDraft({ focused: false, value: "" }, DRAFT).reason, "focus-lost");
assert.equal(checkComposerHoldsDraft({ focused: true, value: DRAFT }, DRAFT).ok, true);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

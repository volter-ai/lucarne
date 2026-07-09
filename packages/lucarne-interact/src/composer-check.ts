// composer-check.ts — the pre-keypress SAFETY check: the staged text must actually be in the
// focused composer before `send()`'s gesture fires. Ported (mechanism only) from cadence's
// `browser.ts:516-525`: "before firing the keypress, VERIFY the composer actually holds the
// approved draft. `send` only presses Enter — `type` is what stages the text — so an
// empty/stale/focus-lost composer would otherwise fire a blank or wrong post." Skipped entirely
// for `{ submit }` gestures, where the textarea isn't the focused element (browser.ts:516,
// `if (!submit) { ... }`).
//
// This module is PURE — no Playwright, no browser — so it is fully unit-testable with a mock
// probe (test/composer-check.mjs). `session.ts#send()` supplies the real page-backed probe (a
// `page.evaluate` reading `document.activeElement`, mirroring `browser.ts:518` exactly).
//
// The normalize+compare logic (whitespace-collapse, case-fold, and the CODE-POINT-SAFE 16-char
// probe — `[...norm(text)].slice(0, 16).join('')`, never splitting a surrogate pair / emoji —
// `browser.ts:519`) moves verbatim. What's NEW here (beyond the original, which lumped
// empty/stale/focus-lost into one combined message) is a `focused` signal on the probe so the
// three refusal shapes report DISTINCT reasons — still gated on the exact same underlying
// condition (`!ns || (probe && !ns.includes(probe))`, `browser.ts:520`): refuse unless the
// composer holds text that starts with (or contains) the draft's opening code points.

/** What the real page-backed probe reports about the currently focused element (browser.ts:518). */
export interface ComposerProbeResult {
  /** False when nothing meaningfully focusable is focused (`document.activeElement` is null/body/html). */
  focused: boolean;
  /** The focused element's `.value` (inputs/textareas) or `.innerText`/`.textContent` (contenteditable). */
  value: string;
}

export type ComposerCheckReason = "ok" | "focus-lost" | "empty" | "stale";

export interface ComposerCheckResult {
  ok: boolean;
  reason: ComposerCheckReason;
  detail: string;
  /** The normalized (whitespace-collapsed, lower-cased) staged text actually observed. */
  staged: string;
}

/** Whitespace-collapse + case-fold, exactly `browser.ts:517`'s `norm`. */
export function normalizeComposerText(s: unknown): string {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Decide whether the composer holds the draft `send()` is about to commit. Pure — given the
 * probe result and the intended text, never touches a browser. Distinguishes THREE distinct
 * refusal reasons (an enrichment over `browser.ts`'s single combined message, kept because the
 * underlying gate condition — refuse unless the normalized staged text contains the draft's
 * code-point-safe 16-char probe — is identical):
 *
 *   - `focus-lost` — nothing focusable is focused at all (the composer, or focus generally, was lost).
 *   - `empty`      — something is focused, but it holds no text.
 *   - `stale`      — something is focused and holds text, but it doesn't match the intended draft.
 */
export function checkComposerHoldsDraft(probe: ComposerProbeResult, text: string): ComposerCheckResult {
  const ns = normalizeComposerText(probe.value);
  // By CODE POINT, never by UTF-16 code unit — never split a surrogate pair (an emoji-leading
  // draft stays intact through the slice), exactly `browser.ts:519`'s `[...norm(text)].slice(0, 16)`.
  const probeStr = [...normalizeComposerText(text)].slice(0, 16).join("");

  if (!probe.focused) {
    return {
      ok: false,
      reason: "focus-lost",
      detail: "composer doesn't hold the approved draft — focus was lost (nothing focusable is focused)",
      staged: ns,
    };
  }
  if (!ns) {
    return {
      ok: false,
      reason: "empty",
      detail: "composer doesn't hold the approved draft — the composer is empty",
      staged: ns,
    };
  }
  if (probeStr && !ns.includes(probeStr)) {
    return {
      ok: false,
      reason: "stale",
      detail: "composer doesn't hold the approved draft — staged text doesn't match (stale)",
      staged: ns,
    };
  }
  return { ok: true, reason: "ok", detail: "composer holds the approved draft", staged: ns };
}

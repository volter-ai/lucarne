// Active-tab selection + change classification — the PURE decision halves of cadence's `SIG`
// eval (`recall.ts:62-101`) and its capture-on-change `reason` derivation (`recall.ts:391-398`).
// No I/O here — a caller (recall/index.ts) gathers `{vis, foc, skip}` per tab via real
// `page.evaluate` calls, and `{url, bucket, firstText}` off the winning tab, and hands the plain
// data in here. That's what makes this Chrome-free unit-testable (test/recall-tab-scoring.mjs).

/** One tab's raw visibility signal (cadence's per-page `p.evaluate(() => ({vis, foc, skip}))`). */
export interface TabProbe {
  vis: boolean;
  foc: boolean;
  skip: boolean;
}

/** One candidate tab handed to `pickBestTab`: its probe result plus its presence tie-break bonus
 *  (LS-12's `presenceTieBreakBonus(marker, targetId)` — computed by the caller, since only it knows
 *  the tab's CDP `Target.targetId` and the current presence marker). `index` is caller-defined
 *  (e.g. the tab's position in its own page array) and is only echoed back in the result. */
export interface ScoredTabCandidate {
  index: number;
  probe: TabProbe | null;
  tieBreakBonus: number;
}

export interface PickedTab {
  index: number;
  score: number;
}

/**
 * Score every non-skipped candidate (`vis*2 + foc*1 + tieBreakBonus`, cadence's `recall.ts:78`
 * formula) and return the highest-scoring one, or `null` if every candidate is skipped (non-http,
 * about:blank, our own surfaces) or `probe` came back null (a `page.evaluate` failure — treated
 * the same as cadence's `catch(e){ continue; }`, `recall.ts:73`).
 *
 * The `< 1` FALLBACK THRESHOLD is the caller's job, not this function's: cadence falls back to the
 * eval-server's driven page when `best < 1` (`recall.ts:84`, "no genuinely visible/focused tab
 * scored — trust the one being driven instead"). This function only reports the raw winner; the
 * caller (recall/index.ts) applies the threshold and, if it fails, tries the presence-marker
 * fallback (the connection-independent replacement for `recall.ts:81-86`'s `page` fallback).
 */
export function pickBestTab(candidates: readonly ScoredTabCandidate[]): PickedTab | null {
  let best: PickedTab | null = null;
  for (const c of candidates) {
    if (!c.probe || c.probe.skip) continue;
    const score = (c.probe.vis ? 2 : 0) + (c.probe.foc ? 1 : 0) + c.tieBreakBonus;
    if (!best || score > best.score) best = { index: c.index, score };
  }
  return best;
}

/** The active-tab tie-break/fallback threshold (cadence's `best < 1`, `recall.ts:84`). */
export const ACTIVE_TAB_FALLBACK_THRESHOLD = 1;

/** The parts of a capture-on-change signature cadence tracks between ticks (`recall.ts:386-387`). */
export interface ChangeParts {
  url: string;
  bucket: number;
  firstText: string;
}

export type ChangeReason = "initial" | "navigated" | "new-content" | "scrolled" | "changed";

export interface ChangeClassification {
  reason: ChangeReason;
  detail: string | null;
}

/** cadence's `shortUrl` (`recall.ts:391`) — a compact, readable URL for a `detail` string. */
export function shortUrl(u: string | null | undefined): string {
  return String(u || "")
    .replace(/^https?:\/\//, "")
    .replace(/[?#].*$/, "")
    .replace(/\/$/, "");
}

/**
 * Classify WHY a capture-on-change fired, given the prior and current `{url, bucket, firstText}`
 * — cadence's `recall.ts:391-398`, ported verbatim. `prev === null` is the very first capture
 * (`reason: 'initial'`); otherwise: a changed `url` is a navigation, a changed `firstText` at the
 * same url/bucket is new content arriving (a feed refresh), a changed scroll `bucket` at a stable
 * url/text is a scroll, and anything else that still differs is the generic `'changed'` bucket.
 */
export function classifyChange(prev: ChangeParts | null, next: ChangeParts): ChangeClassification {
  if (!prev) {
    return { reason: "initial", detail: next.firstText || shortUrl(next.url) };
  }
  if (next.url !== prev.url) {
    return {
      reason: "navigated",
      detail: `${shortUrl(prev.url).slice(0, 38)} → ${shortUrl(next.url).slice(0, 38)}`,
    };
  }
  if (next.firstText !== prev.firstText) {
    return { reason: "new-content", detail: next.firstText };
  }
  if (next.bucket !== prev.bucket) {
    return { reason: "scrolled", detail: next.firstText ? "to: " + next.firstText : null };
  }
  return { reason: "changed", detail: null };
}

/** cadence's scroll bucketing (`recall.ts:386`: `Math.round(scrollY / 400)`). */
export function scrollBucket(scrollY: number): number {
  return Math.round(scrollY / 400);
}

/** cadence's capture-on-change signature string (`recall.ts:387`), for the `s !== lastSig` gate. */
export function changeSignature(parts: ChangeParts): string {
  return `${parts.url}|${parts.bucket}|${parts.firstText}`;
}

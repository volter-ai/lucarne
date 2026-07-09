// The humanized typing model — PURE, Chrome-free. Ported from the origin app's `browser.ts:132-183`
// (`KEYMAP`, `keyDelay`, `humanDelays`, `typingStats`). Inter-keystroke interval depends on the
// BIGRAM class (same-finger slow, same-hand medium, alternating-hand fast), sampled log-normal
// (right-skewed, like real typing), plus cognitive pauses at sentence/word boundaries.
//
// "The point isn't to forge human-ness — it's to NOT do the unnatural instant-paste thing."
// (browser.ts:135). Nothing here touches a page; `InteractSession#type` (session.ts) drives the
// actual keystrokes and sleeps the delays this module computes.
import { randn } from "./pacing.js";

interface KeyInfo {
  hand: "L" | "R";
  finger: number;
}

// Verbatim from browser.ts:136-145 — QWERTY home-row-relative finger assignment.
const KEYMAP: Readonly<Record<string, KeyInfo>> = (() => {
  const rows: Record<"L" | "R", Record<string, number>> = {
    L: { q: 1, a: 1, z: 1, w: 2, s: 2, x: 2, e: 3, d: 3, c: 3, r: 4, f: 4, v: 4, t: 4, g: 4, b: 4, "1": 1, "2": 2, "3": 3, "4": 4, "5": 4 },
    R: { y: 4, h: 4, n: 4, u: 4, j: 4, m: 4, i: 3, k: 3, ",": 3, o: 2, l: 2, ".": 2, p: 1, ";": 1, "/": 1, "6": 4, "7": 4, "8": 3, "9": 2, "0": 1, "-": 1, "'": 1 },
  };
  const m: Record<string, KeyInfo> = {};
  for (const [hand, keys] of Object.entries(rows) as [("L" | "R"), Record<string, number>][]) {
    for (const [k, finger] of Object.entries(keys)) m[k] = { hand, finger };
  }
  return m;
})();

/** Sample a log-normal draw: `exp(ln(median) + sigma * N(0,1))` — right-skewed (browser.ts:148). */
function logn(median: number, sigma: number, rng: () => number = randn): number {
  return Math.exp(Math.log(median) + sigma * rng());
}

function keyInfo(ch: string): (KeyInfo & { shift: boolean }) | null {
  const lc = ch.toLowerCase();
  const k = KEYMAP[lc];
  return k ? { ...k, shift: ch !== lc } : null;
}

/**
 * Delay (ms) BEFORE typing `cur`, given the previously typed char `prev` (`""` for the first char).
 * Verbatim model from the origin app's `keyDelay` (browser.ts:160-174):
 *   1. sentence-final think pause (prev is `.`/`!`/`?`)
 *   2. word boundary — space bar, with a ~12% chance of an extra "thinking" pause
 *   3. start of a word (prev was a space)
 *   4. slight pause before punctuation
 *   5. bigram class: same-finger (slowest) > same-hand (medium) > alternating-hand (fastest)
 * `rng`/`coinFlip` are injectable ONLY for deterministic testing — real typing uses `Math.random`-backed
 * defaults, same as the origin app's model.
 */
export function keyDelay(prev: string, cur: string, rng: () => number = randn, coinFlip: () => number = Math.random): number {
  if (prev && ".!?".includes(prev)) return logn(650, 0.5, rng) + 120; // sentence-final think pause
  if (cur === " ") {
    let d = logn(150, 0.4, rng);
    if (coinFlip() < 0.12) d += logn(450, 0.5, rng); // word boundary (+ occasional pause)
    return d;
  }
  if (prev === " ") return logn(120, 0.4, rng); // start of a word
  if (",;:".includes(cur)) return logn(180, 0.4, rng); // slight pause before punctuation
  const a = keyInfo(prev);
  const b = keyInfo(cur);
  let factor = 1.25; // unknown/symbol default
  if (a && b) factor = a.hand === b.hand && a.finger === b.finger ? 1.6 : a.hand === b.hand ? 1.15 : 0.9;
  let d = logn(95, 0.4, rng) * factor;
  if (b && b.shift) d += logn(45, 0.4, rng); // shift coordination
  return Math.max(28, d);
}

/** The full per-character delay sequence for `text` (index 0 = delay before the first char). */
export function humanDelays(text: string): number[] {
  const out: number[] = [];
  let prev = "";
  for (const ch of text) {
    out.push(keyDelay(prev, ch));
    prev = ch;
  }
  return out;
}

export interface TypingStats {
  chars: number;
  seconds: number;
  wpm: number;
  median_ms: number;
  p10_ms: number;
  p90_ms: number;
  max_ms: number;
}

/** Offline (no browser) timing-model stats for `text` — ported verbatim from browser.ts:177-183. */
export function typingStats(text: string): TypingStats {
  const d = humanDelays(text);
  const total = d.reduce((a, b) => a + b, 0);
  const s = [...d].sort((a, b) => a - b);
  const pct = (p: number) => Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]!);
  return {
    chars: text.length,
    seconds: +(total / 1000).toFixed(1),
    wpm: Math.round(text.length / 5 / (total / 60000)),
    median_ms: pct(0.5),
    p10_ms: pct(0.1),
    p90_ms: pct(0.9),
    max_ms: Math.round(Math.max(...d)),
  };
}

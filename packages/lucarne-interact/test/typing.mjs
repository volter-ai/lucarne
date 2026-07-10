// LS-10 dev/01 — the humanized typing MODEL, offline and deterministic (Chrome-free).
//
// Ports (and strengthens) cadence/test/typing.test.mjs: the cadence test only checked that
// `typing-stats` stays in a human range. The split spec's dev/01 asks for the model's structural
// invariants too, so this file additionally pins:
//   - bigram-class ordering: same-finger > same-hand > alternating-hand inter-key delays
//   - sentence/word-boundary cognitive pauses
//   - log-normal right-skew (mean > median; a long right tail)
// All of this is pure — `typingStats`/`keyDelay`/`humanDelays` never touch a browser — so we drive
// the model directly AND, for the ported original, through the CLI's offline `typing-stats` verb.
//
// Run with `node test/typing.mjs` (after `npm run build`).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { humanDelays, keyDelay, typingStats } from "../dist/index.js";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// A robust average delay for a bigram, over many samples (the model is stochastic).
const N = 4000;
function avgDelay(prev, cur, n = N) {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += keyDelay(prev, cur);
  return sum / n;
}

// ── (1) the ORIGINAL cadence assertions, ported verbatim, via the CLI's offline `typing-stats` ──
{
  const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
  const out = execFileSync(process.execPath, [CLI, "unused-cdp-url", "typing-stats", "the quick brown fox jumps over the lazy dog"], { encoding: "utf8" });
  const s = JSON.parse(out);
  check("(ported) typing-stats: takes real time (seconds > 0)", s.seconds > 0, `seconds=${s.seconds}`);
  check("(ported) typing-stats: wpm is human-plausible (10 < wpm < 300)", s.wpm > 10 && s.wpm < 300, `wpm=${s.wpm}`);
  check("(ported) typing-stats: inter-key delay is not instant (median_ms >= 20)", s.median_ms >= 20, `median_ms=${s.median_ms}`);
}

// The same, but straight against the pure export (no subprocess).
{
  const s = typingStats("the quick brown fox jumps over the lazy dog");
  check("typingStats(): seconds > 0", s.seconds > 0);
  check("typingStats(): 10 < wpm < 300", s.wpm > 10 && s.wpm < 300, `wpm=${s.wpm}`);
  check("typingStats(): median_ms >= 20 (never instant paste)", s.median_ms >= 20, `median_ms=${s.median_ms}`);
  check("typingStats(): p10 <= median <= p90 (ordered percentiles)", s.p10_ms <= s.median_ms && s.median_ms <= s.p90_ms, `${s.p10_ms}/${s.median_ms}/${s.p90_ms}`);
  check("typingStats(): chars matches the input length", s.chars === "the quick brown fox jumps over the lazy dog".length);
}

// ── (2) bigram-class ordering: same-finger (slow) > same-hand (medium) > alternating-hand (fast) ──
// Same finger, same (left) hand: e/d/c are all left-middle-finger (finger 3) in the KEYMAP.
const sameFinger = avgDelay("e", "d"); // both L, finger 3
// Same hand (left), different finger: 'e' (L,3) -> 'w' (L,2).
const sameHand = avgDelay("e", "w"); // both L, different finger
// Alternating hands: 'e' (L) -> 'i' (R).
const alternating = avgDelay("e", "i"); // L -> R
check(
  "bigram: same-finger delay > same-hand delay",
  sameFinger > sameHand,
  `same-finger=${sameFinger.toFixed(1)} vs same-hand=${sameHand.toFixed(1)}`,
);
check(
  "bigram: same-hand delay > alternating-hand delay",
  sameHand > alternating,
  `same-hand=${sameHand.toFixed(1)} vs alternating=${alternating.toFixed(1)}`,
);
check(
  "bigram: full ordering same-finger > same-hand > alternating",
  sameFinger > sameHand && sameHand > alternating,
  `${sameFinger.toFixed(1)} > ${sameHand.toFixed(1)} > ${alternating.toFixed(1)}`,
);

// ── (3) sentence + word-boundary cognitive pauses ──
// Sentence-final: after '.', the next char carries a big "think" pause vs a normal in-word key.
const afterSentence = avgDelay(".", "t"); // sentence-final think pause
const inWord = avgDelay("t", "h"); // an ordinary bigram
check("boundary: sentence-final pause (after '.') >> an ordinary in-word bigram", afterSentence > inWord * 2, `after-'.'=${afterSentence.toFixed(1)} vs in-word=${inWord.toFixed(1)}`);

// Word boundary: typing a space carries its own cadence; and the START of a word (prev === ' ')
// is distinct from a same-hand mid-word key. We assert the space itself is a real, non-instant pause.
const spaceDelay = avgDelay("x", " ");
check("boundary: word-boundary (space) delay is a real pause (> 40ms avg)", spaceDelay > 40, `space=${spaceDelay.toFixed(1)}`);
const wordStart = avgDelay(" ", "t"); // start of a word
check("boundary: start-of-word delay (prev=space) is a real pause (> 40ms avg)", wordStart > 40, `word-start=${wordStart.toFixed(1)}`);

// Punctuation: a slight pause BEFORE ',' ';' ':' vs a plain letter bigram.
const beforeComma = avgDelay("a", ",");
check("boundary: slight pause before punctuation (',') exceeds a plain letter bigram", beforeComma > inWord, `before-','=${beforeComma.toFixed(1)} vs in-word=${inWord.toFixed(1)}`);

// ── (4) log-normal right-skew invariants ──
// A log-normal is right-skewed: its mean exceeds its median, and it has a long right tail. We sample
// one representative bigram many times and check mean > median and a heavy upper tail.
{
  const samples = [];
  for (let i = 0; i < 20000; i++) samples.push(keyDelay("a", "s")); // same-hand bigram, log-normal core
  samples.sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const median = samples[Math.floor(samples.length / 2)];
  const p90 = samples[Math.floor(0.9 * samples.length)];
  const p10 = samples[Math.floor(0.1 * samples.length)];
  check("log-normal: mean > median (positive/right skew)", mean > median, `mean=${mean.toFixed(1)} median=${median.toFixed(1)}`);
  check("log-normal: right tail heavier than left (p90-median > median-p10)", p90 - median > median - p10, `p90-med=${(p90 - median).toFixed(1)} med-p10=${(median - p10).toFixed(1)}`);
  check("log-normal: strictly positive support (min sample > 0)", samples[0] > 0, `min=${samples[0].toFixed(1)}`);
}

// Whole-string skew: typingStats over a real sentence — max_ms (a rare sentence-final/word pause)
// should tower over the median (the everyday keystroke), the hallmark of the right-skewed model.
{
  const s = typingStats("Hello there. This is a real sentence, typed by a person; not a bot.");
  check("log-normal (string): max_ms >> median_ms (a long right tail exists)", s.max_ms > s.median_ms * 3, `max=${s.max_ms} median=${s.median_ms}`);
}

// humanDelays length/shape: one delay per code point, all finite and positive.
{
  const text = "abc, def. ghi";
  const d = humanDelays(text);
  check("humanDelays(): one delay per code point", d.length === [...text].length, `${d.length} vs ${[...text].length}`);
  check("humanDelays(): every delay is finite and > 0", d.every((x) => Number.isFinite(x) && x > 0));
}

// Hard assertion so this file also fails loudly under a plain `node` run if the core ordering breaks.
assert.ok(sameFinger > sameHand && sameHand > alternating, "bigram-class ordering must hold");

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

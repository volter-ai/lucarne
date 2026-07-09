// LS-13 dev — active-tab scoring + change classification (Chrome-free). Ports the pure halves of
// cadence's `SIG` (`recall.ts:62-101`) and its capture-on-change reason derivation (`:391-398`).
//
// Run with `node test/recall-tab-scoring.mjs` (after `npm run build`).
import {
  ACTIVE_TAB_FALLBACK_THRESHOLD,
  changeSignature,
  classifyChange,
  pickBestTab,
  scrollBucket,
  shortUrl,
} from "../dist/recall/tab-scoring.js";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// ── pickBestTab ──
{
  const none = pickBestTab([]);
  check("pickBestTab: empty candidate list -> null", none === null);
}
{
  const allSkipped = pickBestTab([
    { index: 0, probe: { vis: true, foc: true, skip: true }, tieBreakBonus: 0 },
    { index: 1, probe: null, tieBreakBonus: 0 },
  ]);
  check("pickBestTab: all skipped/null probes -> null", allSkipped === null);
}
{
  // visible(2) beats focused-only(1) — the ordinary single-window case.
  const best = pickBestTab([
    { index: 0, probe: { vis: false, foc: true, skip: false }, tieBreakBonus: 0 },
    { index: 1, probe: { vis: true, foc: false, skip: false }, tieBreakBonus: 0 },
  ]);
  check("pickBestTab: visible tab (score 2) beats focused-only tab (score 1)", best?.index === 1 && best?.score === 2, JSON.stringify(best));
}
{
  // A genuine tie between two equally visible+focused tabs is broken by the presence tie-break bonus.
  const tie = pickBestTab([
    { index: 0, probe: { vis: true, foc: true, skip: false }, tieBreakBonus: 0 },
    { index: 1, probe: { vis: true, foc: true, skip: false }, tieBreakBonus: 0.5 },
  ]);
  check("pickBestTab: tie broken by the presence tie-break bonus (recall.ts:78's +0.5)", tie?.index === 1 && tie?.score === 3.5, JSON.stringify(tie));
}
{
  // The tie-break bonus never OVERRIDES a genuinely more-visible tab (recall.ts:75-77's comment).
  const notOverridden = pickBestTab([
    { index: 0, probe: { vis: true, foc: true, skip: false }, tieBreakBonus: 0 }, // score 3
    { index: 1, probe: { vis: false, foc: false, skip: false }, tieBreakBonus: 0.5 }, // score 0.5, driven but invisible
  ]);
  check("pickBestTab: the tie-break bonus does not override a genuinely more visible tab", notOverridden?.index === 0, JSON.stringify(notOverridden));
}
{
  const skippedIgnored = pickBestTab([
    { index: 0, probe: { vis: true, foc: true, skip: true }, tieBreakBonus: 0 }, // our own surface — skipped
    { index: 1, probe: { vis: false, foc: true, skip: false }, tieBreakBonus: 0 },
  ]);
  check("pickBestTab: a skipped (non-http) tab is never picked even if it would outscore", skippedIgnored?.index === 1, JSON.stringify(skippedIgnored));
}
check("ACTIVE_TAB_FALLBACK_THRESHOLD is 1 (cadence's recall.ts:84 'best < 1' fallback gate)", ACTIVE_TAB_FALLBACK_THRESHOLD === 1);

// ── classifyChange ──
{
  const initial = classifyChange(null, { url: "https://x.com/a", bucket: 0, firstText: "hello" });
  check("classifyChange: no prior state -> 'initial'", initial.reason === "initial" && initial.detail === "hello", JSON.stringify(initial));
}
{
  const nav = classifyChange({ url: "https://x.com/a", bucket: 0, firstText: "hi" }, { url: "https://x.com/b", bucket: 0, firstText: "hi" });
  check("classifyChange: url changed -> 'navigated'", nav.reason === "navigated", JSON.stringify(nav));
  check("classifyChange: navigated detail shows from -> to", nav.detail.includes("x.com/a") && nav.detail.includes("x.com/b"), nav.detail);
}
{
  const newContent = classifyChange({ url: "https://x.com/a", bucket: 0, firstText: "old post" }, { url: "https://x.com/a", bucket: 0, firstText: "new post" });
  check("classifyChange: same url/bucket, firstText changed -> 'new-content'", newContent.reason === "new-content" && newContent.detail === "new post", JSON.stringify(newContent));
}
{
  const scrolled = classifyChange({ url: "https://x.com/a", bucket: 0, firstText: "same" }, { url: "https://x.com/a", bucket: 1, firstText: "same" });
  check("classifyChange: same url/text, bucket changed -> 'scrolled'", scrolled.reason === "scrolled" && scrolled.detail === "to: same", JSON.stringify(scrolled));
}
{
  const unchanged = classifyChange({ url: "https://x.com/a", bucket: 0, firstText: "same" }, { url: "https://x.com/a", bucket: 0, firstText: "same" });
  check("classifyChange: nothing differs -> 'changed' (the generic fallback bucket)", unchanged.reason === "changed" && unchanged.detail === null, JSON.stringify(unchanged));
}

// ── scrollBucket / changeSignature / shortUrl ──
check("scrollBucket: 0 -> 0", scrollBucket(0) === 0);
check("scrollBucket: 399 -> 1 (rounds)", scrollBucket(399) === 1);
check("scrollBucket: 800 -> 2", scrollBucket(800) === 2);
check("changeSignature: composes url|bucket|firstText", changeSignature({ url: "u", bucket: 2, firstText: "t" }) === "u|2|t");
check("shortUrl: strips protocol, query, trailing slash", shortUrl("https://x.com/a/b/?x=1#y") === "x.com/a/b");
check("shortUrl: null/undefined -> ''", shortUrl(null) === "" && shortUrl(undefined) === "");

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

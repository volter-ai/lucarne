// LS-14 dev/02 — golden-file proof: a real `units.jsonl` (a representative fixture of what the
// SCREEN sensor's ARIA extractor + stub-minting would actually produce over one recall session —
// `test/fixtures/units.jsonl`) mapped through `unitToRecord` and merged into `lucarne-records`'
// store, one line at a time (simulating incremental captures, not one batch add), holding
// stub-never-degrades and richest-text-wins on the UNIFIED record shape — AND a `via:'screen'`
// record and a `via:'internal-api'` record for the SAME provenance id merging to ONE entry, proving
// the screen sensor (LS-13) and the wire sensor (LS-13W) genuinely write into one corpus, not two.
//
// The store itself lives in `lucarne-records` (LS-03) — this test only proves LS-14's own claim:
// recall's TWO sensors compose correctly on top of it. `unitToRecord`/`appendRecords`'s own field-
// level and merge-invariant tests already live in `lucarne-records/test/{unit-to-record,store}.mjs`
// (LS-04/LS-03) — this file is deliberately narrower and end-to-end: read the fixture file, replay
// it as `startRecall`'s screen sensor would (one `appendRecords` call per capture), then add a wire
// capture for one of the SAME ids and prove it lands in the SAME entry.
//
// Run with `node test/units-store-merge.mjs` (after `npm run build` in BOTH this package and
// lucarne-records — this test only exercises lucarne-records' own dist, no build of THIS package's
// dist is required, but the repo's test:unit script always builds first).
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { appendRecords, loadRecords, unitToRecord, tweetToPost } from "lucarne-records";

const __dirname = dirname(fileURLToPath(import.meta.url));

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const tmpDir = () => mkdtempSync(join(tmpdir(), "lucarne-interact-units-merge-"));

// ── load the fixture + replay it ONE LINE AT A TIME (each line = one capture-on-change event a
//    real recall session would have appended separately, not one batch) ──
const fixturePath = join(__dirname, "fixtures", "units.jsonl");
const units = readFileSync(fixturePath, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));
check("fixture: units.jsonl parses to 6 capture-events", units.length === 6, `got ${units.length}`);

const DIR = tmpDir();
for (const unit of units) {
  appendRecords(DIR, [unitToRecord(unit)]);
}
const stored = loadRecords(DIR);

// ── richest-text-wins: post x:...0001 was captured thin, then re-captured richer (same id) ──
{
  const p1 = stored.find((e) => e.provenance.id === "1810000000000000001");
  check("richest-text-wins: the merged post keeps the LONGER (second) capture's text", p1 && p1.text.startsWith("shipping day — cut the v1.5"), p1 && p1.text);
  check("richest-text-wins: the merged post's metrics reflect the richer capture", p1 && p1.metrics.score === 41 && p1.metrics.replies === 6);
  check("via:'screen' on a unitToRecord()-mapped record", p1 && p1.provenance.via === "screen");
}

// ── the comment threads correctly under its parent ──
{
  const c1 = stored.find((e) => e.kind === "comment" && e.provenance.id === "1810000000000000002");
  check("comment maps + threads under its parent's derived URL", !!c1 && c1.threadRootUrl === "https://x.com/nprado/status/1810000000000000001");
}

// ── stub-never-degrades: x:...0099 was minted as a stub, then genuinely captured later ──
{
  const p2 = stored.find((e) => e.provenance.id === "1810000000000000099");
  check("stub-never-degrades: the merged record is NOT marked stub once a real capture exists", p2 && p2.stub !== true);
  check("stub-never-degrades: the real capture's text survived the merge", p2 && p2.text.startsWith("benchmark run finished"));
  check("stub-never-degrades: the real capture's metrics survived the merge", p2 && p2.metrics.score === 88);
}

// ── the plain single-capture post used below for the cross-sensor merge ──
{
  const p3 = stored.find((e) => e.provenance.id === "1810000000000000200");
  check("plain post (no re-capture) present with via:'screen'", !!p3 && p3.provenance.via === "screen");
  check("plain post's text carried through", !!p3 && p3.text === "first look at the new dashboard");
}

rmSync(DIR, { recursive: true, force: true });

// ── CRITICAL (LS-14): a via:'screen' record and a via:'internal-api' record for the SAME
//    provenance id merge to ONE entry — the screen sensor (LS-13) and the wire sensor (LS-13W)
//    genuinely write into ONE corpus. Build the wire-sensor side with the REAL GraphQL parser
//    (`tweetToPost`), not a hand-rolled record, so the proof exercises the actual LS-13W code path. ──
const SHARED_SID = "1810000000000000200"; // same bare id as the screen-sensor post above

function tweetResultFixture({ text, favorite_count, retweet_count, reply_count }) {
  return {
    rest_id: SHARED_SID,
    legacy: { full_text: text, created_at: "Wed Jul 01 09:25:00 +0000 2026", favorite_count, retweet_count, reply_count },
    core: {
      user_results: {
        result: {
          core: { screen_name: "dsouzam", name: "M. D'Souza" },
          legacy: { profile_image_url_https: "https://pbs.twimg.com/profile_images/1/dsouzam_normal.jpg" },
        },
      },
    },
  };
}

// wire captures the SAME tweet, with a richer body than the screen sensor's ARIA-scraped text and
// real engagement metrics (the screen sensor's own capture had metrics too, but the wire response is
// what a real GraphQL body actually carries — richer, as x's own hydration payload usually is).
const wirePost = tweetToPost(
  tweetResultFixture({
    text: "first look at the new dashboard — loving the new density controls and the saved-view picker",
    favorite_count: 120,
    retweet_count: 4,
    reply_count: 9,
  }),
);
check("fixture sanity: tweetToPost() parsed the wire fixture into a Post", !!wirePost && wirePost.kind === "post");
check("fixture sanity: the wire Post carries via:'internal-api'", wirePost.provenance.via === "internal-api");
check("fixture sanity: the wire Post's bare id matches the screen sensor's SAME tweet", wirePost.provenance.id === SHARED_SID);

// Order 1: SCREEN captured first (recall's normal case — the human scrolled past it), WIRE arrives
// moments later (the app's own GraphQL response for the same tweet, captured passively).
{
  const DIR1 = tmpDir();
  const screenUnit = units.find((u) => u.id === `x:${SHARED_SID}`);
  appendRecords(DIR1, [unitToRecord(screenUnit)]);
  appendRecords(DIR1, [wirePost]);
  const matches = loadRecords(DIR1).filter((e) => e.kind === "post" && e.provenance.source === "x" && e.provenance.id === SHARED_SID);
  check("cross-sensor merge (screen-then-wire): exactly ONE entry for the shared id, not two", matches.length === 1, `got ${matches.length}`);
  const merged = matches[0];
  check("cross-sensor merge: richest-text-wins picks the wire response's longer body", merged && merged.text === wirePost.text);
  check("cross-sensor merge: the merged record is not marked stub (both sides were real)", merged && merged.stub !== true);
  rmSync(DIR1, { recursive: true, force: true });
}

// Order 2: WIRE arrives first (the GraphQL response beat the screen sensor's own capture-on-change
// tick to the store), SCREEN captures moments later — order independence.
{
  const DIR2 = tmpDir();
  const screenUnit = units.find((u) => u.id === `x:${SHARED_SID}`);
  appendRecords(DIR2, [wirePost]);
  appendRecords(DIR2, [unitToRecord(screenUnit)]);
  const matches = loadRecords(DIR2).filter((e) => e.kind === "post" && e.provenance.source === "x" && e.provenance.id === SHARED_SID);
  check("cross-sensor merge (wire-then-screen): exactly ONE entry for the shared id, not two", matches.length === 1, `got ${matches.length}`);
  const merged = matches[0];
  check("cross-sensor merge, reverse order: richest-text-wins STILL picks the longer (wire) body", merged && merged.text === wirePost.text);
  rmSync(DIR2, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

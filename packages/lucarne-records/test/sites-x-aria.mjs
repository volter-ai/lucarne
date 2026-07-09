// LS-05a — golden tests for the ported X ARIA extractor (`sites/x-aria.ts`),
// ported from `cadence/src/units.ts:21-103`'s `extractUnits`. These are the
// extractor-relevant cases the task spec asks to port from cadence's
// `segment.test.mjs`/`units-merge.test.mjs` (snowflake-time / chrome-strip /
// stub-parent-upsert) — LS-03/LS-04 already ported `units-merge.test.mjs`'s
// `appendUnits`-merge halves as `test/store.mjs`/`test/unit-to-record.mjs`, so
// this file covers the half neither of those touch: the EXTRACTOR itself,
// which had no dedicated unit test in cadence (verified: `grep -rl
// extractUnits cadence/test` finds nothing — cadence exercised it only
// end-to-end via `recall.ts`). Fixtures below are modeled on the same live
// thread `cadence/test/fixtures/x-valid.json` captures (a Sakana Fugu-style
// post + replies on x.com), reshaped into the raw ARIA-snapshot text
// `extractUnits`/`extractXAriaUnits` actually consumes (x-valid.json itself is
// a DIFFERENT, higher-level "reading" schema used elsewhere in cadence, not
// the ARIA snapshot text this extractor parses).
//
// Run with `node test/sites-x-aria.mjs` (after `npm run build`).
import assert from "node:assert/strict";
import { extractXAriaUnits, extractXAriaRecords, snowflakeTime, xAriaExtractor } from "../dist/sites/x-aria.js";
import { isEntity } from "../dist/validate.js";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// ── fixture status ids (Snowflakes) + independently-computed expected times ──
// Computed straight from the Snowflake formula (`(BigInt(sid) >> 22n) +
// 1288834974657n`, the X epoch) OUTSIDE the module under test, so this is a
// real cross-check of `snowflakeTime`, not a tautology.
const ROOT_SID = "1234567890123456789";
const ROOT_CREATED_AT = "2020-03-02T19:54:56.824Z";
const REPLY_SID = "4444444444444444444";
const REPLY_CREATED_AT = "2044-06-02T09:38:23.997Z";
const AD_SID = "3333333333333333333";

// ── raw ARIA-snapshot-shaped fixtures (Playwright `ariaSnapshot()` text) ─────
// Built as line arrays (not a template literal) so indentation is exact and
// legible: each `- article "..."` is a block at indent 0; its DIRECT children
// are at indent 2 ("  - "); a nested `/url:` line sits one level deeper (4)
// so it is scanned for the permalink but excluded from verbatim TEXT — exactly
// as `units.ts`'s indent-based block/child logic requires.
const rootPostBlock = [
  '- article "Paul Graham @paulg · Jul 1":',
  '  - link "9:00 AM":',
  `    - /url: /paulg/status/${ROOT_SID}`,
  '  - text: "A programming language is low overhead if you can write good software fast in it."',
  '  - group "5 replies, 20 reposts, 500 likes, 10000 views":',
];
// a PROMOTED/AD post — a direct `text: Ad` child — must be dropped entirely.
const adBlock = ['- article "Promoted":', '  - link "":', `    - /url: /adhandle/status/${AD_SID}`, "  - text: Ad"];
// a reply carrying CHROME ("Replying to", the bare "@paulg" mention, and a
// trailing baked-in video-duration token "1:26") that must all be stripped,
// leaving only the genuine verbatim reply text.
const replyBlock = [
  '- article "Jane Doe @janedoe · Jul 1":',
  '  - link "10:00 AM":',
  `    - /url: /janedoe/status/${REPLY_SID}`,
  '  - text: "Replying to"',
  '  - text: "@paulg"',
  '  - text: "Couldn\'t agree more — this insight changed how I think about tooling. 1:26"',
  '  - group "0 replies, 0 reposts, 3 likes":',
];

const THREAD_PAGE_URL = `https://x.com/paulg/status/${ROOT_SID}`;

// ── 1. full thread capture (root + reply present; an ad slot mixed in) ──────
{
  const aria = [...rootPostBlock, ...adBlock, ...replyBlock].join("\n");
  const capture = { page: THREAD_PAGE_URL, from: "aria/2026-07-08.txt", ts: "2026-07-08T12:00:00.000Z", reason: "scrolled", by: "human" };
  const units = extractXAriaUnits(aria, capture);

  check("thread capture: the AD article is dropped entirely (only post+comment remain)", units.length === 2, `got ${units.length}`);

  const post = units.find((u) => u.kind === "post");
  const comment = units.find((u) => u.kind === "comment");
  check("thread capture: the root article on its own thread page is kind:'post'", !!post);
  check("thread capture: the reply article is kind:'comment'", !!comment);

  check("root: id is the branded 'x:<sid>'", post.id === `x:${ROOT_SID}`);
  check("root: handle recovered from the /url: permalink", post.handle === "@paulg");
  check(
    "root: verbatim text carried through (no chrome to strip here)",
    post.text === "A programming language is low overhead if you can write good software fast in it.",
  );
  check("root: metrics parsed case-insensitively from the action group", JSON.stringify(post.metrics) === JSON.stringify({ replies: 5, reposts: 20, likes: 500, views: 10000 }));
  check("root: bookmarks metric is undefined when the group never mentions it", post.metrics.bookmarks === undefined);
  check(
    "SNOWFLAKE: root.created_at decodes the authored time from the status id, matching an independently-computed value",
    post.created_at === ROOT_CREATED_AT,
    `got ${post.created_at}`,
  );
  check("SNOWFLAKE: snowflakeTime() is exported and agrees with the unit's created_at", snowflakeTime(ROOT_SID) === ROOT_CREATED_AT);
  check("root: no stub flag on a genuinely-captured post", post.stub === undefined);

  check("comment: id is the branded 'x:<sid>'", comment.id === `x:${REPLY_SID}`);
  check("comment: parent points at the THREAD ROOT (the page's own sid)", comment.parent === `x:${ROOT_SID}`);
  check(
    "CHROME-STRIP: 'Replying to' is dropped, the bare '@paulg' mention is dropped, the trailing baked-in '1:26' duration is stripped — only the genuine reply text survives",
    comment.text === "Couldn't agree more — this insight changed how I think about tooling.",
    `got ${JSON.stringify(comment.text)}`,
  );
  check("comment: metrics parsed (all-zero counts still parse, not undefined)", comment.metrics.replies === 0 && comment.metrics.reposts === 0 && comment.metrics.likes === 3);
  check(
    "SNOWFLAKE: comment.created_at decodes independently of the root's id",
    comment.created_at === REPLY_CREATED_AT,
  );

  // ── record mapping — reused via unitToRecord/unitsToRecords, not reimplemented ──
  const records = extractXAriaRecords(aria, capture);
  check("extractXAriaRecords: maps 1:1 with extractXAriaUnits (ad still dropped)", records.length === 2);
  check("extractXAriaRecords: every record validates as a schema Entity", records.every(isEntity));
  check("extractXAriaRecords: every record carries provenance.via:'screen'", records.every((r) => r.provenance.via === "screen"));
  const postRecord = records.find((r) => r.kind === "post");
  const commentRecord = records.find((r) => r.kind === "comment");
  check("extractXAriaRecords: the post record is explicitly stub:false (never undefined)", postRecord.stub === false);
  check("extractXAriaRecords: the comment record's parentUrl/threadRootUrl resolve to the root's canonical url", commentRecord.parentUrl === `https://x.com/paulg/status/${ROOT_SID}` && commentRecord.threadRootUrl === commentRecord.parentUrl);

  // ── BYTE-STABLE golden snapshot of the full mapped record set ────────────
  // `provenance.fetchedAt`/`capture.ts` are the only wall-clock-shaped fields;
  // everything else is asserted verbatim against a fixed expected literal.
  const expected = [
    {
      kind: "post",
      provenance: { source: "x", id: ROOT_SID, canonicalUrl: `https://x.com/paulg/status/${ROOT_SID}`, via: "screen" },
      author: { handle: "paulg", profileUrl: "https://x.com/paulg" },
      text: "A programming language is low overhead if you can write good software fast in it.",
      createdAt: ROOT_CREATED_AT,
      metrics: { score: 500, reposts: 20, replies: 5, views: 10000 },
      capture,
      stub: false,
    },
    {
      kind: "comment",
      provenance: { source: "x", id: REPLY_SID, canonicalUrl: `https://x.com/janedoe/status/${REPLY_SID}`, via: "screen" },
      author: { handle: "janedoe", profileUrl: "https://x.com/janedoe" },
      text: "Couldn't agree more — this insight changed how I think about tooling.",
      createdAt: REPLY_CREATED_AT,
      metrics: { score: 3, reposts: 0, replies: 0, views: undefined },
      capture,
      parentUrl: `https://x.com/paulg/status/${ROOT_SID}`,
      threadRootUrl: `https://x.com/paulg/status/${ROOT_SID}`,
      depth: 0,
    },
  ];
  const strip = (r) => {
    const { provenance, ...rest } = r;
    const { fetchedAt, ...prest } = provenance;
    return { ...rest, provenance: prest };
  };
  check(
    "GOLDEN SNAPSHOT: the mapped record set is byte-stable against a fixed expected literal (fetchedAt excluded — wall-clock)",
    JSON.stringify(records.map(strip)) === JSON.stringify(expected.map(strip)),
    JSON.stringify(records.map(strip)),
  );
}

// ── 2. STUB-PARENT-UPSERT: the thread root never scrolled into this snapshot ─
{
  const aria = replyBlock.join("\n");
  const capture = { page: THREAD_PAGE_URL, from: "aria/2026-07-08b.txt" };
  const units = extractXAriaUnits(aria, capture);

  check("stub-mint: exactly a comment + a minted stub root", units.length === 2);
  const comment = units.find((u) => u.kind === "comment");
  const stub = units.find((u) => u.stub === true);
  check("stub-mint: the comment is still produced, still pointing at the root", !!comment && comment.parent === `x:${ROOT_SID}`);
  check("stub-mint: a stub root is minted with the branded root id", !!stub && stub.id === `x:${ROOT_SID}`);
  check(
    "stub-mint: the stub's handle is recovered from the PAGE URL (not from any captured article)",
    stub.handle === "@paulg",
  );
  check("stub-mint: the stub's permalink is derived, not guessed", stub.permalink === THREAD_PAGE_URL);
  check("stub-mint: text:'' is honest — content was never observed", stub.text === "");
  check("stub-mint: metrics is the empty object (no real metric was ever scraped)", JSON.stringify(stub.metrics) === "{}");
  check("stub-mint: created_at STILL decodes from the known sid (snowflake works even for a stub)", stub.created_at === ROOT_CREATED_AT);

  // maps to a record with the EXPLICIT stub:true signal store.ts's mergeEntity
  // (LS-03) treats as authoritative.
  const records = extractXAriaRecords(aria, capture);
  const stubRecord = records.find((r) => r.kind === "post");
  check("stub-mint: the mapped record carries an EXPLICIT stub:true (never left undefined/omitted)", stubRecord.stub === true);
  check("stub-mint: the stub record still validates as a schema Entity (text:'' is a legal Post)", isEntity(stubRecord));
}

// ── 2b. no stub is minted when the root IS present in the same snapshot ─────
{
  const aria = [...rootPostBlock, ...replyBlock].join("\n");
  const units = extractXAriaUnits(aria, { page: THREAD_PAGE_URL });
  check("no-stub: root present -> no stub minted (exactly 2 real units)", units.length === 2 && units.every((u) => !u.stub));
}

// ── 3. FEED page (no /status/ in the page url): every article is a post ────
{
  const aria = [...rootPostBlock, ...replyBlock].join("\n");
  const units = extractXAriaUnits(aria, { page: "https://x.com/home" });
  check("feed page: every article is kind:'post' (no thread context to make anything a comment)", units.every((u) => u.kind === "post"));
  check("feed page: no stub is minted on a feed (no comments exist to orphan)", units.every((u) => !u.stub));
  check("feed page: both articles are addressable units", units.length === 2);
}

// ── 4. the {match, extract} plugin shape LS-13 registers as an extractor ────
{
  check("xAriaExtractor.match: true for x.com urls", xAriaExtractor.match("https://x.com/paulg/status/1"));
  check("xAriaExtractor.match: true for twitter.com urls", xAriaExtractor.match("https://twitter.com/paulg"));
  check("xAriaExtractor.match: false for an unrelated site", !xAriaExtractor.match("https://reddit.com/r/foo"));
  const aria = rootPostBlock.join("\n");
  const records = xAriaExtractor.extract(aria, { page: "https://x.com/home" });
  check("xAriaExtractor.extract: delegates to extractXAriaRecords (same output)", records.length === 1 && records[0].provenance.via === "screen");
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

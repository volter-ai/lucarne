// LS-04 dev/02 — `unitToRecord()` maps a fixture cadence `Unit` (a post, a
// comment-with-parent, and a stub) to valid records losslessly, and the stub
// Unit's output carries an explicit stub signal that `mergeEntity` treats as
// authoritative (real-ness is sticky, in BOTH merge orders).
//
// Run with `node test/unit-to-record.mjs` (after `npm run build`).
import assert from "node:assert/strict";
import { unitToRecord, unitsToRecords } from "../dist/unit-to-record.js";
import { isEntity } from "../dist/validate.js";
import { appendRecords, loadRecords } from "../dist/store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// ── fixture cadence Units (shape from cadence/src/types.ts:42-69, cadence/src/units.ts) ──

// A real POST, captured on a feed (no thread context) — the shape `extractUnits`
// produces for `kind === 'post'` (units.ts:87-89).
const postUnit = {
  id: "x:1234567890123456789",
  channel: "x",
  kind: "post",
  handle: "@paulg",
  permalink: "https://x.com/paulg/status/1234567890123456789",
  text: "A programming language is low overhead if you can write good software fast in it.",
  created_at: "2026-07-01T09:00:00.000Z",
  metrics: { replies: 5, reposts: 20, likes: 500, bookmarks: 12, views: 10000 },
  capture: {
    from: ".social/recall/aria/2026-07-08.txt",
    screenshot: ".social/recall/shots/2026-07-08.png",
    ts: "2026-07-08T12:00:00.000Z",
    reason: "scrolled",
    by: "human",
    page: "https://x.com/home",
  },
  media: [{ image: ".social/recall/shots/crop1.png", alt: "a chart" }],
};

// A real COMMENT with a `parent` — captured on the thread page (units.ts:88).
const commentUnit = {
  id: "x:2222222222222222222",
  channel: "x",
  kind: "comment",
  handle: "@bob",
  permalink: "https://x.com/bob/status/2222222222222222222",
  text: "Completely agree with this.",
  created_at: "2026-07-01T10:00:00.000Z",
  metrics: { replies: 0, reposts: 0, likes: 3, bookmarks: undefined, views: undefined },
  capture: {
    from: ".social/recall/aria/2026-07-08b.txt",
    screenshot: null,
    ts: "2026-07-08T12:05:00.000Z",
    reason: "navigated",
    by: "agent",
    page: "https://x.com/paulg/status/1234567890123456789",
  },
  parent: "x:1234567890123456789",
};

// A minted STUB post — the shape `extractUnits`'s stub-upsert mints (units.ts:97-100):
// id+handle known from the page url, content never observed. text:'' + stub:true.
const stubUnit = {
  id: "x:9999999999999999999",
  channel: "x",
  kind: "post",
  stub: true,
  handle: "@carol",
  permalink: "https://x.com/carol/status/9999999999999999999",
  text: "",
  created_at: "2026-06-30T00:00:00.000Z",
  metrics: {},
  capture: {
    from: ".social/recall/aria/2026-07-08c.txt",
    screenshot: null,
    ts: "2026-07-08T12:10:00.000Z",
    reason: "scrolled",
    by: "human",
    page: "https://x.com/carol/status/9999999999999999999",
  },
};

// ── post mapping — every field enumerated ─────────────────────────────────────
{
  const record = unitToRecord(postUnit);
  check("unitToRecord(post): produces kind:'post'", record.kind === "post");
  check("unitToRecord(post): id 'x:<sid>' splits into provenance.source='x'", record.provenance.source === "x");
  check("unitToRecord(post): id 'x:<sid>' splits into provenance.id=<bare sid>", record.provenance.id === "1234567890123456789");
  check("unitToRecord(post): permalink -> canonicalUrl", record.provenance.canonicalUrl === postUnit.permalink);
  check("unitToRecord(post): provenance.via is 'screen'", record.provenance.via === "screen");
  check("unitToRecord(post): provenance.fetchedAt comes from capture.ts", record.provenance.fetchedAt === postUnit.capture.ts);
  check("unitToRecord(post): handle -> author.handle (leading @ stripped)", record.author.handle === "paulg");
  check("unitToRecord(post): author.profileUrl is derived from the handle", record.author.profileUrl === "https://x.com/paulg");
  check("unitToRecord(post): text carried verbatim", record.text === postUnit.text);
  check("unitToRecord(post): created_at -> createdAt", record.createdAt === postUnit.created_at);
  check("unitToRecord(post): metrics.likes -> metrics.score", record.metrics.score === 500);
  check("unitToRecord(post): metrics.reposts -> metrics.reposts", record.metrics.reposts === 20);
  check("unitToRecord(post): metrics.replies -> metrics.replies", record.metrics.replies === 5);
  check("unitToRecord(post): metrics.views -> metrics.views", record.metrics.views === 10000);
  check("unitToRecord(post): metrics.bookmarks (no schema field) -> raw.bookmarks", record.raw && record.raw.bookmarks === 12);
  check("unitToRecord(post): media (no schema field) -> raw.media", record.raw && Array.isArray(record.raw.media) && record.raw.media[0].alt === "a chart");
  check("unitToRecord(post): capture pointer carried through verbatim", JSON.stringify(record.capture) === JSON.stringify(postUnit.capture));
  check("unitToRecord(post): a REAL (non-stub) unit gets an EXPLICIT stub:false (never left undefined)", record.stub === false);
  check("unitToRecord(post): the mapped record validates as an Entity", isEntity(record));
}

// ── comment mapping — parent -> thread linkage, every field enumerated ───────
{
  const record = unitToRecord(commentUnit);
  check("unitToRecord(comment): produces kind:'comment'", record.kind === "comment");
  check("unitToRecord(comment): id 'x:<sid>' splits into provenance.{source,id}", record.provenance.source === "x" && record.provenance.id === "2222222222222222222");
  check("unitToRecord(comment): permalink -> canonicalUrl", record.provenance.canonicalUrl === commentUnit.permalink);
  check("unitToRecord(comment): handle -> author.handle", record.author.handle === "bob");
  check("unitToRecord(comment): text carried verbatim", record.text === commentUnit.text);
  check("unitToRecord(comment): metrics.likes -> metrics.score", record.metrics.score === 3);
  // parent ('x:1234567890123456789') resolves to a URL, using capture.page since its sid matches the parent's.
  const expectedParentUrl = "https://x.com/paulg/status/1234567890123456789";
  check("unitToRecord(comment): parent -> parentUrl (thread root)", record.parentUrl === expectedParentUrl);
  check("unitToRecord(comment): parent -> threadRootUrl (cadence's model is flat: parent IS the root)", record.threadRootUrl === expectedParentUrl);
  check("unitToRecord(comment): parentUrl === threadRootUrl (no intermediate nesting in cadence's Unit shape)", record.parentUrl === record.threadRootUrl);
  check("unitToRecord(comment): depth is 0 (cadence tracks no nesting depth)", record.depth === 0);
  check("unitToRecord(comment): capture pointer carried through verbatim", JSON.stringify(record.capture) === JSON.stringify(commentUnit.capture));
  check("unitToRecord(comment): no stub field is set on comments (cadence: Comment.stub is 'never')", !("stub" in record));
  check("unitToRecord(comment): the mapped record validates as an Entity", isEntity(record));
}

// ── stub mapping — honest text:'' + the EXPLICIT stub signal ─────────────────
{
  const record = unitToRecord(stubUnit);
  check("unitToRecord(stub): produces kind:'post'", record.kind === "post");
  check("unitToRecord(stub): text is '' (honest — we know the thread exists, not its content)", record.text === "");
  check("unitToRecord(stub): stub:true is set EXPLICITLY on the record (the load-bearing signal)", record.stub === true);
  check("unitToRecord(stub): handle/permalink/provenance still map through (id+handle ARE known)", record.author.handle === "carol" && record.provenance.canonicalUrl === stubUnit.permalink);
  check("unitToRecord(stub): the mapped stub record still validates as an Entity (text:'' is a legal Post)", isEntity(record));
}

// ── unitsToRecords: batch convenience ─────────────────────────────────────────
{
  const records = unitsToRecords([postUnit, commentUnit, stubUnit]);
  check("unitsToRecords: maps a batch 1:1, in order", records.length === 3 && records[0].kind === "post" && records[1].kind === "comment" && records[2].kind === "post");
}

// ── unsupported channel is rejected rather than silently mis-mapped ───────────
{
  assert.throws(() => unitToRecord({ ...postUnit, id: "linkedin:1", channel: "linkedin" }), /unsupported channel/);
  check("unitToRecord: an unsupported channel (e.g. 'linkedin') throws rather than mis-mapping", true);
}

// ── CRITICAL: composes with appendRecords — stub never degrades a real record,
// in BOTH merge orders, even when the real record is text-less (image-only). ──
{
  // A REAL image-only post: cadence's ARIA extractor genuinely produces empty
  // `text` for an image-only post (no caption) — structurally indistinguishable
  // from a stub by content alone. Same id as `stubUnit`'s thread-root target,
  // simulating "the thread root eventually gets captured for real."
  const realImageOnlyUnit = {
    ...stubUnit,
    stub: undefined, // a REAL capture never sets stub:true
    text: "", // image-only: no caption text
    metrics: {}, // no metrics scraped either
    handle: "@carol_real",
  };

  // Order 1: real arrives FIRST, stub (re-mint on a later, thinner capture) arrives after.
  {
    const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-records-u2r-stub-test-"));
    appendRecords(DIR, [unitToRecord(realImageOnlyUnit)]);
    appendRecords(DIR, [unitToRecord(stubUnit)]);
    const stored = loadRecords(DIR).find((e) => e.provenance.id === stubUnit.id.split(":")[1]);
    check("compose: real-first, stub-later — the REAL record survives (author preserved)", stored.author.handle === "carol_real");
    check("compose: real-first, stub-later — the merged record is NOT itself marked stub", stored.stub !== true);
    fs.rmSync(DIR, { recursive: true, force: true });
  }

  // Order 2: stub arrives FIRST (minted from a comment's parent), real capture arrives later.
  {
    const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-records-u2r-stub2-test-"));
    appendRecords(DIR, [unitToRecord(stubUnit)]);
    appendRecords(DIR, [unitToRecord(realImageOnlyUnit)]);
    const stored = loadRecords(DIR).find((e) => e.provenance.id === stubUnit.id.split(":")[1]);
    check("compose: stub-first, real-later — the REAL record wins the merge (author = real)", stored.author.handle === "carol_real");
    check("compose: stub-first, real-later — the merged record is NOT itself marked stub", stored.stub !== true);
    fs.rmSync(DIR, { recursive: true, force: true });
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

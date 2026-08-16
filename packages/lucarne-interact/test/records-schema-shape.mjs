// LS-03 dev/02 — type/shape parity + provenance-required validation.
// LS-29 (generalize-records): fixtures generalized off the social domain (source:"x"→"example",
// "hackernews"→"example2") to prove the GENERAL core, not a social-specific one — this package no
// longer closes the `source`/`kind` sets (see schema.ts/validate.ts). The closed-source assertion is
// FLIPPED (an arbitrary source string now PASSES; only an EMPTY source fails) and the per-kind
// (author/parentUrl/depth/handle) required-field checks are dropped — those are a domain package's
// concern now (`cadence/src/records/schema.ts`'s own type guards), not this validator's.
//
// Every fixture round-trips through JSON (simulating a disk write/read, exactly how the store
// persists records) and must still validate as a general record. A record missing `provenance` (or
// missing a required provenance field) must FAIL validation — that's the load-bearing assertion this
// file proves, not just typed away.
//
// Run with `node test/schema-shape.mjs` (after `npm run build`).
import assert from "node:assert/strict";
import { isEntity, assertEntity } from "../dist/records/validate.js";
import { encodeCursor, decodeCursor } from "../dist/records/cursor.js";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const roundTrip = (v) => JSON.parse(JSON.stringify(v));

// ── fixtures (schema.ts:25-35 Provenance, Profile/Post/Comment, :148-152 Page<T>) ──
const profile = {
  kind: "profile",
  provenance: {
    source: "example",
    id: "u_paulg",
    canonicalUrl: "https://example.test/paulg",
    fetchedAt: "2026-07-08T12:00:00.000Z",
    via: "dom",
  },
  handle: "paulg",
  displayName: "Paul Graham",
  bio: "Bit of everything.",
  metrics: { followers: 2000000, following: 100 },
};

const post = {
  kind: "post",
  provenance: {
    source: "example",
    id: "1234567890123456789",
    canonicalUrl: "https://example.test/paulg/status/1234567890123456789",
    fetchedAt: "2026-07-08T12:00:01.000Z",
    via: "internal-api",
  },
  author: { handle: "paulg", profileUrl: "https://example.test/paulg" },
  text: "A programming language is low overhead if you can write good software fast in it.",
  createdAt: "2026-07-01T09:00:00.000Z",
  metrics: { score: 500, reposts: 20, replies: 5, views: 10000 },
};

const comment = {
  kind: "comment",
  provenance: {
    source: "example2",
    id: "40000001",
    canonicalUrl: "https://example2.test/item?id=40000001",
    fetchedAt: "2026-07-08T12:00:02.000Z",
    via: "internal-api",
  },
  author: { handle: "patio11", profileUrl: "https://example2.test/user?id=patio11" },
  text: "This matches my experience running SaaS pricing experiments.",
  metrics: { score: 42, replies: 2 },
  parentUrl: "https://example2.test/item?id=39999999",
  threadRootUrl: "https://example2.test/item?id=39999999",
  depth: 0,
};

// ── Profile round-trip ──────────────────────────────────────────────────────
{
  const rt = roundTrip(profile);
  check("Profile: round-trips through JSON with all fields intact", JSON.stringify(rt) === JSON.stringify(profile));
  check("Profile: validates as an Entity", isEntity(rt));
  check("Profile: assertEntity returns it unchanged", assertEntity(rt).handle === "paulg");
}

// ── Post round-trip ──────────────────────────────────────────────────────────
{
  const rt = roundTrip(post);
  check("Post: round-trips through JSON with all fields intact", JSON.stringify(rt) === JSON.stringify(post));
  check("Post: validates as an Entity", isEntity(rt));
  check("Post: author/metrics/provenance shapes preserved", rt.author.handle === "paulg" && rt.metrics.score === 500 && rt.provenance.via === "internal-api");
}

// ── Comment round-trip ────────────────────────────────────────────────────────
{
  const rt = roundTrip(comment);
  check("Comment: round-trips through JSON with all fields intact", JSON.stringify(rt) === JSON.stringify(comment));
  check("Comment: validates as an Entity", isEntity(rt));
  check("Comment: parent/threadRoot/depth preserved", rt.parentUrl === comment.parentUrl && rt.threadRootUrl === comment.threadRootUrl && rt.depth === 0);
}

// ── Page<T> shape (schema.ts:148-152) ─────────────────────────────────────────
{
  /** @type {import('../dist/schema.js').Page<unknown>} */
  const page = { items: [post, comment], truncated: true, nextCursor: encodeCursor({ offset: 2 }) };
  const rt = roundTrip(page);
  check("Page<T>: items array round-trips", Array.isArray(rt.items) && rt.items.length === 2);
  check("Page<T>: truncated is a boolean", typeof rt.truncated === "boolean" && rt.truncated === true);
  check("Page<T>: nextCursor is present and opaque (decodes back)", typeof rt.nextCursor === "string" && decodeCursor(rt.nextCursor).offset === 2);

  const emptyLastPage = { items: [], truncated: false };
  check("Page<T>: nextCursor is legitimately absent when there's no next page", !("nextCursor" in emptyLastPage) && emptyLastPage.truncated === false);
}

// ── cursor helpers round-trip arbitrary structured state ──────────────────────
{
  const state = { queue: ["a", "b", "c"], offset: 7, nested: { x: 1 } };
  const cursor = encodeCursor(state);
  check("cursor: encodeCursor produces an opaque string", typeof cursor === "string" && cursor.length > 0);
  check("cursor: decodeCursor round-trips structured state losslessly", JSON.stringify(decodeCursor(cursor)) === JSON.stringify(state));
}

// ── provenance is REQUIRED — a record missing it must fail validation ────────
{
  const { provenance, ...profileNoProvenance } = profile;
  check("validation: a Profile missing `provenance` entirely fails isEntity", !isEntity(profileNoProvenance));
  assert.throws(() => assertEntity(profileNoProvenance), /provenance/i);
  check("validation: assertEntity throws (mentioning provenance) for a record missing it", true);

  const postMissingFetchedAt = { ...post, provenance: { ...post.provenance } };
  delete postMissingFetchedAt.provenance.fetchedAt;
  check("validation: a Post whose provenance is missing `fetchedAt` fails isEntity", !isEntity(postMissingFetchedAt));

  // LS-29: source is OPEN — any non-empty string is a legitimate namespace (a domain package, not
  // this one, decides what sources exist). An arbitrary source now PASSES; only an EMPTY source fails.
  const commentArbitrarySource = { ...comment, provenance: { ...comment.provenance, source: "not-a-real-site" } };
  check("validation: an ARBITRARY provenance.source now PASSES isEntity (source is open, not a closed allow-list)", isEntity(commentArbitrarySource));
  const commentEmptySource = { ...comment, provenance: { ...comment.provenance, source: "" } };
  check("validation: an EMPTY provenance.source still fails isEntity (non-empty string is still required)", !isEntity(commentEmptySource));

  const commentEmptyKind = { ...comment, kind: "" };
  check("validation: an empty `kind` fails isEntity (kind is open but must be a non-empty string)", !isEntity(commentEmptyKind));
  const commentArbitraryKind = { ...comment, kind: "arbitrary-domain-kind" };
  check("validation: an ARBITRARY `kind` (not profile/post/comment) PASSES isEntity (kind is open, not a closed set)", isEntity(commentArbitraryKind));

  const commentViaScreen = { ...comment, provenance: { ...comment.provenance, via: "screen" } };
  check("validation: via:'screen' IS valid now that LS-04 extended the schema", isEntity(commentViaScreen));

  const commentBadVia = { ...comment, provenance: { ...comment.provenance, via: "replayed-fetch" } };
  check("validation: an unrecognized via value still fails isEntity (VIA list is a closed set)", !isEntity(commentBadVia));

  check("validation: a bare object with no kind/provenance fails isEntity", !isEntity({ foo: "bar" }));
  check("validation: null/undefined fail isEntity without throwing", !isEntity(null) && !isEntity(undefined));
}

// ── LS-04 dev/01 — all three `via` values + the `capture` pointer ────────────
{
  // all three via values validate on an otherwise-identical Post fixture.
  for (const via of ["internal-api", "dom", "screen"]) {
    const p = { ...post, provenance: { ...post.provenance, via } };
    check(`LS-04: via:'${via}' validates`, isEntity(p));
  }

  // a via:'screen' record carrying a FULL capture pointer — every field from
  // cadence/src/types.ts:17-24 (from, screenshot, ts, reason, by, page).
  const fullCapture = {
    from: ".social/recall/aria/2026-07-08T12-00-00.txt",
    screenshot: ".social/recall/shots/2026-07-08T12-00-00.png",
    ts: "2026-07-08T12:00:00.000Z",
    reason: "scrolled",
    by: "human",
    page: "https://x.com/paulg/status/1234567890123456789",
  };
  const screenPost = {
    ...post,
    provenance: { ...post.provenance, via: "screen" },
    capture: fullCapture,
  };
  check("LS-04: a via:'screen' record with a full capture pointer validates", isEntity(screenPost));
  const rt = roundTrip(screenPost);
  check("LS-04: the capture pointer round-trips through JSON with every field intact", JSON.stringify(rt.capture) === JSON.stringify(fullCapture));
  check("LS-04: the capture pointer's individual fields are all present", rt.capture.from === fullCapture.from && rt.capture.screenshot === fullCapture.screenshot && rt.capture.ts === fullCapture.ts && rt.capture.reason === fullCapture.reason && rt.capture.by === fullCapture.by && rt.capture.page === fullCapture.page);

  // capture is optional and structural-only — present-but-not-an-object fails,
  // absent is fine, an empty object is fine (every field inside is optional).
  const badCapture = { ...post, capture: "not-an-object" };
  check("LS-04: a non-object `capture` fails isEntity", !isEntity(badCapture));
  const emptyCapture = { ...post, capture: {} };
  check("LS-04: an empty `capture` object still validates (every field inside is optional)", isEntity(emptyCapture));

  // a Comment can carry a capture pointer too.
  const screenComment = { ...comment, provenance: { ...comment.provenance, via: "screen" }, capture: fullCapture };
  check("LS-04: a Comment with via:'screen' + a capture pointer validates", isEntity(screenComment));

  // the explicit `stub` signal (Post only) — must be a real boolean when present.
  const realStubFalse = { ...post, stub: false };
  check("LS-04: an explicit stub:false Post validates", isEntity(realStubFalse));
  const mintedStubTrue = { ...post, text: "", metrics: {}, stub: true };
  check("LS-04: an explicit stub:true Post (a minted placeholder) validates", isEntity(mintedStubTrue));
  const badStub = { ...post, stub: "yes" };
  check("LS-04: a non-boolean `stub` fails isEntity", !isEntity(badStub));
  const rtStub = roundTrip(mintedStubTrue);
  check("LS-04: `stub` round-trips through JSON intact", rtStub.stub === true);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

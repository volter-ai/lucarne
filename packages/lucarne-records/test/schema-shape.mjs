// LS-03 dev/02 — type/shape parity + provenance-required validation.
//
// Fixtures mirror the shapes at
// `claude-socials/packages/shared/src/schema.ts:25-35,148-152` (Provenance,
// Profile/Post/Comment, Page<T>). Every fixture round-trips through JSON
// (simulating a disk write/read, exactly how the store persists records) and
// must still validate as the right Entity. A record missing `provenance` (or
// missing a required provenance field) must FAIL validation — that's the
// load-bearing assertion this file proves, not just typed away.
//
// Run with `node test/schema-shape.mjs` (after `npm run build`).
import assert from "node:assert/strict";
import { isEntity, assertEntity } from "../dist/validate.js";
import { encodeCursor, decodeCursor } from "../dist/cursor.js";

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
    source: "x",
    id: "u_paulg",
    canonicalUrl: "https://x.com/paulg",
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
    source: "x",
    id: "1234567890123456789",
    canonicalUrl: "https://x.com/paulg/status/1234567890123456789",
    fetchedAt: "2026-07-08T12:00:01.000Z",
    via: "internal-api",
  },
  author: { handle: "paulg", profileUrl: "https://x.com/paulg" },
  text: "A programming language is low overhead if you can write good software fast in it.",
  createdAt: "2026-07-01T09:00:00.000Z",
  metrics: { score: 500, reposts: 20, replies: 5, views: 10000 },
};

const comment = {
  kind: "comment",
  provenance: {
    source: "hackernews",
    id: "40000001",
    canonicalUrl: "https://news.ycombinator.com/item?id=40000001",
    fetchedAt: "2026-07-08T12:00:02.000Z",
    via: "internal-api",
  },
  author: { handle: "patio11", profileUrl: "https://news.ycombinator.com/user?id=patio11" },
  text: "This matches my experience running SaaS pricing experiments.",
  metrics: { score: 42, replies: 2 },
  parentUrl: "https://news.ycombinator.com/item?id=39999999",
  threadRootUrl: "https://news.ycombinator.com/item?id=39999999",
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

  const commentBadSource = { ...comment, provenance: { ...comment.provenance, source: "not-a-real-site" } };
  check("validation: a Comment with an invalid provenance.source fails isEntity", !isEntity(commentBadSource));

  const commentBadVia = { ...comment, provenance: { ...comment.provenance, via: "screen" } };
  check("validation: via:'screen' is NOT valid on this (un-extended) schema — that's LS-04's job", !isEntity(commentBadVia));

  check("validation: a bare object with no kind/provenance fails isEntity", !isEntity({ foo: "bar" }));
  check("validation: null/undefined fail isEntity without throwing", !isEntity(null) && !isEntity(undefined));
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

// LS-06 dev/02 — query proof: against a SEEDED lucarne-records store the
// five reshaped tools (queries.ts) return the seeded records WITH
// provenance; a query with no matching capture returns a structured
// `not_captured` result (with a browse-to-it hint), never a network call.
//
// Run with `node test/queries.mjs` (after `npm run build`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendRecords } from "lucarne-records";
import { getProfile, getPost, getComments, search, getTimeline } from "../dist/queries.js";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-corpus-mcp-query-test-"));

const prov = (id, over = {}) => ({
  source: "x",
  id,
  canonicalUrl: `https://x.com/i/status/${id}`,
  fetchedAt: "2026-07-08T12:00:00.000Z",
  via: "internal-api",
  ...over,
});

// ── seed the store (same fixture shape as lucarne-records' own query tests) ──
const profile = {
  kind: "profile",
  provenance: prov("u_ada", { canonicalUrl: "https://x.com/ada" }),
  handle: "ada",
  displayName: "Ada Lovelace",
  bio: "Mathematician and writer.",
  metrics: { followers: 900 },
};
const rootPost = {
  kind: "post",
  provenance: prov("9001", { canonicalUrl: "https://x.com/ada/status/9001" }),
  author: { handle: "someone", profileUrl: "https://x.com/someone" },
  text: "the thread root post everyone replies to",
  metrics: { score: 10 },
};
const comment1 = {
  kind: "comment",
  provenance: prov("9002"),
  author: { handle: "bob", profileUrl: "https://x.com/bob" },
  text: "great point",
  metrics: { score: 3 },
  parentUrl: "https://x.com/ada/status/9001",
  threadRootUrl: "https://x.com/ada/status/9001",
  depth: 0,
  createdAt: "2026-07-01T00:00:00.000Z",
};
const comment2 = {
  kind: "comment",
  provenance: prov("9003"),
  author: { handle: "carol", profileUrl: "https://x.com/carol" },
  text: "counterpoint, going deeper",
  metrics: { score: 1 },
  parentUrl: "https://x.com/bob/status/9002",
  threadRootUrl: "https://x.com/ada/status/9001",
  depth: 1,
  createdAt: "2026-07-02T00:00:00.000Z",
};
const userPost1 = {
  kind: "post",
  provenance: prov("9101"),
  author: { handle: "ada", profileUrl: "https://x.com/ada" },
  text: "ada's own first post about lambda calculus",
  metrics: { score: 5 },
  createdAt: "2026-06-01T00:00:00.000Z",
};
const userPost2 = {
  kind: "post",
  provenance: prov("9102"),
  author: { handle: "ada", profileUrl: "https://x.com/ada" },
  text: "ada's own second post about analytical engines",
  metrics: { score: 8 },
  createdAt: "2026-06-15T00:00:00.000Z",
};

// LS-33 (store-generalize): a SECOND profile fixture that carries `text` as its canonical body
// instead of `bio` (the shape a `lucarne-records`-LS-33 producer, e.g. cadence's `x-graphql.ts`,
// now emits) — proves get_profile/search work over BOTH a bio-only legacy fixture (`profile`
// above) and a text-carrying one, since lucarne-records' store/query no longer special-case
// `kind==="profile"` to route content through `bio` only.
const textProfile = {
  kind: "profile",
  provenance: prov("u_grace", { canonicalUrl: "https://x.com/grace_h" }),
  handle: "grace_h",
  displayName: "Grace Hopper",
  text: "Pioneering computer scientist and Navy rear admiral.",
  bio: "Pioneering computer scientist and Navy rear admiral.",
  metrics: { followers: 500 },
};

appendRecords(DIR, [profile, textProfile, rootPost, comment1, comment2, userPost1, userPost2]);

// ── get_profile: hit, with provenance ─────────────────────────────────────
{
  const r = getProfile(DIR, { source: "x", handle: "ada" });
  check("get_profile: hit returns status:ok", r.status === "ok");
  check("get_profile: returns the seeded profile", r.status === "ok" && r.data.handle === "ada" && r.data.displayName === "Ada Lovelace");
  check("get_profile: carries provenance (source/id/canonicalUrl/fetchedAt/via)", r.status === "ok" && r.data.provenance.source === "x" && r.data.provenance.canonicalUrl === "https://x.com/ada" && r.data.provenance.via === "internal-api");
}

// ── get_profile: LS-33 — a text-carrying fixture (not bio-only) also works ────────────────
{
  const r = getProfile(DIR, { source: "x", handle: "grace_h" });
  check("get_profile (LS-33 text-carrying fixture): hit returns status:ok", r.status === "ok");
  check(
    "get_profile (LS-33 text-carrying fixture): returns the seeded profile with its `text` intact",
    r.status === "ok" && r.data.handle === "grace_h" && r.data.text === textProfile.text,
  );
}

// ── get_profile: miss -> not_captured with browse hint ───────────────────
{
  const r = getProfile(DIR, { source: "x", handle: "nobody_has_browsed_this_handle" });
  check("get_profile: miss returns status:not_captured", r.status === "not_captured");
  check("get_profile: not_captured carries a browse-to-it hint", /browse/i.test(r.hint));
  check("get_profile: not_captured never claims a fetch happened", !/fetch(ed|ing)?\b/i.test(r.message + r.hint) || /never fetch/i.test(r.hint));
  check("get_profile: not_captured echoes the query", r.query.handle === "nobody_has_browsed_this_handle");
}

// ── get_post: hit by id AND by URL ────────────────────────────────────────
{
  const byId = getPost(DIR, { source: "x", idOrUrl: "9001" });
  check("get_post: hit by native id", byId.status === "ok" && byId.data.provenance.id === "9001");
  const byUrl = getPost(DIR, { source: "x", idOrUrl: "https://x.com/ada/status/9001" });
  check("get_post: hit by canonicalUrl", byUrl.status === "ok" && byUrl.data.provenance.id === "9001");
  const miss = getPost(DIR, { source: "x", idOrUrl: "does-not-exist" });
  check("get_post: miss returns not_captured with a browse hint", miss.status === "not_captured" && /browse/i.test(miss.hint));
}

// ── get_comments: hit returns items with provenance + Page<T> shape ──────
{
  const r = getComments(DIR, { source: "x", postIdOrUrl: "9001" });
  check("get_comments: hit returns status:ok", r.status === "ok");
  check("get_comments: both seeded comments returned", r.status === "ok" && r.data.items.length === 2);
  check("get_comments: Page<T> shape (items[]/truncated boolean)", r.status === "ok" && Array.isArray(r.data.items) && typeof r.data.truncated === "boolean");
  check("get_comments: every item carries provenance", r.status === "ok" && r.data.items.every((c) => c.provenance && c.provenance.canonicalUrl));

  const depthLimited = getComments(DIR, { source: "x", postIdOrUrl: "9001", depth: 0 });
  check("get_comments: depth:0 filters out the depth:1 reply", depthLimited.status === "ok" && depthLimited.data.items.length === 1 && depthLimited.data.items[0].provenance.id === "9002");

  const miss = getComments(DIR, { source: "x", postIdOrUrl: "no-such-post" });
  check("get_comments: miss (nothing captured under this post) returns not_captured", miss.status === "not_captured" && /browse/i.test(miss.hint));
}

// ── search: posts + users, hit and miss ───────────────────────────────────
{
  const posts = search(DIR, { source: "x", query: "lambda" });
  check("search(posts): finds the matching captured post", posts.status === "ok" && posts.data.items.length === 1 && posts.data.items[0].provenance.id === "9101");

  const users = search(DIR, { source: "x", query: "ada", type: "users" });
  check("search(users): finds the matching captured profile", users.status === "ok" && users.data.items.length === 1 && users.data.items[0].kind === "profile");

  // LS-33: users search over the text-carrying fixture finds it by its `text` field content.
  const usersByText = search(DIR, { source: "x", query: "rear admiral", type: "users" });
  check(
    "search(users, LS-33 text-carrying fixture): finds the profile via its `text` field",
    usersByText.status === "ok" && usersByText.data.items.length === 1 && usersByText.data.items[0].handle === "grace_h",
  );

  const miss = search(DIR, { source: "x", query: "no-such-term-anywhere-in-the-corpus" });
  check("search: no match returns not_captured (not an empty ok page)", miss.status === "not_captured" && /browse/i.test(miss.hint));
}

// ── get_timeline: hit + miss ───────────────────────────────────────────────
{
  const tl = getTimeline(DIR, { source: "x", kind: "user_posts", handle: "ada" });
  check("get_timeline: returns exactly ada's captured posts", tl.status === "ok" && tl.data.items.length === 2 && tl.data.items.every((p) => p.author.handle === "ada"));
  check("get_timeline: newest-first ordering preserved from lucarne-records", tl.status === "ok" && tl.data.items[0].provenance.id === "9102");

  const miss = getTimeline(DIR, { source: "x", kind: "user_posts", handle: "someone_never_browsed" });
  check("get_timeline: miss returns not_captured with a browse hint naming the handle", miss.status === "not_captured" && miss.hint.includes("someone_never_browsed"));
}

fs.rmSync(DIR, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

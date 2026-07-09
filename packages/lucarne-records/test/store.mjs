// LS-03 dev/03 — store test: appendRecords merge invariants (richest-text-wins,
// stub-never-degrades) on a fixture set, then getRecord/queryRecords over a
// seeded store return schema-valid Page<T>/entity.
//
// Run with `node test/store.mjs` (after `npm run build`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendRecords, loadRecords, recordKey } from "../dist/store.js";
import { getRecord, queryRecords } from "../dist/query.js";
import { isEntity } from "../dist/validate.js";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-records-store-test-"));

const prov = (id, over = {}) => ({
  source: "x",
  id,
  canonicalUrl: `https://x.com/i/status/${id}`,
  fetchedAt: "2026-07-08T12:00:00.000Z",
  via: "internal-api",
  ...over,
});

const post = (id, text, metrics, over = {}) => ({
  kind: "post",
  provenance: prov(id, over.provenance),
  author: { handle: "someone", profileUrl: "https://x.com/someone" },
  text,
  metrics,
  ...over,
});

// ── dev/03a: richest-text-wins ────────────────────────────────────────────────
{
  const thin = post("1001", "short", { score: 1 });
  const rich = post("1001", "this is a much longer and richer capture of the same post's text", { score: 1 });
  const added1 = appendRecords(DIR, [thin]);
  check("appendRecords: first insert of a new identity counts as added", added1 === 1);
  const added2 = appendRecords(DIR, [rich]);
  check("appendRecords: merging an existing identity does NOT count as a new add", added2 === 0);
  const stored = loadRecords(DIR).find((e) => e.provenance.id === "1001");
  check("richest-text-wins: the merged record keeps the LONGER text", stored.text === rich.text);

  // Now append the thin one again (as if re-captured) — must not regress.
  appendRecords(DIR, [thin]);
  const stillStored = loadRecords(DIR).find((e) => e.provenance.id === "1001");
  check("richest-text-wins: re-appending a thinner capture never regresses stored text", stillStored.text === rich.text);
}

// ── dev/03b: stub-never-degrades (stub arrives AFTER the real record) ────────
{
  const real = post("2002", "a fully captured real post with actual content", { score: 50, replies: 3 });
  const stub = post("2002", "", {});
  appendRecords(DIR, [real]);
  appendRecords(DIR, [stub]);
  const stored = loadRecords(DIR).find((e) => e.provenance.id === "2002");
  check("stub-never-degrades: a stub arriving after a real capture does not blank the text", stored.text === real.text);
  check("stub-never-degrades: a stub arriving after a real capture does not blank the metrics", stored.metrics.score === 50 && stored.metrics.replies === 3);
}

// ── dev/03c: stub-never-degrades, the upsert direction (stub minted FIRST, real capture arrives later) ──
{
  const stubFirst = post("3003", "", {});
  const realLater = post("3003", "the thread root, captured on a later scroll", { score: 12 });
  appendRecords(DIR, [stubFirst]);
  let stored = loadRecords(DIR).find((e) => e.provenance.id === "3003");
  check("stub-upsert: a stub is stored honestly (empty text) until a real capture exists", stored.text === "");
  appendRecords(DIR, [realLater]);
  stored = loadRecords(DIR).find((e) => e.provenance.id === "3003");
  check("stub-upsert: the stub upgrades IN PLACE the moment a real capture for the same id arrives", stored.text === realLater.text && stored.metrics.score === 12);
}

// ── dev/03d: appendRecords rejects invalid records (provenance required) ────
{
  let threw = false;
  try {
    appendRecords(DIR, [{ kind: "post", text: "no provenance at all", metrics: {} }]);
  } catch {
    threw = true;
  }
  check("appendRecords: refuses a record with no provenance rather than corrupting the store", threw);
}

// ── seed a richer store for the query surface tests ──────────────────────────
const SEED_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-records-query-test-"));
{
  const profile = {
    kind: "profile",
    provenance: prov("u_ada", { canonicalUrl: "https://x.com/ada" }),
    handle: "ada",
    displayName: "Ada Lovelace",
    bio: "Mathematician and writer.",
    metrics: { followers: 900 },
  };
  const rootPost = post("9001", "the thread root post everyone replies to", { score: 10 }, {
    provenance: prov("9001", { canonicalUrl: "https://x.com/ada/status/9001" }),
  });
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
    text: "counterpoint here",
    metrics: { score: 1 },
    parentUrl: "https://x.com/ada/status/9001",
    threadRootUrl: "https://x.com/ada/status/9001",
    depth: 0,
    createdAt: "2026-07-02T00:00:00.000Z",
  };
  const userPost1 = post("9101", "ada's own first post about lambda calculus", { score: 5 }, {
    author: { handle: "ada", profileUrl: "https://x.com/ada" },
    createdAt: "2026-06-01T00:00:00.000Z",
  });
  const userPost2 = post("9102", "ada's own second post about analytical engines", { score: 8 }, {
    author: { handle: "ada", profileUrl: "https://x.com/ada" },
    createdAt: "2026-06-15T00:00:00.000Z",
  });

  const added = appendRecords(SEED_DIR, [profile, rootPost, comment1, comment2, userPost1, userPost2]);
  check("seed: all 6 fixture entities are new identities", added === 6);
  check("seed: every loaded record validates as an Entity", loadRecords(SEED_DIR).every(isEntity));

  // ── getRecord: single-entity lookup (get_profile/get_post's shape) ─────────
  const gotProfileByHandle = getRecord(SEED_DIR, { source: "x", kind: "profile", id: "ada" });
  check("getRecord: profile lookup by handle succeeds", !!gotProfileByHandle && gotProfileByHandle.handle === "ada");

  const gotPostById = getRecord(SEED_DIR, { source: "x", kind: "post", id: "9001" });
  check("getRecord: post lookup by native id succeeds", !!gotPostById && gotPostById.provenance.id === "9001");

  const gotPostByUrl = getRecord(SEED_DIR, { source: "x", kind: "post", id: "https://x.com/ada/status/9001" });
  check("getRecord: post lookup by canonicalUrl (idOrUrl shape) succeeds", !!gotPostByUrl && gotPostByUrl.provenance.id === "9001");

  const missing = getRecord(SEED_DIR, { source: "x", kind: "post", id: "does-not-exist" });
  check("getRecord: a miss returns undefined rather than throwing", missing === undefined);

  // ── queryRecords: comments (get_comments' shape) ────────────────────────────
  const commentsPage = queryRecords(SEED_DIR, { op: "comments", source: "x", postIdOrUrl: "9001" });
  check("queryRecords(comments): returns a valid Page<Comment>", Array.isArray(commentsPage.items) && typeof commentsPage.truncated === "boolean");
  check("queryRecords(comments): both seeded comments are returned", commentsPage.items.length === 2 && commentsPage.items.every((c) => c.kind === "comment"));
  check("queryRecords(comments): not truncated (fits in default limit)", commentsPage.truncated === false && commentsPage.nextCursor === undefined);

  const commentsPageLimited = queryRecords(SEED_DIR, { op: "comments", source: "x", postIdOrUrl: "9001", limit: 1 });
  check("queryRecords(comments): limit is honored and truncated is set", commentsPageLimited.items.length === 1 && commentsPageLimited.truncated === true && typeof commentsPageLimited.nextCursor === "string");
  const nextPage = queryRecords(SEED_DIR, { op: "comments", source: "x", postIdOrUrl: "9001", limit: 1, cursor: commentsPageLimited.nextCursor });
  check("queryRecords(comments): the cursor advances to the next item, not the same one", nextPage.items[0].provenance.id !== commentsPageLimited.items[0].provenance.id);
  check("queryRecords(comments): the second page is the last (truncated:false)", nextPage.truncated === false);

  // ── queryRecords: search (search's shape) ───────────────────────────────────
  const searchPosts = queryRecords(SEED_DIR, { op: "search", source: "x", query: "lambda" });
  check("queryRecords(search, posts): text search finds the matching post", searchPosts.items.length === 1 && searchPosts.items[0].provenance.id === "9101");

  const searchUsers = queryRecords(SEED_DIR, { op: "search", source: "x", query: "ada", type: "users" });
  check("queryRecords(search, users): handle/displayName search finds the profile", searchUsers.items.length === 1 && searchUsers.items[0].kind === "profile");

  const searchNoMatch = queryRecords(SEED_DIR, { op: "search", source: "x", query: "no-such-term-anywhere" });
  check("queryRecords(search): a no-match query returns a valid EMPTY Page, not an error", searchNoMatch.items.length === 0 && searchNoMatch.truncated === false);

  // ── queryRecords: timeline (get_timeline's shape) ───────────────────────────
  const timeline = queryRecords(SEED_DIR, { op: "timeline", source: "x", kind: "user_posts", handle: "ada" });
  check("queryRecords(timeline, user_posts): returns exactly ada's own posts", timeline.items.length === 2 && timeline.items.every((p) => p.author.handle === "ada"));
  check("queryRecords(timeline, user_posts): sorted newest-first by createdAt", timeline.items[0].provenance.id === "9102");

  // Every Page from every op is schema-valid (items[], truncated boolean).
  for (const [label, page] of [["comments", commentsPage], ["search-posts", searchPosts], ["search-users", searchUsers], ["timeline", timeline]]) {
    check(`queryRecords(${label}): Page<T> shape holds (items array + boolean truncated)`, Array.isArray(page.items) && typeof page.truncated === "boolean");
  }
}

fs.rmSync(DIR, { recursive: true, force: true });
fs.rmSync(SEED_DIR, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

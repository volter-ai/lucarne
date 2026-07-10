// LS-03 dev/03 — store test: appendRecords merge invariants (richest-text-wins,
// stub-never-degrades) on a fixture set, then getRecord/queryRecords over a
// seeded store return schema-valid Page<T>/entity.
// LS-29 (generalize-records): fixtures generalized off the social domain (source:"x"→"example") to
// prove the merge/query logic holds for a GENERAL record, not a social-specific one.
//
// Run with `node test/store.mjs` (after `npm run build`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn as childSpawn } from "node:child_process";
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
  source: "example",
  id,
  canonicalUrl: `https://example.test/i/status/${id}`,
  fetchedAt: "2026-07-08T12:00:00.000Z",
  via: "internal-api",
  ...over,
});

const post = (id, text, metrics, over = {}) => ({
  kind: "post",
  provenance: prov(id, over.provenance),
  author: { handle: "someone", profileUrl: "https://example.test/someone" },
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

// ── review-fix #2: EXPLICIT stub signal is authoritative + real-ness is STICKY ──
// The load-bearing regression the reviewer demonstrated: a REAL image-only post
// (empty text, no metrics — so structurally indistinguishable from a stub) is
// degraded by a later placeholder stub. An explicit `stub:false` on the real
// record must protect it, and an explicit `stub:true` on the placeholder must
// be honored regardless of the structural heuristic.
{
  const STUB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-records-stub-test-"));
  // a REAL image-only post: no text, no metrics, but explicitly stub:false, with
  // a distinguishing author we can watch for degradation.
  const realImageOnly = { ...post("4004", "", {}), stub: false, author: { handle: "real_author", profileUrl: "https://example.test/real_author" } };
  const laterStub = { ...post("4004", "", {}), stub: true, author: { handle: "placeholder", profileUrl: "https://example.test/placeholder" } };
  appendRecords(STUB_DIR, [realImageOnly]);
  appendRecords(STUB_DIR, [laterStub]);
  let stored = loadRecords(STUB_DIR).find((e) => e.provenance.id === "4004");
  check("explicit-stub: a real (stub:false) text-less post is NOT degraded by a later stub:true (author preserved)", stored.author.handle === "real_author");
  check("explicit-stub: the merged record is not itself marked stub (real iff either contributor is real)", stored.stub !== true);

  // order independence: stub FIRST, real (stub:false) later → still real.
  const STUB_DIR2 = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-records-stub2-test-"));
  appendRecords(STUB_DIR2, [{ ...laterStub, author: { handle: "placeholder", profileUrl: "https://example.test/placeholder" } }]);
  appendRecords(STUB_DIR2, [{ ...realImageOnly, author: { handle: "real_author", profileUrl: "https://example.test/real_author" } }]);
  stored = loadRecords(STUB_DIR2).find((e) => e.provenance.id === "4004");
  check("explicit-stub: a real (stub:false) record arriving AFTER a stub wins the merge (author = real)", stored.author.handle === "real_author" && stored.stub !== true);

  // raw.stub is honored as the explicit signal too (unitToRecord may stash it there).
  const STUB_DIR3 = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-records-stub3-test-"));
  const realViaRaw = { ...post("5005", "", {}), raw: { stub: false }, author: { handle: "keep_me", profileUrl: "https://example.test/keep_me" } };
  const stubViaRaw = { ...post("5005", "", {}), raw: { stub: true }, author: { handle: "drop_me", profileUrl: "https://example.test/drop_me" } };
  appendRecords(STUB_DIR3, [realViaRaw]);
  appendRecords(STUB_DIR3, [stubViaRaw]);
  stored = loadRecords(STUB_DIR3).find((e) => e.provenance.id === "5005");
  check("explicit-stub: raw.stub is honored as the explicit signal (real raw.stub:false survives)", stored.author.handle === "keep_me");

  fs.rmSync(STUB_DIR, { recursive: true, force: true });
  fs.rmSync(STUB_DIR2, { recursive: true, force: true });
  fs.rmSync(STUB_DIR3, { recursive: true, force: true });
}

// ── review-fix #1: atomic write — a reader never sees a partial file; re-append idempotent ──
// A synchronous write loop never yields to a same-process timer, so an honest
// torn-read proof needs a SEPARATE reader PROCESS running while the writer
// rewrites the (deliberately large) store hundreds of times. With writeFileSync
// truncate-in-place a reader would routinely catch a half-written line; with the
// temp-file + renameSync path it must see a COMPLETE, fully-parseable JSONL at
// every observation. The child reads until the writer drops a `done` flag.
{
  const ATOMIC_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-records-atomic-test-"));
  const file = path.join(ATOMIC_DIR, "records.jsonl");
  const resultFile = path.join(ATOMIC_DIR, "reader-result.json");
  const doneFlag = path.join(ATOMIC_DIR, "writer-done");
  const readerScript = path.join(ATOMIC_DIR, "reader.mjs");
  fs.writeFileSync(
    readerScript,
    [
      'import fs from "node:fs";',
      "const [, , file, resultFile, doneFlag] = process.argv;",
      "const hardStop = Date.now() + 5000;",
      "let reads = 0, torn = false;",
      "while (!fs.existsSync(doneFlag) && Date.now() < hardStop) {",
      '  let raw; try { raw = fs.readFileSync(file, "utf8"); } catch { continue; }',
      "  reads++;",
      '  for (const line of raw.split("\\n")) { if (!line.trim()) continue; try { JSON.parse(line); } catch { torn = true; } }',
      "}",
      "fs.writeFileSync(resultFile, JSON.stringify({ reads, torn }));",
    ].join("\n"),
  );

  appendRecords(ATOMIC_DIR, [post("seed", "seed", { score: 0 })]);
  const child = childSpawn(process.execPath, [readerScript, file, resultFile, doneFlag], { stdio: "ignore" });
  const bigText = "x".repeat(4000); // widen every write so a torn read would be easy to catch
  for (let i = 0; i < 400; i++) {
    appendRecords(ATOMIC_DIR, [post("a" + i, bigText + " #" + i, { score: i })]);
  }
  fs.writeFileSync(doneFlag, "1");
  await new Promise((res) => child.on("close", res));
  const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  check("atomic-write: a separate reader PROCESS never observed a partial/torn file", result.reads > 0 && result.torn === false, `${result.reads} cross-process reads, all whole`);
  check("atomic-write: no stray .tmp file remains after writes", !fs.existsSync(file + ".tmp"));
  // idempotency still holds through the atomic path
  const before = loadRecords(ATOMIC_DIR).length;
  const added = appendRecords(ATOMIC_DIR, [post("a5", "x".repeat(4000) + " #5", { score: 5 })]);
  const after = loadRecords(ATOMIC_DIR).length;
  check("atomic-write: re-appending an existing record is still idempotent (no new identity, no count change)", added === 0 && before === after);
  fs.rmSync(ATOMIC_DIR, { recursive: true, force: true });
}

// ── review-fix #3: forward-schema records survive an append cycle ────────────
// A record from a schema version newer than THIS validator understands (e.g. a
// hypothetical future `via` beyond LS-04's 'internal-api'|'dom'|'screen') is
// record-shaped (has a provenance object) but not currently valid. An
// appendRecords must NOT delete it on rewrite — only garbage is dropped.
// (LS-04 itself added `via:'screen'` — now VALID, so it no longer serves as
// the "forward" fixture here; that migration is exercised positively in
// `schema-shape.mjs` instead. This test now uses a still-unsupported via to
// keep proving the forward-compatibility MECHANISM itself.)
{
  const FWD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-records-fwd-test-"));
  const file = path.join(FWD_DIR, "records.jsonl");
  const forwardRecord = {
    kind: "post",
    provenance: { source: "example", id: "future1", canonicalUrl: "https://example.test/i/status/future1", fetchedAt: "2026-07-09T00:00:00.000Z", via: "future-sensor" },
    author: { handle: "future", profileUrl: "https://example.test/future" },
    text: "captured by a not-yet-invented sensor",
    metrics: { score: 3 },
    capture: { from: "aria/2026-07-09.txt", by: "human" },
  };
  const garbage = "this is not json at all {{{";
  // hand-seed the store with a valid line, a forward-schema line, and a garbage line
  fs.mkdirSync(FWD_DIR, { recursive: true });
  fs.writeFileSync(file, [JSON.stringify(post("known1", "a normal record", { score: 1 })), JSON.stringify(forwardRecord), garbage].join("\n") + "\n");
  // sanity: the current validator does reject the forward record (so this test is meaningful)
  check("forward-schema: the via:'future-sensor' record IS rejected by the current validator (test is meaningful)", !isEntity(forwardRecord));
  // now run an append cycle
  appendRecords(FWD_DIR, [post("known2", "another normal record", { score: 2 })]);
  const raw = fs.readFileSync(file, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim());
  const parsed = lines.map((l) => JSON.parse(l));
  const survivedForward = parsed.find((p) => p.provenance && p.provenance.id === "future1");
  check("forward-schema: the unknown-but-record-shaped line survives the append cycle", !!survivedForward && survivedForward.provenance.via === "future-sensor");
  check("forward-schema: the forward record is preserved byte-faithfully (capture pointer intact)", !!survivedForward && survivedForward.capture && survivedForward.capture.by === "human");
  check("forward-schema: the garbage line is dropped", !raw.includes("not json at all"));
  check("forward-schema: valid records are still present alongside it", parsed.some((p) => p.provenance.id === "known1") && parsed.some((p) => p.provenance.id === "known2"));
  fs.rmSync(FWD_DIR, { recursive: true, force: true });
}

// ── LS-33 (store-generalize) G1: kind==="profile" is no longer a merge special case ──────────
// The panel finding: `mergeEntity` used to route the richest-text winner into `merged.bio`
// instead of the general `merged.text` whenever `merged.kind === "profile"` — a social
// convention baked into a domain-agnostic engine. These cases prove the fix directly.
{
  // (a) kind:"profile" records merge richest content into `text` (not `bio`).
  const G1A_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-records-g1a-test-"));
  const thinProfile = { kind: "profile", provenance: prov("prof-a"), handle: "thinp", text: "short bio text" };
  const richProfile = {
    kind: "profile",
    provenance: prov("prof-a"),
    handle: "thinp",
    text: "a much longer and richer profile body with lots more content than the thin capture",
  };
  appendRecords(G1A_DIR, [thinProfile]);
  appendRecords(G1A_DIR, [richProfile]);
  let stored = loadRecords(G1A_DIR).find((e) => e.provenance.id === "prof-a");
  check("G1a: kind:profile merge writes the richest content into `text`", stored.text === richProfile.text);
  check("G1a: kind:profile merge does NOT invent a `bio` field out of nowhere", stored.bio === undefined);
  fs.rmSync(G1A_DIR, { recursive: true, force: true });

  // (b) THE EXACT SKEPTIC BREAK: a non-social kind:"profile" consumer whose records carry ONLY
  // `text` (no `bio` at all) must not have its content silently redirected. Order matters: the
  // OLDER record (`prev`) carries the RICHER text, the newer one (`next`, which wins the
  // donor-wins field spread) carries the THINNER text. Under the old buggy code, `merged.text`
  // was left to the spread (= the newer, THINNER text) while the richest text was stuffed into
  // `merged.bio` — a field this consumer never reads and never wrote. The fix must make
  // `merged.text` itself hold the richest content, full stop.
  const G1B_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-records-g1b-test-"));
  const olderRicher = {
    kind: "profile",
    provenance: prov("prof-b"),
    handle: "skeptic",
    text: "a long-form identity-record body — this consumer's kind:profile has nothing to do with social bios",
  };
  const newerThinner = { kind: "profile", provenance: prov("prof-b"), handle: "skeptic", text: "short update" };
  appendRecords(G1B_DIR, [olderRicher]);
  appendRecords(G1B_DIR, [newerThinner]);
  stored = loadRecords(G1B_DIR).find((e) => e.provenance.id === "prof-b");
  check(
    "G1b (skeptic break): a non-social kind:profile consumer's `text` gets richest-text-wins, not silently thinned",
    stored.text === olderRicher.text,
  );
  check("G1b (skeptic break): no `bio` field was invented for a consumer that never used one", stored.bio === undefined);
  fs.rmSync(G1B_DIR, { recursive: true, force: true });

  // (c) legacy bio-only line + a text-carrying record → richest wins, no field loss, either
  // direction (bio richer than the new text, AND text richer than the legacy bio).
  const G1C_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-records-g1c-test-"));
  const legacyBioOnly = { kind: "profile", provenance: prov("prof-c1"), handle: "legacy1", bio: "short legacy bio" };
  const freshRicherText = {
    kind: "profile",
    provenance: prov("prof-c1"),
    handle: "legacy1",
    text: "a longer and much richer text-based body for the same profile identity",
  };
  appendRecords(G1C_DIR, [legacyBioOnly]);
  appendRecords(G1C_DIR, [freshRicherText]);
  stored = loadRecords(G1C_DIR).find((e) => e.provenance.id === "prof-c1");
  check("G1c: a richer fresh `text` beats a thinner legacy `bio` (promoted into `text`)", stored.text === freshRicherText.text);
  check("G1c: the legacy `bio` field survives unmolested alongside it (opaque field, donor-wins spread)", stored.bio === "short legacy bio");

  const richLegacyBio = {
    kind: "profile",
    provenance: prov("prof-c2"),
    handle: "legacy2",
    bio: "a long-form legacy bio captured before this package wrote a canonical `text` field for profiles at all",
  };
  const thinnerFreshText = { kind: "profile", provenance: prov("prof-c2"), handle: "legacy2", text: "short" };
  appendRecords(G1C_DIR, [richLegacyBio]);
  appendRecords(G1C_DIR, [thinnerFreshText]);
  stored = loadRecords(G1C_DIR).find((e) => e.provenance.id === "prof-c2");
  check(
    "G1c: a richer legacy `bio` beats a thinner fresh `text` — `textOf`'s legacy alias still feeds richest-text-wins, and the winner lands in `text`",
    stored.text === richLegacyBio.bio,
  );
  fs.rmSync(G1C_DIR, { recursive: true, force: true });

  // (d) stub-never-degrades is UNCHANGED for profiles (mirrors the existing post-shaped proof
  // above, over kind:"profile" instead, to prove removing the bio-write special case didn't
  // disturb the orthogonal stub invariant).
  const G1D_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-records-g1d-test-"));
  const realProfile = {
    kind: "profile",
    provenance: prov("prof-d"),
    handle: "real_handle",
    text: "a fully captured real profile body",
    stub: false,
    metrics: { followers: 10 },
  };
  const stubProfile = { kind: "profile", provenance: prov("prof-d"), handle: "placeholder_handle", text: "", stub: true, metrics: {} };
  appendRecords(G1D_DIR, [realProfile]);
  appendRecords(G1D_DIR, [stubProfile]);
  stored = loadRecords(G1D_DIR).find((e) => e.provenance.id === "prof-d");
  check("G1d: stub-never-degrades holds for kind:profile too (handle not overwritten by a later stub)", stored.handle === "real_handle");
  check("G1d: stub-never-degrades holds for kind:profile too (text not blanked by a later stub)", stored.text === realProfile.text);
  check("G1d: the merged profile is not itself marked stub (real iff either contributor is real)", stored.stub !== true);
  fs.rmSync(G1D_DIR, { recursive: true, force: true });
}

// ── LS-33 I3-3: `raw` is key-wise merged, not wholesale-replaced ─────────────────────────────
// The panel finding: `{...base, ...donor}` treats `raw` as ONE shallow field, so a donor whose
// `raw` is `{bookmarks:n}` only wholesale-replaces a prior `raw:{bookmarks, media:[...]}` —
// losing the crop pointer on every re-parse/re-merge that doesn't repeat it.
{
  const I3_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-records-i3-3-test-"));
  const withMedia = {
    kind: "post",
    provenance: prov("media-1"),
    text: "a post with an attached crop",
    raw: { media: ["https://example.test/crop/media-1.png"], bookmarks: 5 },
  };
  // A LATER re-merge (e.g. a `units extract` re-parse) that only observed the bookmark count on
  // this tick — its OWN `raw` carries nothing about media at all.
  const bookmarksOnlyRetick = { kind: "post", provenance: prov("media-1"), text: "a post with an attached crop", raw: { bookmarks: 42 } };
  appendRecords(I3_DIR, [withMedia]);
  appendRecords(I3_DIR, [bookmarksOnlyRetick]);
  let stored = loadRecords(I3_DIR).find((e) => e.provenance.id === "media-1");
  check(
    "I3-3: a bookmarks-only re-merge KEEPS the earlier `raw.media` crop pointer (key-wise merge, not wholesale replace)",
    JSON.stringify(stored.raw.media) === JSON.stringify(["https://example.test/crop/media-1.png"]),
  );
  check("I3-3: the LATER `raw.bookmarks` value wins for that key (donor-wins per key)", stored.raw.bookmarks === 42);

  // omit-when-empty: neither side ever set `raw` → no `raw:{}` invented.
  const noRawA = { kind: "post", provenance: prov("media-2"), text: "no raw here" };
  const noRawB = { kind: "post", provenance: prov("media-2"), text: "still no raw here, but richer text content" };
  appendRecords(I3_DIR, [noRawA]);
  appendRecords(I3_DIR, [noRawB]);
  stored = loadRecords(I3_DIR).find((e) => e.provenance.id === "media-2");
  check("I3-3: `raw` is omitted entirely (not `{}`) when neither contributor ever set it", !("raw" in stored));

  fs.rmSync(I3_DIR, { recursive: true, force: true });
}

// ── seed a richer store for the query surface tests ──────────────────────────
const SEED_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-records-query-test-"));
{
  const profile = {
    kind: "profile",
    provenance: prov("u_ada", { canonicalUrl: "https://example.test/ada" }),
    handle: "ada",
    displayName: "Ada Lovelace",
    bio: "Mathematician and writer.",
    metrics: { followers: 900 },
  };
  const rootPost = post("9001", "the thread root post everyone replies to", { score: 10 }, {
    provenance: prov("9001", { canonicalUrl: "https://example.test/ada/status/9001" }),
  });
  const comment1 = {
    kind: "comment",
    provenance: prov("9002"),
    author: { handle: "bob", profileUrl: "https://example.test/bob" },
    text: "great point",
    metrics: { score: 3 },
    parentUrl: "https://example.test/ada/status/9001",
    threadRootUrl: "https://example.test/ada/status/9001",
    depth: 0,
    createdAt: "2026-07-01T00:00:00.000Z",
  };
  const comment2 = {
    kind: "comment",
    provenance: prov("9003"),
    author: { handle: "carol", profileUrl: "https://example.test/carol" },
    text: "counterpoint here",
    metrics: { score: 1 },
    parentUrl: "https://example.test/ada/status/9001",
    threadRootUrl: "https://example.test/ada/status/9001",
    depth: 0,
    createdAt: "2026-07-02T00:00:00.000Z",
  };
  const userPost1 = post("9101", "ada's own first post about lambda calculus", { score: 5 }, {
    author: { handle: "ada", profileUrl: "https://example.test/ada" },
    createdAt: "2026-06-01T00:00:00.000Z",
  });
  const userPost2 = post("9102", "ada's own second post about analytical engines", { score: 8 }, {
    author: { handle: "ada", profileUrl: "https://example.test/ada" },
    createdAt: "2026-06-15T00:00:00.000Z",
  });

  const added = appendRecords(SEED_DIR, [profile, rootPost, comment1, comment2, userPost1, userPost2]);
  check("seed: all 6 fixture entities are new identities", added === 6);
  check("seed: every loaded record validates as an Entity", loadRecords(SEED_DIR).every(isEntity));

  // ── getRecord: single-entity lookup (get_profile/get_post's shape) ─────────
  const gotProfileByHandle = getRecord(SEED_DIR, { source: "example", kind: "profile", id: "ada" });
  check("getRecord: profile lookup by handle succeeds", !!gotProfileByHandle && gotProfileByHandle.handle === "ada");

  const gotPostById = getRecord(SEED_DIR, { source: "example", kind: "post", id: "9001" });
  check("getRecord: post lookup by native id succeeds", !!gotPostById && gotPostById.provenance.id === "9001");

  const gotPostByUrl = getRecord(SEED_DIR, { source: "example", kind: "post", id: "https://example.test/ada/status/9001" });
  check("getRecord: post lookup by canonicalUrl (idOrUrl shape) succeeds", !!gotPostByUrl && gotPostByUrl.provenance.id === "9001");

  const missing = getRecord(SEED_DIR, { source: "example", kind: "post", id: "does-not-exist" });
  check("getRecord: a miss returns undefined rather than throwing", missing === undefined);

  // ── queryRecords: comments (get_comments' shape) ────────────────────────────
  const commentsPage = queryRecords(SEED_DIR, { op: "comments", source: "example", postIdOrUrl: "9001" });
  check("queryRecords(comments): returns a valid Page<Comment>", Array.isArray(commentsPage.items) && typeof commentsPage.truncated === "boolean");
  check("queryRecords(comments): both seeded comments are returned", commentsPage.items.length === 2 && commentsPage.items.every((c) => c.kind === "comment"));
  check("queryRecords(comments): not truncated (fits in default limit)", commentsPage.truncated === false && commentsPage.nextCursor === undefined);

  const commentsPageLimited = queryRecords(SEED_DIR, { op: "comments", source: "example", postIdOrUrl: "9001", limit: 1 });
  check("queryRecords(comments): limit is honored and truncated is set", commentsPageLimited.items.length === 1 && commentsPageLimited.truncated === true && typeof commentsPageLimited.nextCursor === "string");
  const nextPage = queryRecords(SEED_DIR, { op: "comments", source: "example", postIdOrUrl: "9001", limit: 1, cursor: commentsPageLimited.nextCursor });
  check("queryRecords(comments): the cursor advances to the next item, not the same one", nextPage.items[0].provenance.id !== commentsPageLimited.items[0].provenance.id);
  check("queryRecords(comments): the second page is the last (truncated:false)", nextPage.truncated === false);

  // ── queryRecords: search (search's shape) ───────────────────────────────────
  const searchPosts = queryRecords(SEED_DIR, { op: "search", source: "example", query: "lambda" });
  check("queryRecords(search, posts): text search finds the matching post", searchPosts.items.length === 1 && searchPosts.items[0].provenance.id === "9101");

  const searchUsers = queryRecords(SEED_DIR, { op: "search", source: "example", query: "ada", type: "users" });
  check("queryRecords(search, users): handle/displayName search finds the profile", searchUsers.items.length === 1 && searchUsers.items[0].kind === "profile");

  const searchNoMatch = queryRecords(SEED_DIR, { op: "search", source: "example", query: "no-such-term-anywhere" });
  check("queryRecords(search): a no-match query returns a valid EMPTY Page, not an error", searchNoMatch.items.length === 0 && searchNoMatch.truncated === false);

  // ── queryRecords: timeline (get_timeline's shape) ───────────────────────────
  const timeline = queryRecords(SEED_DIR, { op: "timeline", source: "example", kind: "user_posts", handle: "ada" });
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

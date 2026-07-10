// LS-29 (generalize-records) — THE GENERALITY PROOF: this package accepts an ARBITRARY, non-social
// `source` namespace (not just "x"), merges/round-trips it under the same invariants as any other
// record, and coexists in ONE store with a social-shaped record — proving `lucarne-records` is
// genuinely a domain-agnostic capture-corpus store, not a social schema wearing a general-sounding
// name. Domain fields a caller invents (e.g. a GitHub record's `labels: [...]`) ride through a merge
// UNMOLESTED — this package never inspects them by name (schema.ts's header).
//
// Run with `node test/open-source.mjs` (after `npm run build`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendRecords, loadRecords, recordKey } from "../dist/store.js";
import { getRecord, queryRecords } from "../dist/query.js";
import { isEntity, assertEntity } from "../dist/validate.js";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-records-open-source-test-"));

// ── an arbitrary "github" source, with its OWN domain fields this package has never heard of ──
const githubIssue = {
  kind: "issue",
  provenance: {
    source: "github",
    id: "volter-ai/lucarne#42",
    canonicalUrl: "https://github.com/volter-ai/lucarne/issues/42",
    fetchedAt: "2026-07-08T12:00:00.000Z",
    via: "internal-api",
  },
  text: "the widget flickers on first paint",
  metrics: { comments: 3, upvotes: 5 },
  labels: ["bug", "widget"],
  repo: "volter-ai/lucarne",
  author: { login: "octocat", url: "https://github.com/octocat" },
};

check("github issue: validates as a general record (arbitrary source + kind)", isEntity(githubIssue));
check("github issue: assertEntity accepts it (returns it unchanged)", assertEntity(githubIssue).labels[0] === "bug");

// ── an arbitrary "arxiv" source, DIFFERENT kind, DIFFERENT domain fields entirely ──
const arxivAbstract = {
  kind: "abstract",
  provenance: {
    source: "arxiv",
    id: "2601.00001",
    canonicalUrl: "https://arxiv.org/abs/2601.00001",
    fetchedAt: "2026-07-08T12:05:00.000Z",
    via: "dom",
  },
  text: "We present a general capture-corpus schema that separates domain-agnostic provenance from domain-specific payload.",
  authors: ["A. Researcher", "B. Researcher"],
  category: "cs.SE",
};

check("arxiv abstract: validates as a general record (a totally different domain shape)", isEntity(arxivAbstract));

// ── an ordinary social ("x") record, to prove coexistence in ONE store, not two ──
const xPost = {
  kind: "post",
  provenance: {
    source: "x",
    id: "1234567890123456789",
    canonicalUrl: "https://x.com/paulg/status/1234567890123456789",
    fetchedAt: "2026-07-08T12:10:00.000Z",
    via: "screen",
  },
  author: { handle: "paulg", profileUrl: "https://x.com/paulg" },
  text: "a genuine social post",
  metrics: { score: 10 },
};

// ── APPEND all three into ONE records.jsonl — no domain-specific store, no per-domain file ──
const added = appendRecords(DIR, [githubIssue, arxivAbstract, xPost]);
check("appendRecords: all 3 cross-domain records are new identities, in ONE store call", added === 3);

const storeFile = path.join(DIR, "records.jsonl");
check("ONE unified records.jsonl exists (no per-domain store file)", fs.existsSync(storeFile));
const lineCount = fs.readFileSync(storeFile, "utf8").split("\n").filter((l) => l.trim()).length;
check("records.jsonl carries exactly 3 lines — one per record, all domains in the SAME file", lineCount === 3, lineCount);

const all = loadRecords(DIR);
check("loadRecords: all 3 cross-domain records load back", all.length === 3);
check("loadRecords: every loaded record still validates as a general Entity", all.every(isEntity));

// ── getRecord/queryRecords work identically across an arbitrary source ──
const gotIssue = getRecord(DIR, { source: "github", kind: "issue", id: "volter-ai/lucarne#42" });
check("getRecord: resolves the github issue by its native id (open source works exactly like 'x' does)", !!gotIssue && gotIssue.labels?.[0] === "bug");

const gotByUrl = getRecord(DIR, { source: "arxiv", kind: "abstract", id: "https://arxiv.org/abs/2601.00001" });
check("getRecord: resolves the arxiv abstract by canonicalUrl", !!gotByUrl && gotByUrl.provenance.id === "2601.00001");

// search's default match is now a fully OPEN, kind-parameterized op (LS-37 — no more implicit
// kind:"post" requirement); this particular proof still uses a kind:"post" record on a non-x source,
// same convention as the pre-LS-29 social query surface, to show the convention itself still works.
const githubDiscussionPost = {
  kind: "post",
  provenance: {
    source: "github",
    id: "volter-ai/lucarne#discuss-1",
    canonicalUrl: "https://github.com/volter-ai/lucarne/discussions/1",
    fetchedAt: "2026-07-08T12:02:00.000Z",
    via: "dom",
  },
  text: "should we support arbitrary sources in the corpus store?",
  metrics: {},
};
appendRecords(DIR, [githubDiscussionPost]);
const searchPage = queryRecords(DIR, { op: "search", source: "github", query: "arbitrary sources" });
check("queryRecords(search): finds a github (non-x) post's text — search is not x-specific", searchPage.items.length === 1 && searchPage.items[0].provenance.source === "github");

// ── LS-37 (read-kinds generalize) — THE CONCRETE REFUTATION-CLOSER: the generality panel's finding
// was that the read/query side of this package silently required/assumed the social kind names
// ("post"/"comment"/"profile") even though `kind` is open everywhere else — a schema-blessed
// non-social record (like `githubIssue` above, already proven APPENDABLE) got ZERO results back from
// `timeline`/`search`/`comments`. This block proves a foreign kind ("issue", and a second, different
// one, "pr") is now fully QUERYABLE through the exact same general ops a social "post" uses — not
// just storable. (Non-vacuous, confirmed by hand against the pre-fix `query.ts`: every `check` below
// FAILED — empty pages — before this change; see the LS-37 commit/PR description.)
const githubIssue2 = {
  kind: "issue",
  provenance: {
    source: "github",
    id: "volter-ai/lucarne#99",
    canonicalUrl: "https://github.com/volter-ai/lucarne/issues/99",
    fetchedAt: "2026-07-08T12:20:00.000Z",
    via: "internal-api",
  },
  text: "flaky test in the query suite",
  metrics: { comments: 1 },
  labels: ["bug", "flaky"],
};
const githubPr = {
  kind: "pr",
  provenance: {
    source: "github",
    id: "volter-ai/lucarne#100",
    canonicalUrl: "https://github.com/volter-ai/lucarne/pull/100",
    fetchedAt: "2026-07-08T12:21:00.000Z",
    via: "internal-api",
  },
  text: "fix the flaky query test",
  metrics: {},
};
// the issue's own reply unit — deliberately named "issue-comment", NOT the social "comment" kind, to
// prove the relationship (comments) op's child match is genuinely kind-agnostic, not just accepting
// one alternate hardcoded literal instead of another.
const githubIssueComment = {
  kind: "issue-comment",
  provenance: {
    source: "github",
    id: "ic-1",
    canonicalUrl: "https://github.com/volter-ai/lucarne/issues/99#issuecomment-1",
    fetchedAt: "2026-07-08T12:22:00.000Z",
    via: "internal-api",
  },
  author: { login: "octocat" },
  text: "reproduced on CI, looking into it",
  parentUrl: "https://github.com/volter-ai/lucarne/issues/99",
  threadRootUrl: "https://github.com/volter-ai/lucarne/issues/99",
  depth: 0,
  createdAt: "2026-07-08T12:23:00.000Z",
};
appendRecords(DIR, [githubIssue2, githubPr, githubIssueComment]);

// timeline: kind:"issue" returns BOTH captured issues (this one + `githubIssue` from above) — the
// pre-fix hardcoded `e.kind !== "post"` drop would have silently returned an EMPTY page instead.
const issueTimeline = queryRecords(DIR, { op: "timeline", source: "github", kind: "issue" });
const issueIds = issueTimeline.items.map((e) => e.provenance.id).sort();
check(
  "LS-37 queryRecords(timeline, kind:'issue'): a non-social kind IS returned in full (proves `timeline` is kind-parameterized, not kind:'post'-hardcoded)",
  issueTimeline.items.length === 2 && JSON.stringify(issueIds) === JSON.stringify(["volter-ai/lucarne#42", "volter-ai/lucarne#99"]),
  JSON.stringify(issueIds),
);

// timeline: kind:"pr" returns the pr — a SECOND, different non-social kind, through the identical op,
// with no per-kind special-casing anywhere in `query.ts`.
const prTimeline = queryRecords(DIR, { op: "timeline", source: "github", kind: "pr" });
check(
  "LS-37 queryRecords(timeline, kind:'pr'): a second, different non-social kind is ALSO returned through the identical op",
  prTimeline.items.length === 1 && prTimeline.items[0].provenance.id === "volter-ai/lucarne#100",
);

// search: kind:"issue" narrows the free-text match to the matching issue only.
const issueSearch = queryRecords(DIR, { op: "search", source: "github", query: "flaky", kind: "issue" });
check(
  "LS-37 queryRecords(search, kind:'issue'): a kind-narrowed text search over a non-social kind finds it",
  issueSearch.items.length === 1 && issueSearch.items[0].kind === "issue" && issueSearch.items[0].provenance.id === "volter-ai/lucarne#99",
);

// comments/relationship: the issue's OWN differently-named child kind ("issue-comment") is returned by
// the exact same relationship op a social thread uses — the root lookup and the child match are BOTH
// kind-agnostic (no `kind:"post"` root requirement, no `kind==="comment"` child requirement).
const issueComments = queryRecords(DIR, { op: "comments", source: "github", postIdOrUrl: "volter-ai/lucarne#99" });
check(
  "LS-37 queryRecords(comments): a non-social root ('issue') resolves and its non-social child kind ('issue-comment') is returned — the relationship query never required kind:'post'/'comment'",
  issueComments.items.length === 1 && issueComments.items[0].kind === "issue-comment" && issueComments.items[0].text === githubIssueComment.text,
);

// ── MERGE: domain fields survive a merge unmolested (shallow top-level donor-wins spread) ──
{
  const richerIssue = {
    ...githubIssue,
    text: "the widget flickers on first paint — repro steps attached, affects Safari only",
    labels: ["bug", "widget", "safari"],
    assignee: "octocat",
  };
  appendRecords(DIR, [richerIssue]);
  const merged = loadRecords(DIR).find((e) => e.provenance.source === "github" && e.provenance.id === "volter-ai/lucarne#42");
  check("merge: richest-text-wins picks the longer github issue body", merged.text === richerIssue.text);
  check("merge: the github-specific `labels` field survived the merge (donor-wins top-level spread)", JSON.stringify(merged.labels) === JSON.stringify(["bug", "widget", "safari"]));
  check("merge: a NEW domain field introduced by the richer capture (`assignee`) survives the merge too", merged.assignee === "octocat");
  check("merge: recordKey is source-scoped — github's own key never collides with x's", recordKey(merged) === "github:issue:volter-ai/lucarne#42");
}

// ── round-trip through JSON (simulating the on-disk write/read) — domain fields intact ──
{
  const rt = JSON.parse(JSON.stringify(arxivAbstract));
  check("round-trip: an arbitrary domain record's own fields (authors/category) survive a JSON round-trip intact", JSON.stringify(rt.authors) === JSON.stringify(arxivAbstract.authors) && rt.category === arxivAbstract.category);
}

// ── the x record is UNCHANGED by any of the above — real coexistence, not accidental overwrite ──
{
  const stillX = loadRecords(DIR).find((e) => e.provenance.source === "x");
  check("coexistence: the x record is present, unmolested, alongside the github/arxiv records", !!stillX && stillX.text === xPost.text);
  const bySource = new Set(loadRecords(DIR).map((e) => e.provenance.source));
  check("coexistence: the ONE store holds all three distinct sources at once", bySource.has("github") && bySource.has("arxiv") && bySource.has("x"));
}

fs.rmSync(DIR, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

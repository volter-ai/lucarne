/**
 * The five reshaped read tools — pure STORE READS over `lucarne-records`, no
 * network, no bridge, no extension, no fetch. Reshaped from
 * `claude-socials/packages/mcp-server/src/tools.ts`'s five data ops
 * (`get_profile`/`get_post`/`get_comments`/`search`/`get_timeline`,
 * `tools.ts:36-205`) onto LS-03's `getRecord`/`queryRecords`.
 *
 * Where `tools.ts` forwarded to `bridge.request(...)` (an extension fetch),
 * every function here calls `getRecord`/`queryRecords` — a synchronous disk
 * read — and returns immediately. A MISS (no matching captured record) is
 * NOT an error and never triggers any kind of fetch: it is a structured
 * `not_captured` result whose `hint` tells the agent to browse to the thing
 * in-session so recall's passive sensors capture it, then query again.
 *
 * The three bridge-diagnostic tools (`x_debug`/`reload_extension`/
 * `bridge_status`, `tools.ts:207-246`) have no analog here — there is no
 * bridge to diagnose — and are intentionally NOT ported (§1.3a).
 *
 * LS-29 (generalize-records): `Source` is now an open `string` — `lucarne-records` no longer closes
 * the source set, so this bin can point at ANY sensor's namespace, not just a closed list of named
 * sites. `Comment`/`Profile` are gone (they were the closed social schema, moved downstream) — the
 * `depth` filter in `getComments` below now reads `depth` DEFENSIVELY off the general `Entity` shape
 * (`CorpusRecord`'s index signature types it `unknown`) instead of casting to a closed `Comment` type.
 *
 * LS-37 (read-kinds generalize): `lucarne-records`' query layer used to silently require/assume the
 * social kind names (`"post"`/`"comment"`/`"profile"`) on every list/lookup op, even though `kind` is
 * an open string everywhere else — a schema-blessed non-social record could be appended but never
 * queried back. That hardcoding lived in the PRIMITIVE (`query.ts`), not here, and is gone now (see
 * that file's own LS-37 note). This file's job is unchanged: keep the five tool NAMES stable (the
 * shipped skills call them) while sourcing what used to be implicit social literals from OPEN,
 * OPTIONAL params DEFAULTED to the social convention (`getProfile`'s/`getPost`'s new `kind?`,
 * `search`'s `type` replaced by an open `kind?`) — an overridable boundary default, never a
 * hardcoded block. `get_comments` needs no such param: `queryRecords`'s `comments` op is now a pure
 * kind-agnostic relationship query underneath it.
 */
import { getRecord, queryRecords } from "lucarne-records";
import type { Entity, Page } from "lucarne-records";

type Source = string;

export interface NotCaptured {
  status: "not_captured";
  message: string;
  /** Tells the agent what to do next — browse, never fetch. */
  hint: string;
  /** The query that missed, echoed back for the agent's own bookkeeping. */
  query: Record<string, unknown>;
}

export interface Captured<T> {
  status: "ok";
  data: T;
}

export type ToolResult<T> = Captured<T> | NotCaptured;

function isEmptyPage(page: Page<Entity>): boolean {
  return page.items.length === 0;
}

function notCaptured(what: string, browseHint: string, query: Record<string, unknown>): NotCaptured {
  return {
    status: "not_captured",
    message: `Not captured yet: ${what}.`,
    hint:
      `This corpus is read-only and never fetches. Browse to it in-session — recall captures ` +
      `passively while a human/agent genuinely browses — then query again. ${browseHint}`,
    query,
  };
}

// ── get_profile ───────────────────────────────────────────────────────────

export interface GetProfileArgs {
  source: Source;
  handle: string;
  /** LS-37: OPEN, optional, DEFAULTED to `"profile"` — the social convention this tool is named
   *  after. The literal now lives here, as an overridable tool-boundary default, not as a hardcoded
   *  requirement inside `lucarne-records`' query layer: a caller with a different identity-shaped
   *  kind (rare — most non-social identity records still just call themselves "profile") can pass its
   *  own. */
  kind?: string;
}

export function getProfile(dir: string, args: GetProfileArgs): ToolResult<Entity> {
  const kind = args.kind ?? "profile";
  const rec = getRecord(dir, { source: args.source, kind, id: args.handle });
  if (!rec || rec.kind !== kind) {
    return notCaptured(
      `a ${args.source} ${kind} for handle "${args.handle}"`,
      `Visit the profile page for "${args.handle}" on ${args.source} in a driven session.`,
      { op: "get_profile", ...args },
    );
  }
  return { status: "ok", data: rec };
}

// ── get_post ──────────────────────────────────────────────────────────────

export interface GetPostArgs {
  source: Source;
  idOrUrl: string;
  /** LS-37: OPEN, optional, DEFAULTED to `"post"` — same posture as `GetProfileArgs.kind` above: an
   *  overridable default at this tool's boundary, not a hardcoded requirement in the query layer. A
   *  non-social consumer reaches a different top-level-item kind (e.g. a github "issue") via this
   *  same tool by passing `kind:"issue"`, or via `search`/`get_timeline`/`get_record` directly. */
  kind?: string;
}

export function getPost(dir: string, args: GetPostArgs): ToolResult<Entity> {
  const kind = args.kind ?? "post";
  const rec = getRecord(dir, { source: args.source, kind, id: args.idOrUrl });
  if (!rec) {
    return notCaptured(
      `a ${args.source} ${kind} "${args.idOrUrl}"`,
      `Visit that captured post/item on ${args.source} in a driven session.`,
      { op: "get_post", ...args },
    );
  }
  return { status: "ok", data: rec };
}

// ── get_comments ──────────────────────────────────────────────────────────

export interface GetCommentsArgs {
  source: Source;
  postIdOrUrl: string;
  depth?: number;
  limit?: number;
  cursor?: string;
}

export function getComments(dir: string, args: GetCommentsArgs): ToolResult<Page<Entity>> {
  const page = queryRecords(dir, {
    op: "comments",
    source: args.source,
    postIdOrUrl: args.postIdOrUrl,
    limit: args.limit,
    cursor: args.cursor,
  });
  // `depth` filters the returned page down further (a post-filter, honest
  // about the fact this is a store read, not a re-query): 0 = top-level replies only.
  // Read defensively (LS-29): `depth` is a conventional field, not a typed one, on the general Entity.
  const items =
    args.depth === undefined
      ? page.items
      : page.items.filter((e) => e.kind !== "comment" || typeof e.depth !== "number" || e.depth <= args.depth!);
  if (items.length === 0) {
    return notCaptured(
      `comments on ${args.source} post "${args.postIdOrUrl}"`,
      `Visit that post's thread on ${args.source} in a driven session so its replies are captured.`,
      { op: "get_comments", ...args },
    );
  }
  return { status: "ok", data: { ...page, items } };
}

// ── search ────────────────────────────────────────────────────────────────

export interface SearchArgs {
  source: Source;
  query: string;
  /** LS-37: OPEN, optional — replaces the old closed `type?: "posts"|"users"`. Omit to search every
   *  captured kind for this source; pass a literal kind (`"post"`, `"profile"`, or any source-defined
   *  kind like `"issue"`) to narrow to it. `"post"`/`"profile"` are recognized social examples, not a
   *  closed set the query layer enforces. */
  kind?: string;
  container?: string;
  limit?: number;
  /** Open string — 'new'/'top'/'best'/'relevance' are recognized conventions; any other source-defined
   *  sort name is accepted and falls back to capture order in `lucarne-records`' query layer. */
  sort?: string;
  cursor?: string;
}

export function search(dir: string, args: SearchArgs): ToolResult<Page<Entity>> {
  const page = queryRecords(dir, {
    op: "search",
    source: args.source,
    query: args.query,
    kind: args.kind,
    container: args.container,
    limit: args.limit,
    sort: args.sort,
    cursor: args.cursor,
  });
  if (isEmptyPage(page)) {
    return notCaptured(
      `a ${args.source} search for "${args.query}"`,
      `Browse ${args.source} (search or the relevant pages) in a driven session so matching ` +
        `${args.kind ? `${args.kind} records` : "records"} are captured, then search again.`,
      { op: "search", ...args },
    );
  }
  return { status: "ok", data: page };
}

// ── get_timeline ──────────────────────────────────────────────────────────

export interface GetTimelineArgs {
  source: Source;
  /** Open string — 'user_posts' is a recognized convention (needs handle); any other source-defined
   *  list name is accepted and falls back to capture order in `lucarne-records`' query layer. */
  kind: string;
  handle?: string;
  container?: string;
  limit?: number;
  /** Open string — see `SearchArgs.sort`. */
  sort?: string;
  cursor?: string;
}

export function getTimeline(dir: string, args: GetTimelineArgs): ToolResult<Page<Entity>> {
  const page = queryRecords(dir, {
    op: "timeline",
    source: args.source,
    kind: args.kind,
    handle: args.handle,
    container: args.container,
    limit: args.limit,
    sort: args.sort,
    cursor: args.cursor,
  });
  if (isEmptyPage(page)) {
    const where = args.handle ? `${args.handle}'s ${args.kind}` : `${args.source}'s ${args.kind} list`;
    return notCaptured(
      `a ${args.source} timeline (${where})`,
      `Browse ${where} on ${args.source} in a driven session, then request the timeline again.`,
      { op: "get_timeline", ...args },
    );
  }
  return { status: "ok", data: page };
}

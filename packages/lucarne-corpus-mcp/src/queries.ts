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
}

export function getProfile(dir: string, args: GetProfileArgs): ToolResult<Entity> {
  const rec = getRecord(dir, { source: args.source, kind: "profile", id: args.handle });
  if (!rec || rec.kind !== "profile") {
    return notCaptured(
      `a ${args.source} profile for handle "${args.handle}"`,
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
}

export function getPost(dir: string, args: GetPostArgs): ToolResult<Entity> {
  const rec = getRecord(dir, { source: args.source, kind: "post", id: args.idOrUrl });
  if (!rec) {
    return notCaptured(
      `a ${args.source} post "${args.idOrUrl}"`,
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
  type?: "posts" | "users";
  container?: string;
  limit?: number;
  sort?: "top" | "new" | "best" | "controversial" | "relevance";
  cursor?: string;
}

export function search(dir: string, args: SearchArgs): ToolResult<Page<Entity>> {
  const page = queryRecords(dir, {
    op: "search",
    source: args.source,
    query: args.query,
    type: args.type,
    container: args.container,
    limit: args.limit,
    sort: args.sort,
    cursor: args.cursor,
  });
  if (isEmptyPage(page)) {
    return notCaptured(
      `a ${args.source} search for "${args.query}"`,
      `Browse ${args.source} (search or the relevant pages) in a driven session so matching ` +
        `${args.type === "users" ? "profiles" : "posts"} are captured, then search again.`,
      { op: "search", ...args },
    );
  }
  return { status: "ok", data: page };
}

// ── get_timeline ──────────────────────────────────────────────────────────

export interface GetTimelineArgs {
  source: Source;
  kind: "user_posts" | "hot" | "new" | "top" | "best" | "ask" | "show";
  handle?: string;
  container?: string;
  limit?: number;
  sort?: "top" | "new" | "best" | "controversial" | "relevance";
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
    const where = args.handle ? `@${args.handle}'s ${args.kind}` : `${args.source}'s ${args.kind} list`;
    return notCaptured(
      `a ${args.source} timeline (${where})`,
      `Browse ${where} on ${args.source} in a driven session, then request the timeline again.`,
      { op: "get_timeline", ...args },
    );
  }
  return { status: "ok", data: page };
}

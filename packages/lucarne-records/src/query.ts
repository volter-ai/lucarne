/**
 * The read/query API over a `lucarne-records` store — STORE READS ONLY.
 *
 * Reshaped from the SHAPE of `claude-socials/packages/mcp-server/src/tools.ts`'s
 * five ops (LS-03): `get_profile`/`get_post` are single-entity lookups → here,
 * `getRecord`; `get_comments`/`search`/`get_timeline` are paginated list ops →
 * here, `queryRecords` returning `Page<T>`. Unlike `tools.ts`, NONE of this
 * fetches anything — every op is a pure read over what `appendRecords` already
 * persisted. A miss is just an empty/absent result; deciding what to do about a
 * miss (e.g. "browse to it") is a caller concern (LS-06's job, not this one's).
 */

import { decodeCursor, encodeCursor } from "./cursor.js";
import { loadRecords } from "./store.js";
import type { Comment, Entity, EntityKind, Page, Post, Profile, Source } from "./schema.js";

/** Identifies a single entity to fetch with `getRecord`. */
export interface RecordRef {
  source: Source;
  kind: EntityKind;
  /**
   * Matched against, in order: `provenance.id` (native id), `provenance.canonicalUrl`
   * (so a caller can pass a URL exactly as `tools.ts`'s `idOrUrl` did), and for
   * `kind:'profile'` only, `handle` (so `get_profile`'s handle-keyed lookup has a
   * direct match too).
   */
  id: string;
}

/**
 * A single-entity lookup — the shape of `get_profile`/`get_post`. Store read
 * only: returns `undefined` on a miss, never fetches.
 */
export function getRecord(dir: string, ref: RecordRef): Entity | undefined {
  const all = loadRecords(dir);
  return all.find((e) => {
    if (e.kind !== ref.kind || e.provenance.source !== ref.source) return false;
    if (e.provenance.id === ref.id) return true;
    if (e.provenance.canonicalUrl === ref.id) return true;
    if (e.kind === "profile" && e.handle === ref.id) return true;
    return false;
  });
}

type SortKind = "top" | "new" | "best" | "controversial" | "relevance";

export interface CommentsQuery {
  op: "comments";
  source: Source;
  /** A post's native id or canonical URL — resolved via `getRecord` when possible. */
  postIdOrUrl: string;
  limit?: number;
  cursor?: string;
}

export interface SearchQuery {
  op: "search";
  source: Source;
  query: string;
  type?: "posts" | "users";
  /** Reddit-shaped: a subreddit name, matched against `Post.container.name`. */
  container?: string;
  limit?: number;
  sort?: SortKind;
  cursor?: string;
}

export interface TimelineQuery {
  op: "timeline";
  source: Source;
  kind: "user_posts" | "hot" | "new" | "top" | "best" | "ask" | "show";
  handle?: string;
  container?: string;
  limit?: number;
  sort?: SortKind;
  cursor?: string;
}

export type RecordQuery = CommentsQuery | SearchQuery | TimelineQuery;

interface OffsetCursor {
  offset: number;
}

function decodeOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const d = decodeCursor<OffsetCursor>(cursor);
    return typeof d.offset === "number" && d.offset >= 0 ? d.offset : 0;
  } catch {
    return 0;
  }
}

function paginate<T>(items: T[], offset: number, limit: number): Page<T> {
  const page = items.slice(offset, offset + limit);
  const truncated = offset + page.length < items.length;
  return {
    items: page,
    ...(truncated ? { nextCursor: encodeCursor({ offset: offset + page.length } satisfies OffsetCursor) } : {}),
    truncated,
  };
}

function scoreOf(e: Post | Profile): number {
  if (e.kind === "post") return e.metrics.score ?? 0;
  return e.metrics.karma ?? e.metrics.followers ?? 0;
}

function createdAtOf(e: Entity): number {
  const t = e.kind === "profile" ? e.createdAt : e.createdAt;
  return t ? Date.parse(t) || 0 : 0;
}

function applySort<T extends Post | Profile>(items: T[], sort: SortKind | undefined): T[] {
  if (sort === "new") return [...items].sort((a, b) => createdAtOf(b) - createdAtOf(a));
  if (sort === "top" || sort === "best") return [...items].sort((a, b) => scoreOf(b) - scoreOf(a));
  // 'controversial'/'relevance'/undefined: no ranking signal in a pure store
  // read — preserve insertion (capture) order, same honesty as `tools.ts`'s
  // "the adapter falls back sensibly" note for sorts a site doesn't support.
  return items;
}

/**
 * The list-op query surface — the shape of `get_comments`/`search`/`get_timeline`,
 * as pure store reads. Always returns a valid `Page<T>`, never raises an error on
 * a miss (an unresolved `postIdOrUrl`, an empty result set) — it just returns an
 * empty page with `truncated:false`.
 */
export function queryRecords(dir: string, q: RecordQuery): Page<Entity> {
  const all = loadRecords(dir);
  const limit = q.limit && q.limit > 0 ? q.limit : 25;
  const offset = decodeOffset(q.cursor);

  if (q.op === "comments") {
    const post = getRecord(dir, { source: q.source, kind: "post", id: q.postIdOrUrl });
    const rootUrl = post?.provenance.canonicalUrl ?? q.postIdOrUrl;
    const comments = all.filter(
      (e): e is Comment => e.kind === "comment" && e.provenance.source === q.source && e.threadRootUrl === rootUrl,
    );
    comments.sort((a, b) => (a.depth - b.depth) || (createdAtOf(a) - createdAtOf(b)));
    return paginate(comments, offset, limit);
  }

  if (q.op === "search") {
    const type = q.type ?? "posts";
    const needle = q.query.toLowerCase();
    if (type === "users") {
      const profiles = all.filter(
        (e): e is Profile =>
          e.kind === "profile" &&
          e.provenance.source === q.source &&
          (e.handle.toLowerCase().includes(needle) ||
            (e.displayName ?? "").toLowerCase().includes(needle) ||
            (e.bio ?? "").toLowerCase().includes(needle)),
      );
      return paginate(applySort(profiles, q.sort), offset, limit);
    }
    const posts = all.filter(
      (e): e is Post =>
        e.kind === "post" &&
        e.provenance.source === q.source &&
        (!q.container || e.container?.name === q.container) &&
        (e.text.toLowerCase().includes(needle) || (e.title ?? "").toLowerCase().includes(needle)),
    );
    return paginate(applySort(posts, q.sort), offset, limit);
  }

  // op === 'timeline'
  if (q.kind === "user_posts") {
    const posts = all.filter(
      (e): e is Post => e.kind === "post" && e.provenance.source === q.source && e.author.handle === q.handle,
    );
    posts.sort((a, b) => createdAtOf(b) - createdAtOf(a));
    return paginate(posts, offset, limit);
  }
  const listPosts = all.filter(
    (e): e is Post =>
      e.kind === "post" && e.provenance.source === q.source && (!q.container || e.container?.name === q.container),
  );
  const sortForList: SortKind | undefined = q.kind === "new" ? "new" : q.kind === "top" || q.kind === "best" ? "top" : undefined;
  return paginate(applySort(listPosts, sortForList), offset, limit);
}

/**
 * The read/query API over a `lucarne-records` store — STORE READS ONLY.
 *
 * Reshaped from the SHAPE of `claude-socials/packages/mcp-server/src/tools.ts`'s five ops (LS-03):
 * `get_profile`/`get_post` are single-entity lookups → here, `getRecord`; `get_comments`/`search`/
 * `get_timeline` are paginated list ops → here, `queryRecords` returning `Page<T>`. Unlike
 * `tools.ts`, NONE of this fetches anything — every op is a pure read over what `appendRecords`
 * already persisted. A miss is just an empty/absent result; deciding what to do about a miss (e.g.
 * "browse to it") is a caller concern (LS-06's job, not this one's).
 *
 * LS-29 (generalize-records): `source`/`kind` are now OPEN strings (this package no longer closes
 * either set — see `schema.ts`). The list ops themselves (`comments`/`search`/`timeline`) stay
 * THREAD/TIMELINE-SHAPED — they're inherently about threads/containers/timelines, a convention this
 * package still offers but no longer enforces structurally. Every domain field they filter/sort on
 * (`container`, `handle`, `author.handle`, `depth`, `threadRootUrl`, `title`, per-key metrics) is now
 * a CONVENTIONAL indexed field, not a typed one — `CorpusRecord`'s index signature types them
 * `unknown`, so every read below is defensive (a `typeof` narrow or a small helper), never a bare
 * cast. A caller whose domain doesn't use these conventions just gets `undefined` back from them,
 * never a crash.
 *
 * LS-33 (store-generalize): the `kind==="profile"` literals this package used to carry (an
 * identity-lookup shortcut in `findRecord`, and the `search`'s `type:"users"` filter) are gone.
 * `findRecord`'s handle-match is now available to ANY `kind`, not gated to `"profile"` — `handle` is
 * already a conventional indexed field elsewhere in this file (search/timeline both read it), so
 * restricting the shortcut to one kind name was residue, not a requirement. `search`'s `type:"users"`
 * branch now selects structurally — any record carrying a `handle` — instead of by kind name, and
 * also searches `text` (posts already did) so a `kind:"profile"` consumer that stores its body in
 * `text` rather than `bio` (LS-33's `store.ts` change) is searchable too. This package now carries
 * zero `kind==="profile"` literals.
 */

import { decodeCursor, encodeCursor } from "./cursor.js";
import { loadRecords } from "./store.js";
import type { Entity, Page } from "./schema.js";

/** Identifies a single record to fetch with `getRecord`. */
export interface RecordRef {
  source: string;
  kind: string;
  /**
   * Matched against, in order: `provenance.id` (native id), `provenance.canonicalUrl`
   * (so a caller can pass a URL exactly as `tools.ts`'s `idOrUrl` did), and `handle`
   * (so an identity-shaped lookup, e.g. `get_profile`'s handle-keyed one, has a direct
   * match too) — `handle` is a conventional indexed field, read defensively, and this
   * fallback applies to ANY `kind` that happens to carry one, not just `"profile"`
   * (LS-33: no kind-literal gate).
   */
  id: string;
}

function strOf(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function numOf(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

/** Find a single record within an ALREADY-loaded record array (no disk read). */
function findRecord(records: readonly Entity[], ref: RecordRef): Entity | undefined {
  return records.find((e) => {
    if (e.kind !== ref.kind || e.provenance.source !== ref.source) return false;
    if (e.provenance.id === ref.id) return true;
    if (e.provenance.canonicalUrl === ref.id) return true;
    // handle-keyed lookup (LS-33: kind-agnostic — `e.kind === ref.kind` is already
    // guaranteed above, so this just extends the match to any kind that carries a handle).
    if (strOf(e.handle) && strOf(e.handle) === ref.id) return true;
    return false;
  });
}

/**
 * A single-record lookup — the shape of `get_profile`/`get_post`. Store read
 * only: returns `undefined` on a miss, never fetches.
 */
export function getRecord(dir: string, ref: RecordRef): Entity | undefined {
  return findRecord(loadRecords(dir), ref);
}

type SortKind = "top" | "new" | "best" | "controversial" | "relevance";

export interface CommentsQuery {
  op: "comments";
  source: string;
  /** A post's native id or canonical URL — resolved via `getRecord` when possible. */
  postIdOrUrl: string;
  limit?: number;
  cursor?: string;
}

export interface SearchQuery {
  op: "search";
  source: string;
  query: string;
  type?: "posts" | "users";
  /** Conventional indexed field: a container/list name (e.g. a forum board, a repo), matched
   *  against a record's `container.name` when the domain sets one. */
  container?: string;
  limit?: number;
  sort?: SortKind;
  cursor?: string;
}

export interface TimelineQuery {
  op: "timeline";
  source: string;
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

/** Conventional ranking signal: a record's normalized `metrics.score` when present, else the single
 *  largest numeric value anywhere in `metrics` (whatever a domain's own primary ranking signal is
 *  named — followers, stars, upvotes, … — this package doesn't hardcode any domain's own metric
 *  vocabulary). Read defensively (metrics values are `number | null | undefined`).
 *  LS-29: this "largest numeric metric" fallback is a DELIBERATE generalization, not a drift — the
 *  store is source-agnostic now, so ranking must not name a domain-specific metric field; the fallback
 *  keeps `top`/`best` sorting meaningful for any source without knowing what its metric is called. */
function scoreOf(e: Entity): number {
  const m = e.metrics as Record<string, unknown> | undefined;
  if (!m) return 0;
  if (typeof m.score === "number") return m.score;
  let max = 0;
  for (const v of Object.values(m)) if (typeof v === "number" && v > max) max = v;
  return max;
}

function createdAtOf(e: Entity): number {
  const t = e.createdAt;
  return typeof t === "string" && t ? Date.parse(t) || 0 : 0;
}

function applySort<T extends Entity>(items: T[], sort: SortKind | undefined): T[] {
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
    // reuse the already-loaded `all` — don't re-read the file via getRecord.
    const post = findRecord(all, { source: q.source, kind: "post", id: q.postIdOrUrl });
    const rootUrl = post?.provenance.canonicalUrl ?? q.postIdOrUrl;
    const comments = all.filter((e) => e.kind === "comment" && e.provenance.source === q.source && e.threadRootUrl === rootUrl);
    comments.sort((a, b) => numOf(a.depth) - numOf(b.depth) || createdAtOf(a) - createdAtOf(b));
    return paginate(comments, offset, limit);
  }

  if (q.op === "search") {
    const type = q.type ?? "posts";
    const needle = q.query.toLowerCase();
    if (type === "users") {
      // LS-33: identity-shaped records are selected STRUCTURALLY (carries a `handle`) rather
      // than by the kind-literal `"profile"` — any domain's identity/user-shaped kind matches,
      // not just one named `"profile"`. `text` is included alongside the legacy `bio` alias so a
      // `kind:"profile"` consumer that stores its body in `text` (store.ts's LS-33 change) is
      // searchable here too, same as a post's text already is below.
      const profiles = all.filter(
        (e) =>
          e.provenance.source === q.source &&
          typeof e.handle === "string" &&
          e.handle.length > 0 &&
          (strOf(e.handle).toLowerCase().includes(needle) ||
            strOf(e.displayName).toLowerCase().includes(needle) ||
            strOf(e.bio).toLowerCase().includes(needle) ||
            strOf(e.text).toLowerCase().includes(needle)),
      );
      return paginate(applySort(profiles, q.sort), offset, limit);
    }
    const posts = all.filter((e) => {
      if (e.kind !== "post" || e.provenance.source !== q.source) return false;
      if (q.container) {
        const container = e.container as { name?: unknown } | undefined;
        if (strOf(container?.name) !== q.container) return false;
      }
      return (e.text ?? "").toLowerCase().includes(needle) || strOf(e.title).toLowerCase().includes(needle);
    });
    return paginate(applySort(posts, q.sort), offset, limit);
  }

  // op === 'timeline'
  if (q.kind === "user_posts") {
    const posts = all.filter((e) => {
      if (e.kind !== "post" || e.provenance.source !== q.source) return false;
      const author = e.author as { handle?: unknown } | undefined;
      return strOf(author?.handle) === q.handle;
    });
    posts.sort((a, b) => createdAtOf(b) - createdAtOf(a));
    return paginate(posts, offset, limit);
  }
  const listPosts = all.filter((e) => {
    if (e.kind !== "post" || e.provenance.source !== q.source) return false;
    if (!q.container) return true;
    const container = e.container as { name?: unknown } | undefined;
    return strOf(container?.name) === q.container;
  });
  const sortForList: SortKind | undefined = q.kind === "new" ? "new" : q.kind === "top" || q.kind === "best" ? "top" : undefined;
  return paginate(applySort(listPosts, sortForList), offset, limit);
}

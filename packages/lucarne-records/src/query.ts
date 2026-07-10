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
 *
 * LS-37 (read-kinds generalize): the ops below used to carry a SECOND, subtler residue on top of
 * LS-33's — every list op still silently REQUIRED (or silently ASSUMED) the entity kind be literally
 * `"post"`/`"comment"`, even though `kind` is an open string everywhere else in this package: `comments`
 * looked its root up as `kind:"post"` and required children to be `kind==="comment"`; `search`'s
 * default branch and `timeline`'s both dropped every record whose `kind !== "post"`. A schema-blessed
 * non-social record (a `kind:"issue"` github capture — `schema.ts`'s own header names this exact
 * example) could be APPENDED just fine but then got ZERO query results back — the read side silently
 * assumed a domain it never structurally required. Fixed: `comments` is now a pure RELATIONSHIP query
 * (find the root by id/url regardless of ITS kind, then return every record whose `threadRootUrl`
 * points at it, regardless of the CHILD's kind either); `search`/`timeline` both take an optional,
 * open `kind` PARAMETER instead of a hardcoded literal — provided, it filters to exactly that kind;
 * omitted, every kind is eligible. So this file now carries ZERO hardcoded social-kind FILTER
 * literals (see `test/package-clean-gate.mjs`'s gate for this, extended alongside this change) — the
 * ops are kind-PARAMETERIZED, not kind-agnostic-by-accident: a caller who wants "posts only" still
 * gets exactly that by passing `kind:"post"` explicitly (a downstream social consumer does this
 * everywhere it relies on the social convention), and a caller with its own kind vocabulary (e.g.
 * `kind:"issue"`) gets the identical treatment, not a silent drop.
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
 * Find a single record by id/source ONLY — no kind requirement at all (unlike `findRecord`/
 * `RecordRef`, which are keyed on a caller-known kind). LS-37: this is what `comments`' root lookup
 * uses — the ROOT of a thread can be any kind (a social "post", a github "issue", …), and this
 * package has no business requiring it be one specific literal to resolve it.
 */
function findRecordAnyKind(records: readonly Entity[], source: string, idOrUrl: string): Entity | undefined {
  return records.find((e) => e.provenance.source === source && (e.provenance.id === idOrUrl || e.provenance.canonicalUrl === idOrUrl));
}

/**
 * A single-record lookup — the shape of `get_profile`/`get_post`. Store read
 * only: returns `undefined` on a miss, never fetches.
 */
export function getRecord(dir: string, ref: RecordRef): Entity | undefined {
  return findRecord(loadRecords(dir), ref);
}

/** Open string — 'new'/'top'/'best' get special-cased ranking below (see `applySort`); ANY other
 *  string (a source's own sort name, or an unrecognized value) is accepted and preserves capture
 *  (insertion) order — never rejected structurally. */
type SortKind = string;

export interface CommentsQuery {
  op: "comments";
  source: string;
  /** A root record's native id or canonical URL — resolved kind-agnostically (LS-37: the root can be
   *  any kind, not just `"post"`). */
  postIdOrUrl: string;
  limit?: number;
  cursor?: string;
}

export interface SearchQuery {
  op: "search";
  source: string;
  query: string;
  /** Open string, OPTIONAL (LS-37 — replaces the old closed `type:"posts"|"users"`): when provided,
   *  restricts matches to records whose own `kind` equals it exactly (e.g. `"post"`, `"profile"`, or
   *  any source-defined kind like `"issue"`); when absent, every kind captured for `source` is
   *  eligible. Matching itself is structural, not kind-gated — it checks whichever of `text`/`title`/
   *  `handle`/`displayName`/`bio` a given record actually carries (conventional indexed fields, read
   *  defensively), so an identity-shaped record (matched via `handle`/`bio`) and a body-shaped one
   *  (matched via `text`/`title`) are both searchable through the SAME op, narrowed by `kind` when a
   *  caller wants only one. */
  kind?: string;
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
  /** Open string. Three convention names are reserved and kind-AGNOSTIC (LS-37: none of them
   *  requires — or assumes — any particular entity kind): `'user_posts'` (a single handle's own
   *  records, whatever kind they are), and `'new'`/`'top'`/`'best'` (a source/container-wide ranking
   *  across every captured kind). ANY other string is the general case (LS-37): it names the LITERAL
   *  entity `kind` to list — e.g. `'post'` lists `kind:"post"` records exactly as it always
   *  conventionally has, and `'issue'` lists `kind:"issue"` records the identical way. An unrecognized
   *  kind still returns a valid (possibly empty) page in capture order, never an error — it just means
   *  "no captured record has that kind," not "post, by default." */
  kind: string;
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

function containerMatches(e: Entity, container: string | undefined): boolean {
  if (!container) return true;
  const c = e.container as { name?: unknown } | undefined;
  return strOf(c?.name) === container;
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
    // LS-37: a pure RELATIONSHIP query, kind-agnostic end to end. The root is resolved by id/url
    // regardless of ITS kind (reuse the already-loaded `all` — don't re-read the file via getRecord),
    // then every record whose `threadRootUrl` points at the resolved root is returned, regardless of
    // the CHILD's kind either — a social "comment", a github issue's own comment kind, whatever a
    // domain calls its reply unit, all match the SAME way `threadRootUrl` already worked for "comment".
    const root = findRecordAnyKind(all, q.source, q.postIdOrUrl);
    const rootUrl = root?.provenance.canonicalUrl ?? q.postIdOrUrl;
    const replies = all.filter((e) => e.provenance.source === q.source && e.threadRootUrl === rootUrl);
    replies.sort((a, b) => numOf(a.depth) - numOf(b.depth) || createdAtOf(a) - createdAtOf(b));
    return paginate(replies, offset, limit);
  }

  if (q.op === "search") {
    const needle = q.query.toLowerCase();
    const matches = all.filter((e) => {
      if (e.provenance.source !== q.source) return false;
      if (q.kind !== undefined && e.kind !== q.kind) return false;
      if (!containerMatches(e, q.container)) return false;
      return (
        strOf(e.text).toLowerCase().includes(needle) ||
        strOf(e.title).toLowerCase().includes(needle) ||
        strOf(e.handle).toLowerCase().includes(needle) ||
        strOf(e.displayName).toLowerCase().includes(needle) ||
        strOf(e.bio).toLowerCase().includes(needle)
      );
    });
    return paginate(applySort(matches, q.sort), offset, limit);
  }

  // op === 'timeline'
  if (q.kind === "user_posts") {
    // LS-37: kind-agnostic relationship query — every record authored by this handle, whatever kind
    // it is (a social user's own posts, a github user's own issues/PRs, …), not just `kind:"post"`.
    const own = all.filter((e) => {
      if (e.provenance.source !== q.source) return false;
      const author = e.author as { handle?: unknown } | undefined;
      return strOf(author?.handle) === q.handle;
    });
    own.sort((a, b) => createdAtOf(b) - createdAtOf(a));
    return paginate(own, offset, limit);
  }
  if (q.kind === "new" || q.kind === "top" || q.kind === "best") {
    // LS-37: kind-agnostic ranking convention — ranks everything captured for this source/container,
    // regardless of entity kind (these three names are reserved SORT conventions, never a literal
    // entity kind any record actually carries).
    const ranked = all.filter((e) => e.provenance.source === q.source && containerMatches(e, q.container));
    const sortForList: SortKind = q.kind === "new" ? "new" : "top";
    return paginate(applySort(ranked, sortForList), offset, limit);
  }
  // General case (LS-37): `kind` names the LITERAL entity kind to list — no hardcoded `"post"`
  // assumption. `kind:"post"` behaves exactly as the old hardcoded default always did; any other
  // kind (`"issue"`, `"pr"`, `"abstract"`, …) is listed the identical way, capture order unless `sort`
  // requests a ranking.
  const listed = all.filter((e) => e.kind === q.kind && e.provenance.source === q.source && containerMatches(e, q.container));
  return paginate(applySort(listed, q.sort), offset, limit);
}

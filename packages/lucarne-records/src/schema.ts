/**
 * Normalized cross-site schema — the ONE provenance record language.
 *
 * Ported faithfully from `claude-socials/packages/shared/src/schema.ts:25-35,148-152`
 * (LS-03). Each supported site has its own native shape; every one of them maps
 * into these common types so a consumer (a recorder, a query surface, an agent)
 * sees a single, predictable shape regardless of source.
 *
 * Design rules:
 *  - Every entity carries `provenance` so a consumer can cite, link, and reason
 *    about freshness. Provenance is structural, never advisory — see `validate.ts`,
 *    which makes "provenance is required" a runtime law, not just a type.
 *  - We keep a `raw` escape hatch for site-specific fields we don't normalize, so
 *    nothing is lost — but normalized fields should be preferred.
 *
 * NOT ported: the extension<->bridge wire protocol (`shared/src/protocol.ts`) —
 * no bridge exists in this design (see the split spec's §1.3a/§1.4).
 *
 * LS-04 EXTENSION: `Provenance.via` gains `'screen'` (a passive ARIA capture,
 * the origin app's ONLY sensor today) alongside `'internal-api'` (which now denotes a
 * passively CDP-captured wire response, not a replayed fetch — see §1.3a) and
 * `'dom'`. It also adds an optional `capture` pointer — ported faithfully from
 * the origin app's `types.ts:17-24`'s `Capture` interface — so a screen-sensor record
 * can cite exactly which recorded ARIA snapshot/screenshot/moment it came from,
 * and an explicit `stub` signal on `Post` so a minted placeholder (the origin app's
 * `Unit.stub`, `types.ts:52`) is never mistaken for a real capture
 * by `store.ts`'s `mergeEntity` (see that file's stub-never-degrades doc). The
 * `Unit → record` mapping itself lives in `unit-to-record.ts`.
 */

export type Source = "x" | "reddit" | "hackernews";

/** Which kind of normalized entity a record represents. */
export type EntityKind = "profile" | "post" | "comment";

/**
 * Structural provenance attached to every entity. This is what makes the data
 * trustworthy for an agent: a stable identity, a clickable canonical URL, and a
 * fetch timestamp so freshness is explicit.
 */
export interface Provenance {
  source: Source;
  /** Stable, source-scoped id (e.g. HN item id, Reddit fullname, tweet id). */
  id: string;
  /** Canonical, user-shareable URL for this exact entity. */
  canonicalUrl: string;
  /** ISO-8601 time the data was fetched from the site. */
  fetchedAt: string;
  /**
   * How it was obtained:
   *  - `'internal-api'` — a passively CDP-captured wire response (the site's
   *    own JSON/GraphQL, observed via the `Network` domain on a session
   *    lucarne already owns — never a replayed/synthetic request; see
   *    the split spec's §1.3/§1.3a).
   *  - `'dom'` — scraped from the rendered page.
   *  - `'screen'` — a passive ARIA capture (the origin app's recall sensor,
   *    `unitToRecord`'s output — LS-04).
   */
  via: "internal-api" | "dom" | "screen";
}

/**
 * Provenance for a SCREEN-sensor (ARIA) capture: a pointer back to the exact
 * recorded moment a record's fields were observed from. Ported faithfully from
 * the origin app's `types.ts:17-24`'s `Capture` interface (LS-04) — kept as
 * nullable-optional exactly as the origin app wrote it, since the ARIA capture
 * plumbing this feeds (`units.ts`) already produces `null` (not
 * just `undefined`) for an unknown field.
 */
export interface Capture {
  /** The raw ARIA snapshot file this record was parsed out of. */
  from?: string | null;
  /** The in-session screenshot it was cropped/observed from. */
  screenshot?: string | null;
  /** ISO-8601 time of the capture. */
  ts?: string | null;
  /** Why recall fired (navigated · scrolled · new-content · …). */
  reason?: string | null;
  /** Who was driving the session when the capture happened. */
  by?: "agent" | "human" | null;
  /** The url the capture was taken on. */
  page?: string | null;
}

/** An author/account on any of the three sites. */
export interface Profile {
  kind: "profile";
  provenance: Provenance;
  /** Handle without the leading @ (x), u/ (reddit), or as-is username (HN). */
  handle: string;
  /** Display name if the site has one distinct from the handle. */
  displayName?: string;
  bio?: string;
  /** Profile picture / avatar URL, when the site exposes one (x, reddit). */
  avatarUrl?: string;
  /** Header/banner image URL, when available. */
  bannerUrl?: string;
  /** Whether the account is verified (x blue/legacy, reddit). */
  verified?: boolean;
  /** Self-declared website/link, when present. */
  website?: string;
  /** Self-declared location, when present. */
  location?: string;
  /** ISO-8601 account creation time, when the site exposes it. */
  createdAt?: string;
  /** Followers / subscribers / karma — see `metrics` for the per-site meaning. */
  metrics: ProfileMetrics;
  /** Site-specific fields not covered above. */
  raw?: Record<string, unknown>;
}

export interface ProfileMetrics {
  followers?: number;
  following?: number;
  /** Reddit comment+post karma, or HN karma. */
  karma?: number;
  /** Total authored posts, where cheaply available. */
  posts?: number;
}

/** A top-level item: a tweet, a subreddit post, or an HN story/Ask/Show. */
export interface Post {
  kind: "post";
  provenance: Provenance;
  author: AuthorRef;
  /** Post title where one exists (Reddit, HN). x posts usually have none. */
  title?: string;
  /** Main body text, normalized to plain text. May be empty for link posts. */
  text: string;
  /** Outbound link for link-posts (HN story url, Reddit link submission). */
  linkUrl?: string;
  createdAt?: string;
  metrics: EngagementMetrics;
  /** Container the post lives in (subreddit, HN front page, etc.). */
  container?: Container;
  /**
   * SCREEN-sensor provenance (LS-04): the ARIA/screenshot capture this
   * record's fields were observed from. Present on `via:'screen'` records
   * (`unitToRecord`'s output); absent for wire/DOM-sourced posts.
   */
  capture?: Capture;
  /**
   * EXPLICIT real/stub signal (LS-04), ported from the origin app's `Unit.stub`
   * (`types.ts:52`): `true` for a minted placeholder (id+handle
   * known from a comment's thread, content not yet observed), `false` for a
   * genuine capture — including a text-less one (e.g. an image-only post).
   * When present this is AUTHORITATIVE for `store.ts`'s `mergeEntity`
   * stub-never-degrades invariant: real-ness is sticky and is NEVER inferred
   * from "is `text` empty?" alone. `unitToRecord` always sets this explicitly
   * (never leaves it `undefined`) so a real text-less post can never be
   * mistaken for a stub by the structural fallback heuristic.
   */
  stub?: boolean;
  raw?: Record<string, unknown>;
}

/** A reply/comment under a post or another comment. */
export interface Comment {
  kind: "comment";
  provenance: Provenance;
  author: AuthorRef;
  text: string;
  createdAt?: string;
  metrics: EngagementMetrics;
  /** Canonical URL of the immediate parent (post or comment). */
  parentUrl: string;
  /** Canonical URL of the thread root post. */
  threadRootUrl: string;
  /** 0 = direct reply to the post. Increases with nesting. */
  depth: number;
  /** Child comment ids, present when fetched with depth > 0. */
  replyIds?: string[];
  /**
   * SCREEN-sensor provenance (LS-04): see `Post.capture`. Comments are never
   * stubs in the origin app's model (`Unit`'s `Comment.stub` is typed `never` —
   * `types.ts:60`), so there is no `stub` field here.
   */
  capture?: Capture;
  raw?: Record<string, unknown>;
}

export interface EngagementMetrics {
  /** Likes / upvotes / points. */
  score?: number;
  /** Reposts / retweets / crossposts. */
  reposts?: number;
  replies?: number;
  views?: number;
}

/** Lightweight reference to an author embedded in a post/comment. */
export interface AuthorRef {
  handle: string;
  displayName?: string;
  /** Avatar URL when cheaply available (e.g. x embeds it on each tweet author). */
  avatarUrl?: string;
  /** Canonical profile URL so a consumer can fetch the full Profile on demand. */
  profileUrl: string;
}

/** The container an item lives in: subreddit, HN list, or x timeline context. */
export interface Container {
  /** e.g. "r/programming", "Hacker News front page", "@user timeline". */
  name: string;
  url: string;
}

export type Entity = Profile | Post | Comment;

/**
 * A page of results from a list-returning operation (search, comments, timeline).
 *
 * Pagination is explicit so a consumer can always fetch more and is never misled
 * into thinking a truncated result is complete:
 *  - `nextCursor` is an OPAQUE token; pass it back as the call's `cursor` to get
 *    the next page. Absent means there is no known next page.
 *  - `truncated` is true whenever more items exist beyond this page — even when
 *    `nextCursor` is absent (e.g. sources that can't paginate statelessly).
 */
export interface Page<T> {
  items: T[];
  nextCursor?: string;
  truncated: boolean;
}

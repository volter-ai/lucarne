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
 * no bridge exists in this design (see CADENCE-SPLIT-TASKSPEC.md §1.3a/§1.4).
 * The schema is intentionally left AS-IS from claude-socials here; extending it
 * with `via:'screen'` + the `capture` pointer is LS-04's job, not this one's.
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
  /** How it was obtained: replayed the site's JSON API, or scraped DOM. */
  via: "internal-api" | "dom";
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

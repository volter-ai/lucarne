/**
 * x.com GraphQL response parsers — the WIRE sensor's per-site parser family
 * (LS-05b).
 *
 * Ported ONLY the pure response parsers named in CADENCE-SPLIT-TASKSPEC.md
 * §2 LS-05 from `claude-socials/packages/extension/src/sites/x.ts:513-768`:
 * `tweetToPost`, `parseTweetDetail`, `parseSearchTimeline`, `parseUserTweets`,
 * `userResultToProfile` — plus the small pure helpers those five lean on
 * (`dig`/`num`/`xDate`/`prov`/`unwrapTweet`/`authorHandleOf`/`avatarOf`/
 * `timelineEntries`/`tweetToComment`, all kept module-private exactly as
 * `x.ts` scoped them). x's own GraphQL responses are what a human's genuine
 * browsing already makes the app fetch (x's XHR-based hydration is
 * `content/x-main.ts:29-83`'s MAIN-world hook target in claude-socials); CDP's
 * passive `Network`-domain capture (LS-13W) observes the SAME response bytes
 * without ever issuing, replaying, or paginating a request itself.
 *
 * NOT ported here — categorically, per CADENCE-SPLIT-TASKSPEC.md §1.3/§1.3a,
 * not an oversight:
 *  - the two on-demand functions at `x.ts:126-229` (named for opening a small,
 *    unfocused browser window and reading back what loads in it — one plain,
 *    one an auto-advancing/paginating variant keyed off a `#__cs_` url
 *    marker) — synthetic navigation the extension issues on its own, never
 *    triggered by genuine human use.
 *  - every browser-extension window-management call, and the pacing wrapper
 *    (`x.ts:33,144-155,218-227`) that existed only to throttle those calls.
 *  - the `SiteAdapter` itself (`getProfile`/`getPost`/`getComments`/`search`/
 *    `getTimeline`, `x.ts:409-471`) — every method opens that small window or
 *    throws.
 *  - the caches/waiters/accumulators (`x.ts:48-52,95-101,168-280`) that exist
 *    only to route those synthetic calls, and the debug bookkeeping
 *    (`getXDebug`, `recordCapture`, `x.ts:56-93`).
 *  - `ingestXEvent`/`ingestGraphql`'s dispatch-by-`operationName` wiring
 *    (`x.ts:284-390`) — that glue belongs to the wire sensor that owns "which
 *    registered site matcher does this captured response match" (LS-13W's
 *    job, not a pure parser's). The OPERATION-NAME → PARSER mapping it encoded
 *    is preserved below so LS-13W doesn't have to re-derive it from
 *    claude-socials:
 *      `UserByScreenName` / `UserByRestId` → `userResultToProfile(dig(payload,
 *        ['data','user','result']))`
 *      `TweetResultByRestId` → `tweetToPost(dig(payload,
 *        ['data','tweetResult','result']))`
 *      `TweetDetail` → `parseTweetDetail(payload)`
 *      `SearchTimeline` → `parseSearchTimeline(payload, type)`, where `type`
 *        comes from the REQUEST URL's `variables.product` ('People' →
 *        'users', else 'posts' — `x.ts:356-357`'s `searchMetaFromUrl`; not
 *        ported here since it parses the *request* url, not a response body,
 *        but it is pure URL-parsing, not fetch machinery, so LS-13W is free
 *        to keep using it verbatim)
 *      `UserTweets` → `parseUserTweets(payload)`
 *
 * Records carry `provenance.via: 'internal-api'` — this package's schema now
 * defines that as "a passively CDP-captured wire response" (LS-04), not a
 * replayed fetch; these parsers were already provenance-honest about that
 * (`x.ts:2-18`'s "observe-don't-forge" header, `:493-494`'s `prov()`).
 *
 * PURE: no filesystem access, no network, no browser-extension APIs — JSON
 * in, `Post`/`Profile`/`Comment` records out.
 */

import type { AuthorRef, Comment, EngagementMetrics, Post, Profile, ProfileMetrics, Provenance } from "../schema.js";

function nowIso(): string {
  return new Date().toISOString();
}

/** Safe nested getter — ported verbatim from `x.ts`'s `dig`. */
function dig(obj: unknown, path: string[]): any {
  let cur: any = obj;
  for (const key of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[key];
  }
  return cur;
}

function prov(id: string, canonicalUrl: string): Provenance {
  return { source: "x", id, canonicalUrl, fetchedAt: nowIso(), via: "internal-api" };
}

/** x dates look like "Wed Oct 09 18:21:32 +0000 2006"; `Date` parses them. */
function xDate(s: unknown): string | undefined {
  if (typeof s !== "string" || !s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function num(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v !== "") {
    const n = Number(v);
    return Number.isNaN(n) ? undefined : n;
  }
  return undefined;
}

/**
 * Build a Profile from an x `UserResults.result` — used both for a direct
 * profile fetch (`UserByScreenName`/`UserByRestId`: `dig(payload,
 * ['data','user','result'])`) and for each `user-` entry of a People
 * `SearchTimeline` (see `parseSearchTimeline` below).
 */
export function userResultToProfile(r: any): Profile | null {
  if (!r) return null;
  const legacy = r.legacy ?? {};
  const core = r.core ?? {};
  const handle = core.screen_name ?? legacy.screen_name;
  if (!handle) return null;
  const metrics: ProfileMetrics = {
    followers: num(legacy.followers_count ?? dig(r, ["relationship_counts", "followers"])),
    following: num(legacy.friends_count),
    posts: num(legacy.statuses_count),
  };
  return {
    kind: "profile",
    provenance: prov(String(r.rest_id ?? handle), `https://x.com/${handle}`),
    handle,
    displayName: core.name ?? legacy.name,
    bio: legacy.description ?? dig(r, ["profile_bio", "description"]),
    avatarUrl: avatarOf(r),
    bannerUrl: legacy.profile_banner_url ?? dig(r, ["legacy", "profile_banner_url"]),
    verified: Boolean(r.is_blue_verified ?? legacy.verified),
    website: dig(legacy, ["entities", "url", "urls", "0", "expanded_url"]) ?? dig(r, ["legacy", "url"]),
    location: legacy.location ?? dig(r, ["location", "location"]) ?? undefined,
    createdAt: xDate(core.created_at ?? legacy.created_at),
    metrics,
  };
}

/** Full-size avatar URL from an x user result (x serves a `_normal` thumbnail). */
function avatarOf(r: any): string | undefined {
  const raw = r?.avatar?.image_url ?? r?.legacy?.profile_image_url_https ?? dig(r, ["legacy", "profile_image_url_https"]);
  return typeof raw === "string" ? raw.replace("_normal.", "_400x400.") : undefined;
}

/** Unwrap TweetWithVisibilityResults and similar wrappers. */
function unwrapTweet(result: any): any {
  if (!result) return null;
  return result.tweet ?? result;
}

function authorHandleOf(t: any): { handle: string; name?: string; avatarUrl?: string } {
  const u = dig(t, ["core", "user_results", "result"]);
  const legacy = u?.legacy ?? {};
  const ucore = u?.core ?? {};
  return {
    handle: ucore.screen_name ?? legacy.screen_name ?? "",
    name: ucore.name ?? legacy.name,
    avatarUrl: avatarOf(u),
  };
}

/**
 * Build a Post from a `TweetResults.result` — used for `TweetResultByRestId`,
 * `TweetDetail`'s focal tweet, and each `tweet-` entry of `UserTweets`/
 * `SearchTimeline`.
 */
export function tweetToPost(result: any): Post | null {
  const t = unwrapTweet(result);
  const legacy = t?.legacy;
  const rest_id = t?.rest_id;
  if (!legacy || !rest_id) return null;
  const author = authorHandleOf(t);
  const canonical = `https://x.com/${author.handle || "i"}/status/${rest_id}`;
  const authorRef: AuthorRef = {
    handle: author.handle,
    displayName: author.name,
    avatarUrl: author.avatarUrl,
    profileUrl: `https://x.com/${author.handle}`,
  };
  const metrics: EngagementMetrics = {
    score: num(legacy.favorite_count),
    reposts: num(legacy.retweet_count),
    replies: num(legacy.reply_count),
    views: num(dig(t, ["views", "count"])),
  };
  return {
    kind: "post",
    provenance: prov(String(rest_id), canonical),
    author: authorRef,
    text: legacy.full_text ?? "",
    createdAt: xDate(legacy.created_at),
    metrics,
    container: { name: `@${author.handle} on x.com`, url: canonical },
  };
}

interface CommentOpts {
  parentUrl: string;
  threadRootUrl: string;
  depth: number;
}

/**
 * Build a Comment from a `TweetResults.result` inside a `TweetDetail`
 * conversation thread. Not one of the five spec-named exports — kept
 * module-private exactly as `x.ts` scoped it, since `parseTweetDetail` is the
 * only entry point that produces comments.
 */
function tweetToComment(result: any, opts: CommentOpts): Comment | null {
  const t = unwrapTweet(result);
  const legacy = t?.legacy;
  const rest_id = t?.rest_id;
  if (!legacy || !rest_id) return null;
  const author = authorHandleOf(t);
  const canonical = `https://x.com/${author.handle || "i"}/status/${rest_id}`;
  return {
    kind: "comment",
    provenance: prov(String(rest_id), canonical),
    author: {
      handle: author.handle,
      displayName: author.name,
      avatarUrl: author.avatarUrl,
      profileUrl: `https://x.com/${author.handle}`,
    },
    text: legacy.full_text ?? "",
    createdAt: xDate(legacy.created_at),
    metrics: {
      score: num(legacy.favorite_count),
      reposts: num(legacy.retweet_count),
      replies: num(legacy.reply_count),
    },
    parentUrl: opts.parentUrl,
    threadRootUrl: opts.threadRootUrl,
    depth: opts.depth,
  };
}

function timelineEntries(instructions: any[]): any[] {
  const entries: any[] = [];
  for (const ins of instructions ?? []) {
    if (ins?.type === "TimelineAddEntries" && Array.isArray(ins.entries)) {
      entries.push(...ins.entries);
    }
  }
  return entries;
}

/** Parsed shape of a `TweetDetail` GraphQL response. */
export interface TweetDetailResult {
  rootId?: string;
  post?: Post;
  comments: Comment[];
  truncated: boolean;
}

/**
 * Parse a `TweetDetail` payload
 * (`payload.data.threaded_conversation_with_injections_v2.instructions`) into
 * the focal post + its reply thread. A `cursor-`/"show more replies" entry
 * means x is withholding further replies on this page → `truncated:true`.
 */
export function parseTweetDetail(payload: unknown): TweetDetailResult {
  const entries = timelineEntries(dig(payload, ["data", "threaded_conversation_with_injections_v2", "instructions"]));

  let truncated = entries.some((e) => (e?.entryId ?? "").startsWith("cursor-"));

  // Pass 1: the focal/root tweet is the first `tweet-` entry.
  let rootId: string | undefined;
  let post: Post | undefined;
  for (const e of entries) {
    if ((e?.entryId ?? "").startsWith("tweet-")) {
      const result = dig(e, ["content", "itemContent", "tweet_results", "result"]);
      const p = result ? tweetToPost(result) : null;
      if (p) {
        post = p;
        rootId = p.provenance.id;
        break;
      }
    }
  }
  const rootUrl = post?.provenance.canonicalUrl ?? "";
  const comments: Comment[] = [];

  // Pass 2: replies. A `conversationthread-` entry is one top-level reply
  // chain; its items[] nest sequentially (item 0 replies to the root, item 1
  // replies to item 0, …) so depth = item index and parentUrl chains down.
  for (const e of entries) {
    const entryId: string = e?.entryId ?? "";
    if (entryId.startsWith("tweet-")) {
      const result = dig(e, ["content", "itemContent", "tweet_results", "result"]);
      const t = unwrapTweet(result);
      if (t?.rest_id && String(t.rest_id) !== rootId) {
        const c = tweetToComment(result, { parentUrl: rootUrl, threadRootUrl: rootUrl, depth: 0 });
        if (c) comments.push(c);
      }
    } else if (entryId.startsWith("conversationthread-")) {
      const items = dig(e, ["content", "items"]) ?? [];
      let parentUrl = rootUrl;
      let depth = 0;
      for (const it of items) {
        const result = dig(it, ["item", "itemContent", "tweet_results", "result"]);
        if (!result) {
          truncated = true; // "show more replies" stub inside this thread
          continue;
        }
        const c = tweetToComment(result, { parentUrl, threadRootUrl: rootUrl, depth });
        if (!c) continue;
        comments.push(c);
        parentUrl = c.provenance.canonicalUrl;
        depth += 1;
      }
    }
  }

  return { rootId, post, comments, truncated };
}

/** Parsed shape of a `UserTweets` GraphQL response. */
export interface UserTweetsResult {
  posts: Post[];
  truncated: boolean;
}

/** Parse a `UserTweets` payload into the user's posts (+ a more-results marker). */
export function parseUserTweets(payload: unknown): UserTweetsResult {
  const instructions =
    dig(payload, ["data", "user", "result", "timeline_v2", "timeline", "instructions"]) ??
    dig(payload, ["data", "user", "result", "timeline", "timeline", "instructions"]) ??
    [];
  const entries = timelineEntries(instructions);
  const posts: Post[] = [];
  let truncated = false;
  for (const e of entries) {
    const entryId: string = e?.entryId ?? "";
    if (entryId.startsWith("cursor-bottom")) {
      if (dig(e, ["content", "value"])) truncated = true;
      continue;
    }
    if (entryId.startsWith("tweet-")) {
      const r = dig(e, ["content", "itemContent", "tweet_results", "result"]);
      const p = r ? tweetToPost(r) : null;
      if (p) posts.push(p);
    } else {
      // Profile modules (pinned, conversations) carry tweets under content.items.
      for (const it of dig(e, ["content", "items"]) ?? []) {
        const r = dig(it, ["item", "itemContent", "tweet_results", "result"]);
        const p = r ? tweetToPost(r) : null;
        if (p) posts.push(p);
      }
    }
  }
  return { posts, truncated };
}

/**
 * Which kind of items a `SearchTimeline` response holds — derived by the
 * CALLER from the request URL's `variables.product` ('People' → 'users', else
 * 'posts'; `x.ts:356-357`'s `searchMetaFromUrl`), since the response body
 * alone doesn't carry it.
 */
export type SearchType = "posts" | "users";

/** Parsed shape of a `SearchTimeline` GraphQL response. */
export interface SearchTimelineResult {
  items: Array<Post | Profile>;
  truncated: boolean;
}

/**
 * Parse a `SearchTimeline` payload
 * (`payload.data.search_by_raw_query.search_timeline.timeline.instructions`)
 * into posts (Top/Latest) or profiles (People) per the caller-supplied `type`.
 */
export function parseSearchTimeline(payload: unknown, type: SearchType): SearchTimelineResult {
  const entries = timelineEntries(dig(payload, ["data", "search_by_raw_query", "search_timeline", "timeline", "instructions"]));
  const items: Array<Post | Profile> = [];
  let truncated = false;
  for (const e of entries) {
    const entryId: string = e?.entryId ?? "";
    if (entryId.startsWith("cursor-bottom")) {
      const value = dig(e, ["content", "value"]);
      if (value) truncated = true; // a non-empty bottom cursor => more results
      continue;
    }
    if (type === "users") {
      if (!entryId.startsWith("user-")) continue;
      const r = dig(e, ["content", "itemContent", "user_results", "result"]);
      const p = userResultToProfile(r);
      if (p) items.push(p);
    } else {
      if (!entryId.startsWith("tweet-")) continue;
      const r = dig(e, ["content", "itemContent", "tweet_results", "result"]);
      const p = r ? tweetToPost(r) : null;
      if (p) items.push(p);
    }
  }
  return { items, truncated };
}

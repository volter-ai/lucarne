// LS-05b — golden tests for the ported x.com GraphQL response parsers
// (`sites/x-graphql.ts`), ported ONLY from the pure parser functions at
// `claude-socials/packages/extension/src/sites/x.ts:513-768`:
// `tweetToPost`/`parseTweetDetail`/`parseSearchTimeline`/`parseUserTweets`/
// `userResultToProfile`. Fixtures below model the SAME live thread as
// `cadence/test/fixtures/x-valid.json` (a Sakana Fugu-style post + author
// self-thread + external replies on x.com) reshaped as the raw x GraphQL
// response bodies these parsers actually consume (x-valid.json itself is a
// different, higher-level "reading" schema captured by a different cadence
// pipeline — not a GraphQL response body).
//
// Run with `node test/sites-x-graphql.mjs` (after `npm run build`).
import assert from "node:assert/strict";
import {
  parseSearchTimeline,
  parseTweetDetail,
  parseUserTweets,
  tweetToPost,
  userResultToProfile,
} from "../dist/sites/x-graphql.js";
import { isEntity } from "../dist/validate.js";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// ── fixture builders — the shape x's GraphQL responses actually carry ───────
const ROOT_ID = "2068861630327443966";
const REPLY1_ID = "2068862344684581023";
const REPLY2_ID = "2068862999999999999";
const EXTERNAL_REPLY_ID = "2068863111111111111";

function userResult({ id, handle, name, avatarBase, verified = true, followers, following, posts, bio }) {
  return {
    rest_id: id,
    core: { screen_name: handle, name },
    legacy: {
      description: bio,
      followers_count: followers,
      friends_count: following,
      statuses_count: posts,
      profile_image_url_https: `https://pbs.twimg.com/profile_images/${avatarBase}_normal.jpg`,
    },
    is_blue_verified: verified,
  };
}

function tweetResult({ id, handle, name, avatarBase, text, favorite_count, retweet_count, reply_count, views }) {
  return {
    rest_id: id,
    legacy: {
      full_text: text,
      created_at: "Sun Jun 21 21:00:00 +0000 2026",
      favorite_count,
      retweet_count,
      reply_count,
    },
    ...(views !== undefined ? { views: { count: String(views) } } : {}),
    core: {
      user_results: {
        result: {
          core: { screen_name: handle, name },
          legacy: { profile_image_url_https: `https://pbs.twimg.com/profile_images/${avatarBase}_normal.jpg` },
        },
      },
    },
  };
}

const SAKANA = { handle: "SakanaAILabs", name: "Sakana AI", avatarBase: "1/sakana" };

const rootTweet = tweetResult({
  id: ROOT_ID,
  ...SAKANA,
  text: "Introducing Sakana Fugu: A full multi-agent orchestration system accessible via a single model API.",
  favorite_count: 35000,
  retweet_count: 9016,
  reply_count: 1047,
  views: 21684207,
});
const selfReply = tweetResult({
  id: REPLY1_ID,
  ...SAKANA,
  text: "Fugu stands shoulder-to-shoulder with leading models across the industry's most rigorous benchmarks.",
  favorite_count: 3597,
  retweet_count: 720,
  reply_count: 83,
});
const nestedSelfReply = tweetResult({
  id: REPLY2_ID,
  ...SAKANA,
  text: "How does it work? Sakana Fugu is itself an LLM, trained to call various LLMs in an agent pool.",
  favorite_count: 2054,
  retweet_count: 264,
  reply_count: 41,
});
const externalReply = tweetResult({
  id: EXTERNAL_REPLY_ID,
  handle: "fawadhsdev",
  name: "Fawad H Syed",
  avatarBase: "2/fawad",
  text: "Can't wait to use it, but currently not available in Switzerland",
  favorite_count: 7,
  retweet_count: 0,
  reply_count: 2,
});

// ── tweetToPost — the focal-tweet / timeline-entry / search-result builder ──
{
  const post = tweetToPost(rootTweet);
  check("tweetToPost: kind is 'post'", post.kind === "post");
  check("tweetToPost: provenance.source is 'x'", post.provenance.source === "x");
  check("tweetToPost: provenance.id is the bare rest_id", post.provenance.id === ROOT_ID);
  check("tweetToPost: provenance.canonicalUrl is the author-scoped status url", post.provenance.canonicalUrl === `https://x.com/SakanaAILabs/status/${ROOT_ID}`);
  check("tweetToPost: provenance.via is 'internal-api' (a passively CDP-captured wire response)", post.provenance.via === "internal-api");
  check("tweetToPost: author.handle/displayName/avatarUrl/profileUrl all resolved", post.author.handle === "SakanaAILabs" && post.author.displayName === "Sakana AI" && post.author.avatarUrl.endsWith("_400x400.jpg") && post.author.profileUrl === "https://x.com/SakanaAILabs");
  check("tweetToPost: text carried verbatim from legacy.full_text", post.text === rootTweet.legacy.full_text);
  check("tweetToPost: createdAt parsed from x's date format", post.createdAt === "2026-06-21T21:00:00.000Z");
  check("tweetToPost: metrics.score/reposts/replies/views all mapped", post.metrics.score === 35000 && post.metrics.reposts === 9016 && post.metrics.replies === 1047 && post.metrics.views === 21684207);
  check("tweetToPost: container names the author's x.com presence", post.container.name === "@SakanaAILabs on x.com" && post.container.url === post.provenance.canonicalUrl);
  check("tweetToPost: the result validates as a schema Entity", isEntity(post));
  check("tweetToPost: a malformed result (no legacy/rest_id) returns null rather than throwing", tweetToPost({}) === null && tweetToPost(null) === null);
}

// ── userResultToProfile — direct profile fetch + People-search entries ──────
{
  const raw = userResult({ id: "999", handle: "paulg", name: "Paul Graham", avatarBase: "1/pg", followers: 2000000, following: 100, posts: 5000, bio: "essayist" });
  const profile = userResultToProfile(raw);
  check("userResultToProfile: kind is 'profile'", profile.kind === "profile");
  check("userResultToProfile: provenance.id prefers rest_id over handle", profile.provenance.id === "999");
  check("userResultToProfile: provenance.canonicalUrl is the profile url", profile.provenance.canonicalUrl === "https://x.com/paulg");
  check("userResultToProfile: provenance.via is 'internal-api'", profile.provenance.via === "internal-api");
  check("userResultToProfile: handle/displayName/bio mapped", profile.handle === "paulg" && profile.displayName === "Paul Graham" && profile.bio === "essayist");
  check("userResultToProfile: avatar upgraded from _normal to _400x400", profile.avatarUrl === "https://pbs.twimg.com/profile_images/1/pg_400x400.jpg");
  check("userResultToProfile: verified reflects is_blue_verified", profile.verified === true);
  check("userResultToProfile: metrics.followers/following/posts mapped", profile.metrics.followers === 2000000 && profile.metrics.following === 100 && profile.metrics.posts === 5000);
  check("userResultToProfile: the result validates as a schema Entity", isEntity(profile));
  check("userResultToProfile: a nullish result returns null rather than throwing", userResultToProfile(null) === null);
  check("userResultToProfile: a result with no resolvable handle returns null", userResultToProfile({ rest_id: "1", legacy: {}, core: {} }) === null);
}

// ── parseTweetDetail — the focal post + its flat self-thread + one external reply ──
{
  const payload = {
    data: {
      threaded_conversation_with_injections_v2: {
        instructions: [
          {
            type: "TimelineAddEntries",
            entries: [
              { entryId: `tweet-${ROOT_ID}`, content: { itemContent: { tweet_results: { result: rootTweet } } } },
              // the author's OWN reply chain, back-to-back `tweet-` entries after the root
              { entryId: `tweet-${REPLY1_ID}`, content: { itemContent: { tweet_results: { result: selfReply } } } },
              // a nested conversation thread: item 0 replies to root, item 1 replies to item 0
              {
                entryId: `conversationthread-${REPLY2_ID}`,
                content: {
                  items: [
                    { item: { itemContent: { tweet_results: { result: nestedSelfReply } } } },
                    { item: { itemContent: { tweet_results: { result: externalReply } } } },
                  ],
                },
              },
              { entryId: "cursor-bottom-1", content: { value: "opaque-cursor" } },
            ],
          },
        ],
      },
    },
  };

  const parsed = parseTweetDetail(payload);
  check("parseTweetDetail: rootId resolves to the focal tweet's rest_id", parsed.rootId === ROOT_ID);
  check("parseTweetDetail: post is the focal tweet, mapped via tweetToPost", parsed.post.provenance.id === ROOT_ID && parsed.post.text === rootTweet.legacy.full_text);
  check("parseTweetDetail: a trailing cursor- entry marks the thread truncated", parsed.truncated === true);
  check("parseTweetDetail: collects a top-level tweet- reply AND a nested conversationthread-'s items (3 comments total)", parsed.comments.length === 3);

  const bareReply = parsed.comments.find((c) => c.provenance.id === REPLY1_ID);
  check("parseTweetDetail: a bare 'tweet-' reply entry parents directly to the root (depth 0)", bareReply.parentUrl === parsed.post.provenance.canonicalUrl && bareReply.threadRootUrl === parsed.post.provenance.canonicalUrl && bareReply.depth === 0);

  const nested0 = parsed.comments.find((c) => c.provenance.id === REPLY2_ID);
  check("parseTweetDetail: conversationthread item 0 parents to the root (depth 0)", nested0.parentUrl === parsed.post.provenance.canonicalUrl && nested0.depth === 0);

  const nested1 = parsed.comments.find((c) => c.provenance.id === EXTERNAL_REPLY_ID);
  check(
    "parseTweetDetail: conversationthread item 1 CHAINS to item 0 (parentUrl = item 0's canonicalUrl, depth 1) — the sequential-nesting invariant",
    nested1.parentUrl === nested0.provenance.canonicalUrl && nested1.depth === 1,
  );
  check("parseTweetDetail: every threadRootUrl still points at the FOCAL tweet regardless of depth", parsed.comments.every((c) => c.threadRootUrl === parsed.post.provenance.canonicalUrl));
  check("parseTweetDetail: every comment carries provenance.via:'internal-api' and validates", parsed.comments.every((c) => c.provenance.via === "internal-api" && isEntity(c)));

  // ── BYTE-STABLE golden snapshot (fetchedAt excluded — wall-clock) ─────────
  const stripFetched = (e) => {
    const { provenance, ...rest } = e;
    const { fetchedAt, ...p } = provenance;
    return { ...rest, provenance: p };
  };
  const expectedPost = {
    kind: "post",
    author: { handle: "SakanaAILabs", displayName: "Sakana AI", avatarUrl: "https://pbs.twimg.com/profile_images/1/sakana_400x400.jpg", profileUrl: "https://x.com/SakanaAILabs" },
    text: "Introducing Sakana Fugu: A full multi-agent orchestration system accessible via a single model API.",
    createdAt: "2026-06-21T21:00:00.000Z",
    metrics: { score: 35000, reposts: 9016, replies: 1047, views: 21684207 },
    container: { name: "@SakanaAILabs on x.com", url: `https://x.com/SakanaAILabs/status/${ROOT_ID}` },
    provenance: { source: "x", id: ROOT_ID, canonicalUrl: `https://x.com/SakanaAILabs/status/${ROOT_ID}`, via: "internal-api" },
  };
  check(
    "GOLDEN SNAPSHOT: parseTweetDetail's focal post is byte-stable against a fixed expected literal",
    JSON.stringify(stripFetched(parsed.post)) === JSON.stringify(expectedPost),
    JSON.stringify(stripFetched(parsed.post)),
  );

  check("parseTweetDetail: a malformed/empty payload yields no rootId/post and an empty, non-truncated comment list", (() => {
    const empty = parseTweetDetail({});
    return empty.rootId === undefined && empty.post === undefined && empty.comments.length === 0 && empty.truncated === false;
  })());
}

// ── parseUserTweets — a user's own timeline (+ truncation marker) ───────────
{
  const payload = {
    data: {
      user: {
        result: {
          timeline_v2: {
            timeline: {
              instructions: [
                {
                  type: "TimelineAddEntries",
                  entries: [
                    { entryId: `tweet-${ROOT_ID}`, content: { itemContent: { tweet_results: { result: rootTweet } } } },
                    { entryId: `tweet-${REPLY1_ID}`, content: { itemContent: { tweet_results: { result: selfReply } } } },
                    { entryId: "cursor-bottom-1", content: { value: "opaque-cursor" } },
                  ],
                },
              ],
            },
          },
        },
      },
    },
  };
  const page = parseUserTweets(payload);
  check("parseUserTweets: collects every 'tweet-' entry in order", page.posts.length === 2 && page.posts[0].provenance.id === ROOT_ID && page.posts[1].provenance.id === REPLY1_ID);
  check("parseUserTweets: a non-empty cursor-bottom value marks the page truncated", page.truncated === true);
  check("parseUserTweets: every post carries provenance.via:'internal-api' and validates", page.posts.every((p) => p.provenance.via === "internal-api" && isEntity(p)));

  const oneEntryInstructions = [
    { type: "TimelineAddEntries", entries: [{ entryId: `tweet-${ROOT_ID}`, content: { itemContent: { tweet_results: { result: rootTweet } } } }] },
  ];
  const noCursor = parseUserTweets({ data: { user: { result: { timeline_v2: { timeline: { instructions: oneEntryInstructions } } } } } });
  check("parseUserTweets: no cursor-bottom entry -> truncated:false", noCursor.truncated === false);

  const alt = parseUserTweets({ data: { user: { result: { timeline: { timeline: { instructions: oneEntryInstructions } } } } } });
  check(
    "parseUserTweets: falls back to the OLDER `timeline.timeline.instructions` path when `timeline_v2` is absent",
    alt.posts.length === 1 && alt.posts[0].provenance.id === ROOT_ID,
  );
}

// ── parseSearchTimeline — Top/Latest (posts) and People (profiles) ──────────
{
  const postsPayload = {
    data: {
      search_by_raw_query: {
        search_timeline: {
          timeline: {
            instructions: [
              {
                type: "TimelineAddEntries",
                entries: [
                  { entryId: `tweet-${ROOT_ID}`, content: { itemContent: { tweet_results: { result: rootTweet } } } },
                  { entryId: "cursor-bottom-1", content: { value: "" } }, // an EMPTY bottom cursor => no more results
                ],
              },
            ],
          },
        },
      },
    },
  };
  const postsPage = parseSearchTimeline(postsPayload, "posts");
  check("parseSearchTimeline(posts): finds the tweet- entry, ignores an unrelated user- entry type", postsPage.items.length === 1 && postsPage.items[0].kind === "post" && postsPage.items[0].provenance.id === ROOT_ID);
  check("parseSearchTimeline(posts): an EMPTY bottom-cursor value means NOT truncated", postsPage.truncated === false);

  const raw = userResult({ id: "999", handle: "paulg", name: "Paul Graham", avatarBase: "1/pg", followers: 2000000 });
  const usersPayload = {
    data: {
      search_by_raw_query: {
        search_timeline: {
          timeline: {
            instructions: [
              {
                type: "TimelineAddEntries",
                entries: [
                  { entryId: "user-999", content: { itemContent: { user_results: { result: raw } } } },
                  { entryId: `tweet-${ROOT_ID}`, content: { itemContent: { tweet_results: { result: rootTweet } } } }, // wrong type for this call — must be ignored
                  { entryId: "cursor-bottom-1", content: { value: "opaque" } },
                ],
              },
            ],
          },
        },
      },
    },
  };
  const usersPage = parseSearchTimeline(usersPayload, "users");
  check("parseSearchTimeline(users): finds the user- entry, ignores the tweet- entry (type-filtered by the caller's `type`)", usersPage.items.length === 1 && usersPage.items[0].kind === "profile" && usersPage.items[0].handle === "paulg");
  check("parseSearchTimeline(users): a non-empty bottom-cursor value means truncated", usersPage.truncated === true);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

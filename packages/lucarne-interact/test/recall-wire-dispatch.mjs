// LS-13W dev — the WIRE sensor's operationName -> parser dispatch (Chrome-free): drives
// `xWireAdapter`/`dispatchWireAdapters` (wire.ts) with CAPTURED-RESPONSE FIXTURES (the shape a real
// x GraphQL response body actually has) and asserts the right `via:'internal-api'` records come out
// — the PARSE half of LS-13W's acceptance criteria (dev/03), independently Chrome-free testable
// exactly like recall-extractor-dispatch.mjs is for the screen sensor's plugin dispatch. Also proves
// the request-url `variables.product` parsing for `SearchTimeline` (`searchTypeFromUrl`) and the x
// GraphQL url match predicate (`isXGraphqlUrl`/`xOperationNameOf`), all pure — no browser, no CDP,
// no network.
//
// Run with `node test/recall-wire-dispatch.mjs` (after `npm run build` in BOTH this package and
// lucarne-records).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dispatchWireAdapters, isXGraphqlUrl, searchTypeFromUrl, xOperationNameOf, xWireAdapter } from "../dist/recall/wire.js";
import { appendRecords, isEntity, loadRecords } from "lucarne-records";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// ── fixture builders — the shape x's own GraphQL responses actually carry (mirrors
//    lucarne-records/test/sites-x-graphql.mjs's own fixture shape, independently, since test
//    files don't share fixtures across packages) ──
const ROOT_ID = "2068861630327443966";
const REPLY_ID = "2068862344684581023";

function userResult({ id, handle, name, avatarBase, verified = true, followers }) {
  return {
    rest_id: id,
    core: { screen_name: handle, name },
    legacy: { followers_count: followers, profile_image_url_https: `https://pbs.twimg.com/profile_images/${avatarBase}_normal.jpg` },
    is_blue_verified: verified,
  };
}

function tweetResult({ id, handle, name, avatarBase, text, favorite_count = 0, retweet_count = 0, reply_count = 0 }) {
  return {
    rest_id: id,
    legacy: { full_text: text, created_at: "Sun Jun 21 21:00:00 +0000 2026", favorite_count, retweet_count, reply_count },
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
const rootTweet = tweetResult({ id: ROOT_ID, ...SAKANA, text: "Introducing Sakana Fugu.", favorite_count: 35000 });

function tweetEntry(entryId, result) {
  return { entryId, content: { itemContent: { tweet_results: { result } } } };
}
function userEntry(entryId, result) {
  return { entryId, content: { itemContent: { user_results: { result } } } };
}
function instructions(entries) {
  return [{ type: "TimelineAddEntries", entries }];
}

// ── A. pure url helpers ──
{
  check("isXGraphqlUrl: matches x's /i/api/graphql/ path", isXGraphqlUrl("https://x.com/i/api/graphql/abc123/UserTweets?variables=%7B%7D"));
  check("isXGraphqlUrl: rejects an unrelated url", !isXGraphqlUrl("https://x.com/paulg/status/123"));

  check(
    "xOperationNameOf: recovers the operationName segment",
    xOperationNameOf("https://x.com/i/api/graphql/abcXYZ123/TweetDetail?variables=%7B%7D") === "TweetDetail",
  );
  check("xOperationNameOf: a non-GraphQL url -> null", xOperationNameOf("https://x.com/home") === null);

  const peopleUrl = `https://x.com/i/api/graphql/abc/SearchTimeline?variables=${encodeURIComponent(JSON.stringify({ product: "People" }))}`;
  const topUrl = `https://x.com/i/api/graphql/abc/SearchTimeline?variables=${encodeURIComponent(JSON.stringify({ product: "Top" }))}`;
  const noVarsUrl = "https://x.com/i/api/graphql/abc/SearchTimeline";
  check("searchTypeFromUrl: variables.product:'People' -> 'users'", searchTypeFromUrl(peopleUrl) === "users");
  check("searchTypeFromUrl: any other product (e.g. 'Top') -> 'posts'", searchTypeFromUrl(topUrl) === "posts");
  check("searchTypeFromUrl: no variables param at all -> defaults to 'posts'", searchTypeFromUrl(noVarsUrl) === "posts");
  check("searchTypeFromUrl: malformed variables JSON -> defaults to 'posts', never throws", searchTypeFromUrl("https://x.com/i/api/graphql/abc/SearchTimeline?variables=not-json") === "posts");
}

// ── B. xWireAdapter.match ──
{
  check("xWireAdapter.match: true for an x GraphQL url", xWireAdapter.match("https://x.com/i/api/graphql/abc/UserByScreenName"));
  check("xWireAdapter.match: false for a non-GraphQL url", !xWireAdapter.match("https://x.com/home"));
}

// ── C. the operationName -> parser dispatch table, one captured-response fixture per operation ──
{
  const userPayload = { data: { user: { result: userResult({ id: "999", handle: "paulg", name: "Paul Graham", avatarBase: "2/paulg", followers: 1_500_000 }) } } };
  for (const op of ["UserByScreenName", "UserByRestId"]) {
    const url = `https://x.com/i/api/graphql/qid/${op}?variables=%7B%7D`;
    const out = xWireAdapter.dispatch(url, userPayload);
    check(`${op}: dispatches to userResultToProfile -> exactly one profile`, out.length === 1 && out[0].kind === "profile", JSON.stringify(out));
    check(`${op}: the profile's handle is mapped`, out[0]?.handle === "paulg");
    check(`${op}: provenance.via is 'internal-api'`, out[0]?.provenance.via === "internal-api");
    check(`${op}: the record validates as a schema Entity`, isEntity(out[0]));
  }

  const tweetPayload = { data: { tweetResult: { result: rootTweet } } };
  {
    const url = "https://x.com/i/api/graphql/qid/TweetResultByRestId?variables=%7B%7D";
    const out = xWireAdapter.dispatch(url, tweetPayload);
    check("TweetResultByRestId: dispatches to tweetToPost -> exactly one post", out.length === 1 && out[0].kind === "post", JSON.stringify(out));
    check("TweetResultByRestId: provenance.id is the tweet's rest_id", out[0]?.provenance.id === ROOT_ID);
    check("TweetResultByRestId: provenance.via is 'internal-api'", out[0]?.provenance.via === "internal-api");
  }

  {
    const replyTweet = tweetResult({ id: REPLY_ID, handle: "janedoe", name: "Jane Doe", avatarBase: "3/jane", text: "great work" });
    const detailPayload = {
      data: {
        threaded_conversation_with_injections_v2: {
          instructions: instructions([tweetEntry(`tweet-${ROOT_ID}`, rootTweet), tweetEntry(`tweet-${REPLY_ID}`, replyTweet)]),
        },
      },
    };
    const url = "https://x.com/i/api/graphql/qid/TweetDetail?variables=%7B%7D";
    const out = xWireAdapter.dispatch(url, detailPayload);
    check("TweetDetail: dispatches to parseTweetDetail -> the focal post + its reply", out.length === 2, JSON.stringify(out.map((r) => r.kind)));
    check("TweetDetail: the focal post is a 'post'", out.some((r) => r.kind === "post" && r.provenance.id === ROOT_ID));
    check("TweetDetail: the reply is a 'comment'", out.some((r) => r.kind === "comment" && r.provenance.id === REPLY_ID));
    check("TweetDetail: every record carries provenance.via:'internal-api'", out.every((r) => r.provenance.via === "internal-api"));
  }

  {
    const timelinePayload = { data: { user: { result: { timeline_v2: { timeline: { instructions: instructions([tweetEntry(`tweet-${ROOT_ID}`, rootTweet)]) } } } } } };
    const url = "https://x.com/i/api/graphql/qid/UserTweets?variables=%7B%7D";
    const out = xWireAdapter.dispatch(url, timelinePayload);
    check("UserTweets: dispatches to parseUserTweets -> the one tweet- entry", out.length === 1 && out[0].kind === "post" && out[0].provenance.id === ROOT_ID, JSON.stringify(out));
  }

  {
    const searchUser = userResult({ id: "777", handle: "janedoe", name: "Jane Doe", avatarBase: "3/jane", followers: 500 });
    const searchPayload = { data: { search_by_raw_query: { search_timeline: { timeline: { instructions: instructions([userEntry("user-777", searchUser), tweetEntry(`tweet-${ROOT_ID}`, rootTweet)]) } } } } };
    const peopleUrl = `https://x.com/i/api/graphql/qid/SearchTimeline?variables=${encodeURIComponent(JSON.stringify({ product: "People" }))}`;
    const outPeople = xWireAdapter.dispatch(peopleUrl, searchPayload);
    check("SearchTimeline(People, from the REQUEST url): only the user- entry is kept -> one profile", outPeople.length === 1 && outPeople[0].kind === "profile", JSON.stringify(outPeople));

    const topUrl = `https://x.com/i/api/graphql/qid/SearchTimeline?variables=${encodeURIComponent(JSON.stringify({ product: "Top" }))}`;
    const outTop = xWireAdapter.dispatch(topUrl, searchPayload);
    check("SearchTimeline(Top, from the REQUEST url): only the tweet- entry is kept -> one post", outTop.length === 1 && outTop[0].kind === "post", JSON.stringify(outTop));
  }

  check("an unrecognized operationName -> [] (not in the dispatch table, not an error)", xWireAdapter.dispatch("https://x.com/i/api/graphql/qid/SomeFutureOperation?variables=%7B%7D", {}).length === 0);
  check("a malformed payload for a KNOWN op -> [] rather than throwing", xWireAdapter.dispatch("https://x.com/i/api/graphql/qid/TweetDetail", null).length === 0);
  check("xWireAdapter never throws even on a garbage url", (() => {
    try {
      return Array.isArray(xWireAdapter.dispatch("not a url at all", {}));
    } catch {
      return false;
    }
  })());
}

// ── D. dispatchWireAdapters — the selection loop (match-gated, concatenating, error-isolating),
//    mirroring capture.ts's dispatchExtractors exactly (test/recall-extractor-dispatch.mjs) ──
{
  const onlyX = { match: (u) => u.includes("x.com"), dispatch: () => [{ tag: "from-x" }] };
  const onlyReddit = { match: (u) => u.includes("reddit.com"), dispatch: () => [{ tag: "from-reddit" }] };
  const out = dispatchWireAdapters("https://x.com/i/api/graphql/qid/Op", {}, [onlyX, onlyReddit]);
  check("dispatchWireAdapters: only the MATCHING adapter's records are included", out.length === 1 && out[0].tag === "from-x", JSON.stringify(out));

  const bothA = { match: () => true, dispatch: () => [{ tag: "a" }] };
  const bothB = { match: () => true, dispatch: () => [{ tag: "b" }] };
  const concatenated = dispatchWireAdapters("u", {}, [bothA, bothB]);
  check("dispatchWireAdapters: multiple matching adapters' records are CONCATENATED", concatenated.length === 2 && concatenated.map((r) => r.tag).sort().join(",") === "a,b");

  const throwing = { match: () => true, dispatch: () => { throw new Error("boom"); } };
  const survivor = { match: () => true, dispatch: () => [{ tag: "survivor" }] };
  const isolated = dispatchWireAdapters("u", {}, [throwing, survivor]);
  check("dispatchWireAdapters: a THROWING adapter never breaks capture or its siblings", isolated.length === 1 && isolated[0].tag === "survivor", JSON.stringify(isolated));

  const none = dispatchWireAdapters("https://nowhere.test/", {}, [onlyX, onlyReddit]);
  check("dispatchWireAdapters: no adapter matches -> empty array, no throw", Array.isArray(none) && none.length === 0);

  const empty = dispatchWireAdapters("https://x.com/i/api/graphql/qid/Op", {}, []);
  check("dispatchWireAdapters: an empty adapter list -> empty array", empty.length === 0);
}

// ── E. end-to-end: a captured response dispatched through xWireAdapter lands in the SAME
//    `lucarne-records` store the screen sensor writes to, via the same appendRecords — proving the
//    'via:internal-api' records are real, storeable entities, not just in-memory shapes ──
{
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-recall-wire-dispatch-"));
  try {
    const url = "https://x.com/i/api/graphql/qid/TweetResultByRestId?variables=%7B%7D";
    const payload = { data: { tweetResult: { result: rootTweet } } };
    const records = dispatchWireAdapters(url, payload, [xWireAdapter]);
    const added = appendRecords(dataDir, records);
    check("end-to-end: appendRecords reports one brand-new identity added", added === 1, added);
    const stored = loadRecords(dataDir);
    check("end-to-end: the wire record lands in the shared store", stored.length === 1 && stored[0].provenance.id === ROOT_ID, JSON.stringify(stored));
    check("end-to-end: the stored record still carries provenance.via:'internal-api'", stored[0]?.provenance.via === "internal-api");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

---
name: socials-toolkit
description: Reference for reading social data via the lucarne-corpus-mcp server (x.com, reddit.com, news.ycombinator.com) — profiles, posts, comment threads, user/site timelines, and free-text search of posts or users. Use whenever a task involves looking up, browsing, or analyzing accounts, posts, or discussions on those sites. Covers the tools, the browse-then-query workflow, pagination/provenance rules, and the read-only constraint that every other socials skill builds on.
---

# lucarne-corpus-mcp toolkit

The `lucarne-corpus-mcp` server serves typed, provenance-rich data from **x.com**, **reddit.com**,
and **news.ycombinator.com** — but ONLY data that has already been passively captured by a genuine,
human-paced browsing session (`lucarne-interact`'s recall). It is **read-only** in two senses: it
never posts, votes, follows, or DMs, AND it never fetches — it has no network access at all, it only
reads a local corpus off disk. Your job is to read, analyze, and draft; the human acts.

## The browse-then-query workflow — this is the load-bearing difference from a live API

`lucarne-corpus-mcp` is a query surface over a **corpus**, not a live fetcher. If you ask for
something that hasn't been captured yet, a tool returns a structured `not_captured` result instead
of an error or empty data:

```jsonc
{
  "status": "not_captured",
  "message": "Not captured yet: a x profile for handle \"someone\".",
  "hint": "This corpus is read-only and never fetches. Browse to it in-session — recall captures passively while a human/agent genuinely browses — then query again. Visit the profile page for \"someone\" on x in a driven session.",
  "query": { "op": "get_profile", "source": "x", "handle": "someone" }
}
```

When you see `status: "not_captured"`:
1. **Browse to the thing** in your driven session (the browser session you or the human are operating)
   — visit the profile/post/thread/list page a genuine human would. Do not try to work around this by
   inventing a URL to "fetch" — there is no fetch path here, by design.
   ("§1.3/§1.3a — no synthetic request is ever issued on your behalf.")
2. Let the recorder observe what genuinely loads (this happens automatically as part of a normal
   driven session — you don't call anything to "trigger" a capture).
3. **Call the same tool again.** Once it's been captured, the query returns real data with provenance.

Never claim you "fetched" or "loaded" something the corpus doesn't have. If a task can't be completed
because nothing relevant has been browsed yet, say so plainly and suggest what to browse.

## Tools (all read-only STORE reads — see above; no `bridge_status`/connection check needed, there is no bridge)

| Tool | Use it to |
| --- | --- |
| `get_profile(source, handle)` | Read a captured account: bio, avatar, verified, website, followers/karma, post count, created date. |
| `get_post(source, idOrUrl)` | Read one captured post/tweet/story: text, author, score, replies, views. Accepts an id or a full URL. |
| `get_comments(source, postIdOrUrl, depth?, limit?, cursor?)` | Read a captured comment/reply tree. |
| `search(source, query, type?, container?, limit?, sort?, cursor?)` | Find captured posts (`type:"posts"`) or users (`type:"users"`). `container` = subreddit (reddit only). |
| `get_timeline(source, kind, handle?, container?, limit?, cursor?)` | Browse a captured list: a user's posts (`kind:"user_posts"` + `handle`), a subreddit (`kind:"hot"/"new"/"top"` + `container`), or HN (`kind:"top"/"new"/"best"/"ask"/"show"`). |

Per-source notes:
- **x**: `search type:"users"` finds accounts; `get_timeline` supports only `kind:"user_posts"`.
- **reddit**: `search type:"users"` finds redditors; subreddit lists need `container` (no `r/`).
- **hackernews**: no user search and no avatars; `search` is full-text over what's been captured.

## Pagination — never imply completeness you don't have

Every list-returning tool (`get_comments`, `search`, `get_timeline`) returns a **page**:

```jsonc
{ "items": [ ... ], "nextCursor": "<opaque>", "truncated": true }
```

- **`truncated: true` means more MAY exist beyond this page** — either more was captured than fits the
  page size, or more exists on the site that simply hasn't been browsed yet. Either way, do NOT
  summarize a truncated thread or result set as if it were the whole picture.
- To get more of what's ALREADY captured, call the same tool again passing `cursor: <nextCursor>`.
- To get more than what's captured, browse further (scroll the thread, visit more of the timeline) in
  your driven session, then query again.
- Keep paging/browsing until you have what the task needs or `truncated` is false / `nextCursor` is
  absent. If you deliberately stop early, say so.

## Provenance — always cite

Every entity carries `provenance: { source, id, canonicalUrl, fetchedAt, via }`.

- **Cite `canonicalUrl`** for any claim, quote, or recommendation so the human can verify and act.
- Mention **`fetchedAt`** when freshness matters — it's the moment recall captured it, not "now."
  Scores/follower counts may have drifted since.
- **`via`** tells you how it was captured: `internal-api` (the site's own JSON/GraphQL, observed
  passively during browsing), `screen` (a passive on-screen/ARIA capture), or `dom`.
- For comments, use `parentUrl` and `threadRootUrl` to point the human at the exact reply location.

## Etiquette & limits

- This corpus reflects only what was **genuinely, human-pacedly browsed** — there is no throttling to
  configure and nothing to retry-spam, because there is no fetch path to spam. If data is missing, the
  fix is always "browse more," never "call the tool again faster."
- It is **read-only**: present drafts/recommendations for the human to post; never claim you posted,
  replied, followed, or messaged.
- Respect the user's intent and the sites' norms when deciding what to browse.

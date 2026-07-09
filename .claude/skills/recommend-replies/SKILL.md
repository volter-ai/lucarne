---
name: recommend-replies
description: Browse a user's posts (or a topic's posts), read the comment threads, and draft recommended replies matched to the conversation. Use when asked to suggest replies, draft responses, engage with a thread, find reply opportunities, or craft comments on posts/tweets/discussions. Reads via lucarne-corpus-mcp — it drafts replies for the human to post (read-only, browse-then-query, never posts).
---

# Browse posts, read comments, draft replies

Find the right posts, browse them in-session so the corpus captures the real conversation under them,
then propose replies the human can post. See [socials-toolkit](../socials-toolkit/SKILL.md) for tool,
browse-then-query, pagination, and provenance rules.

## Steps

1. **Pick the target posts:**
   - A specific account's posts → `get_timeline(source, kind:"user_posts", handle, limit: 20)`.
   - A topic → `search(source, query, type:"posts", limit: 20)` (add `container` for a subreddit).
   If either returns `not_captured` or thin results, browse the account's timeline / the topic's
   search results in-session first, then query again. Page with `nextCursor` over what's captured;
   respect `truncated`.
2. **For each promising post**, get full context: `get_post(source, idOrUrl)` for the body + metrics,
   then `get_comments(source, postIdOrUrl, depth: 2, limit: 30)` to read the discussion.
   - **Read the real thread, not a slice.** If the comments come back `not_captured`, browse to that
     post and open/scroll its replies in-session — the thread only exists in the corpus once you've
     genuinely looked at it. If `truncated` is true and the conversation matters, browse further
     (open more replies, expand nested threads) and page with `cursor: nextCursor` over what's already
     captured.
   - Use `parentUrl` / `threadRootUrl` / `depth` to follow who is replying to whom.
3. **Understand before drafting:** the post's point, the dominant sentiment, open questions,
   disagreements, and gaps where a reply would add value (not noise).
4. **Draft replies.** For each opportunity, propose a reply that fits the platform's tone and the
   thread's register, adds something genuine (answer, evidence, perspective, question), and isn't
   generic. Offer 1–2 variants when tone could go more than one way.

## Output

Group by post. For each: a one-line summary of the post + its `canonicalUrl`, the thread's gist, and
the **exact place to reply** (the `canonicalUrl`/`parentUrl` of the post or comment you're replying
to) with the drafted reply text. Keep drafts ready-to-paste. Flag anything sensitive (heated thread,
potential backlash). You are read-only — these are drafts for the human to post; never imply you
replied. Note `fetchedAt`; a captured thread is a snapshot, not live — say if it may have moved on.

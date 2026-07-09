---
name: research-topic
description: Research a topic across x.com, reddit.com, and Hacker News — find matching posts and notable users, then drill into the comment threads to extract sentiment, recurring arguments, influential voices, and links. Use for topic/market research, finding key accounts or communities on a subject, monitoring discourse, or surfacing the best discussion threads about something. Reads via lucarne-corpus-mcp (read-only, browse-then-query).
---

# Research a topic: browse posts & users, drill into threads

Cast a wide net by browsing search results and community pages in-session so the corpus captures
them, query what's captured, then read the conversations. See
[socials-toolkit](../socials-toolkit/SKILL.md) for tool, browse-then-query, pagination, and
provenance rules.

## Steps

1. **Scope.** Clarify the topic, which `source`(s) matter (x for real-time chatter, reddit for
   community discussion, HN for tech), any specific subreddit (`container`), and recency vs relevance
   (`sort: "new"` vs default).
2. **Find posts:** `search(source, query, type:"posts", limit: 25)` on each relevant source. If a
   search comes back `not_captured` or thin, browse the site's own search for that query in-session
   first (a genuine search page load lets recall capture the results), then query again. Browse
   further and page with `cursor: nextCursor` over what's captured for breadth; mind `truncated`.
   Skim titles/text and `metrics` to rank by engagement and relevance.
3. **Find notable users:** `search(source, query, type:"users")` to surface accounts/redditors active
   on the topic (browse-first if not captured, same as above). For the most relevant,
   `get_profile` (credibility: followers/karma, bio, verified) and optionally
   `get_timeline(kind:"user_posts")` to gauge their angle — browsing their profile/timeline
   in-session first if the corpus doesn't have them yet.
4. **Drill into discussion:** for the highest-signal posts, `get_comments(depth: 2, limit: 30)` to
   read the thread — browse to the post and open its replies in-session if it's `not_captured`. Browse
   deeper where `truncated` and the debate is substantive — capture the strongest points on each side,
   not just the top comment.
5. **(Optional) Browse a community:** `get_timeline(reddit, kind:"hot"/"top", container)` or
   `get_timeline(hackernews, kind:"top")` to see what's currently rising — visit that list page
   in-session so it's captured before querying.

## Output

A synthesized brief:
- **Key threads** — each with a one-line takeaway and `canonicalUrl`.
- **Sentiment & themes** — recurring arguments, points of agreement/contention.
- **Notable voices** — accounts worth following, with `canonicalUrl` and why.
- **Notable links** — outbound URLs surfaced in captured posts/comments.
- **Gaps / unknowns** — what's `truncated` or still `not_captured`, and what browsing further would
  likely surface. Be explicit that this reflects what's been genuinely browsed and captured, not an
  exhaustive live search of the site.

Cite `canonicalUrl` throughout and note `fetchedAt` — this is a point-in-time capture, not a live
query. Read-only: report findings; don't act on the accounts.

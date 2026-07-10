---
name: review-profile
description: Audit a social profile (x.com, reddit.com, or Hacker News) and recommend concrete adjustments — bio, display name, avatar/banner, website/link, posting cadence, topic focus, and engagement. Use when asked to review/audit/critique/improve someone's profile, account, or online presence, or to compare an account against best practices. Reads via lucarne-corpus-mcp (read-only, browse-then-query — see socials-toolkit).
---

# Review a profile & recommend adjustments

Browse the account and its recent activity so the corpus captures it, query the captured records,
then return specific, cited recommendations. See [socials-toolkit](../socials-toolkit/SKILL.md) for
tool, browse-then-query, pagination, and provenance rules.

## Steps

1. **Query first, browse if needed.** Call `get_profile(source, handle)`. If it returns
   `status: "not_captured"`, browse to that profile page in your driven session, then call
   `get_profile` again. Capture: `displayName`, `bio`, `avatarUrl`, `bannerUrl`, `verified`, `website`,
   `location`, `createdAt`, and `metrics` (followers/following/karma/posts).
2. **Sample recent posts:** `get_timeline(source, kind:"user_posts", handle, limit: 20)`. If it's
   `not_captured` or thin, browse the account's post history in-session (scroll through recent posts)
   so recall captures more, then query again. Page once or twice with `nextCursor` over what's already
   captured if you need a fuller cadence picture. Note: post frequency, recency, topics, formats (links
   vs text vs media), and engagement (`score`, `replies`, `views`).
3. **(Optional) Sample engagement quality:** on 1–3 of their higher-engagement posts, call
   `get_comments(... limit: 10)`. If a thread hasn't been captured, browse to that post and open its
   replies in-session first. See how their audience responds and whether they reply back.
4. **Synthesize recommendations** across these dimensions, each tied to evidence:
   - **Identity:** is `bio` clear, specific, and keyword-rich? `displayName` searchable? `avatarUrl`
     present and on-brand? `website`/link set? (Flag missing avatar/bio/link explicitly.)
   - **Credibility signals:** `verified`, account age, follower/karma ratio, post volume.
   - **Cadence & consistency:** posting frequency and gaps (use `createdAt` + timeline timestamps —
     but remember gaps in the CAPTURED timeline may just mean "not browsed yet," not "didn't post";
     browse further back before concluding a cadence gap is real).
   - **Topic focus:** is there a coherent theme, or is it scattered? What resonates (top `score`)?
   - **Engagement:** ratio of replies/likes to followers; do they reply to their commenters?

## Output

A short profile snapshot (handle, key metrics, `canonicalUrl`) followed by a prioritized list of
recommendations. For each: the issue, the evidence (cite a post `canonicalUrl` + its metrics), and a
concrete suggested change. End with the 2–3 highest-impact actions. Note `fetchedAt` — metrics are a
point-in-time capture, not live. If your sample was thin because little has been browsed/captured, say
so and note what browsing further would add. You are read-only: recommend; the human applies changes.

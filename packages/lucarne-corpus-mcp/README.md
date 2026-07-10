# lucarne-corpus-mcp

An **optional**, thin, **read-only** stdio MCP bin over a `lucarne-records`
store. It exposes the reshaped `claude-socials` read surface —
`get_profile`/`get_post`/`get_comments`/`search`/`get_timeline` — as **pure
store reads**.

## Charter

This bin's boundary: it never fetches, replays a site endpoint, opens a
WebSocket bridge, drives an extension, or opens a browser. Its only I/O is:
(1) reading `records.jsonl` off disk via `lucarne-records`, and (2) stdio
JSON-RPC (MCP). See "Why this exists" below for the law this boundary serves.

## Security posture

**Read-only, no capture.** This bin cannot make anything happen on a site —
it only answers from what `lucarne-interact`'s recall has already passively
captured into the `lucarne-records` store. A miss returns a structured
`not_captured` result, never a fetch (see "Why this exists", below, for the
"behave like a user" law this serves). This posture is categorical, not
best-effort — see "Categorical no-egress law", below, whose
`test/no-egress.mjs` monkeypatches every Node socket primitive and proves
both the hit and miss paths never attempt a network call.

## Why this exists (the "behave like a user" law)

`claude-socials`' original MCP server (`mcp-server/src/tools.ts`) forwarded
every tool call to a browser-extension bridge, which could fetch a site's
GraphQL/JSON endpoints **on demand** — including popups and scroll-driven
pagination the user never asked for. The platform's categorical law
(CADENCE-SPLIT-TASKSPEC.md §1.3/§1.3a) removes every synthetic request: the
only thing that may ever be captured is what a genuine, human-paced browsing
session organically loads (`lucarne-interact`'s recall — its SCREEN sensor via
ARIA, its WIRE sensor via passive CDP `Network`-domain capture). This package
is the **read side** of that corpus: it answers from what has already been
captured, and when nothing matches, it says so structurally instead of
reaching for the network.

**A query miss is never a network call.** It returns a `not_captured` result:

```jsonc
{
  "status": "not_captured",
  "message": "Not captured yet: a x profile for handle \"someone\".",
  "hint": "This corpus is read-only and never fetches. Browse to it in-session — recall captures passively while a human/agent genuinely browses — then query again. Visit the profile page for \"someone\" on x in a driven session.",
  "query": { "op": "get_profile", "source": "x", "handle": "someone" }
}
```

## The five tools

Same names/args as `claude-socials/packages/mcp-server/src/tools.ts`'s five
data tools, now mapped onto LS-03's `getRecord`/`queryRecords` (`lucarne-records`):

| Tool | Args | `lucarne-records` mapping |
| --- | --- | --- |
| `get_profile` | `source, handle` | `getRecord(dir, { source, kind:'profile', id: handle })` |
| `get_post` | `source, idOrUrl` | `getRecord(dir, { source, kind:'post', id: idOrUrl })` |
| `get_comments` | `source, postIdOrUrl, depth?, limit?, cursor?` | `queryRecords(dir, { op:'comments', source, postIdOrUrl, limit, cursor })`, then `depth` post-filters the returned page (`Comment.depth <= depth`) |
| `search` | `source, query, type?, container?, limit?, sort?, cursor?` | `queryRecords(dir, { op:'search', ... })` |
| `get_timeline` | `source, kind, handle?, container?, limit?, cursor?, sort?` | `queryRecords(dir, { op:'timeline', ... })` |

`getRecord`/`queryRecords` never throw on a miss — `queries.ts` turns an
`undefined`/empty-`Page` result into the structured `not_captured` shape
above. `Page<T>`'s `truncated`/`nextCursor` semantics are unchanged from
`lucarne-records` (see that package's README): `truncated:true` still means
"more MAY exist" — here specifically, "more may exist that just hasn't been
browsed-and-captured yet," not "more exists on the site and we chose not to
fetch it."

## Dropped: the three bridge-diagnostic tools

`x_debug`, `reload_extension`, and `bridge_status`
(`claude-socials/packages/mcp-server/src/tools.ts:207-246`) diagnosed a
WebSocket bridge to a browser extension. That bridge does not exist in this
design (§1.3a: CDP `Network`-domain capture on a session `lucarne` already
owns supersedes it) — there is nothing left for these tools to diagnose, so
they are not ported.

## Config: `LUCARNE_CORPUS_STORE_DIR` (+ the `CLAUDE_SOCIALS_PORT` → `LUCARNE_CORPUS_PORT` back-compat alias)

`claude-socials`' MCP server was configured by `CLAUDE_SOCIALS_PORT` — the
port its extension-bridge WebSocket server listened on. That bridge is gone,
so a port is no longer the thing to configure: the genuinely-configured input
here is **where the store lives**.

- **`LUCARNE_CORPUS_STORE_DIR`** — path to the `lucarne-records` store
  directory to read (default `.lucarne/corpus`, resolved relative to the
  process cwd). This is the functional config surface.
- **`LUCARNE_CORPUS_PORT`** — the renamed `CLAUDE_SOCIALS_PORT`. Kept as an
  **inert** back-compat surface only: this bin opens no socket, so a port has
  no functional effect. Setting it is harmless (echoed in the startup
  banner); it does not error.
- **`CLAUDE_SOCIALS_PORT`** (deprecated) — still read as a fallback for
  `LUCARNE_CORPUS_PORT` so an old environment doesn't break, but using it
  prints a deprecation warning to stderr on startup pointing at
  `LUCARNE_CORPUS_PORT` (and clarifying that neither name is dialed anymore).

See `src/config.ts` for the exact resolution order and `test/config.mjs` for
the back-compat + deprecation-warning proof.

## Categorical no-egress law

```
grep -REn "fetch\(|WebSocket|ws\b|chrome\.|activeFetch|startScreencast" src
```

returns 0 hits. The package's only I/O is a `lucarne-records` disk read +
stdio MCP transport. `test/no-egress.mjs` monkeypatches `node:net`/`node:http`/
`node:https`/`node:dgram` to throw on any connection attempt, then drives all
five tools against queries with no matching capture — proving the miss path
(`not_captured`) never touches the network layer at all.

## The four operating skills (moved here)

`socials-toolkit`, `review-profile`, `recommend-replies`, `research-topic`
moved from `claude-socials/.claude/skills/*` to this repo's
`.claude/skills/*`, reworded from *tool-fetches* to *browse-then-query*: they
no longer imply the MCP fetches on demand (dropped the `bridge_status`
first-step and the "extension not connected" troubleshooting), and instead
instruct browsing the target in a driven session first so recall captures it,
then querying this corpus. `.claude/skills/**` is a human-required review path
(`standards/risk-and-review.md`) — flagged, not auto-approved by this change.

## Build / test

```
npm run build       # tsc -b
npm run typecheck   # tsc --noEmit
npm test            # build, then the committed .mjs proofs in test/
```

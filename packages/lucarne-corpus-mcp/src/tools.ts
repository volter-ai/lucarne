/**
 * MCP tool registration — the reshaped `claude-socials/packages/mcp-server/src/tools.ts`.
 *
 * Same five tool names/args as the original (`get_profile`/`get_post`/
 * `get_comments`/`search`/`get_timeline`) so the four operating skills that
 * move alongside this package (`.claude/skills/{socials-toolkit,review-profile,
 * recommend-replies,research-topic}`) barely change their tool-call shape —
 * only their MENTAL MODEL changes (query-a-store, not fetch-a-site). Each
 * handler is a synchronous call into `queries.ts`, which is a synchronous
 * `lucarne-records` disk read — there is no `await bridge.request(...)`
 * anywhere in this file, because there is no bridge.
 *
 * The three bridge-diagnostic tools from the original (`x_debug`,
 * `reload_extension`, `bridge_status`, `tools.ts:207-246`) are dropped: they
 * diagnosed a socket-based bridge to a browser extension that does not exist
 * in this design (the split spec's §1.3a).
 *
 * LS-29 (generalize-records): `lucarne-records` no longer closes the source set — this bin can query
 * ANY corpus a sensor writes into, not just a fixed list of named sites. `sourceSchema` below is now
 * an open, non-empty string; the five tool DESCRIPTIONS are de-domained (no site names hard-coded)
 * while keeping every load-bearing promise verbatim: read-only, NEVER fetches, browse-in-session,
 * pagination shape, and the `not_captured` contract.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as queries from "./queries.js";

const sourceSchema = z
  .string()
  .min(1)
  .describe("The source namespace to query — the value a sensor wrote as each record's `provenance.source`. Any non-empty namespace a sensor captures into is valid.");

const sortSchema = z
  .enum(["top", "new", "best", "controversial", "relevance"])
  .describe("Sort order. Not every value is meaningful for every site.");

/** Wrap a result (captured data OR a structured not_captured miss) as MCP tool content. */
function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return `lucarne-corpus-mcp error: ${(e as { message: string }).message}`;
  return `lucarne-corpus-mcp error: ${String(e)}`;
}

/**
 * Register the five read-only query tools against a `lucarne-records` store
 * at `storeDir`. `storeDir` is captured once at registration time — every
 * handler is a pure read of whatever `storeDir` currently holds on disk (the
 * recorder process may still be appending to it concurrently; see
 * `lucarne-records/store.ts`'s single-writer/many-readers concurrency model).
 */
export function registerTools(server: McpServer, storeDir: string): void {
  server.registerTool(
    "get_profile",
    {
      description:
        "Read a captured user/account profile, from whichever source you specify, out of " +
        "the local corpus. NEVER fetches — this is a query over what recall has already captured " +
        "during genuine browsing. Returns the handle, bio, metrics (whatever the source normalizes), " +
        "and structural provenance (canonicalUrl + fetchedAt). If the profile hasn't been captured " +
        "yet, returns a `not_captured` result telling you to browse to it in-session first.",
      inputSchema: {
        source: sourceSchema,
        handle: z.string().describe("Account handle WITHOUT a leading sigil (e.g. no '@' or 'u/'). e.g. 'paulg', 'patio11'."),
      },
    },
    async ({ source, handle }) => {
      try {
        return ok(queries.getProfile(storeDir, { source, handle }));
      } catch (e) {
        return fail(errorMessage(e));
      }
    },
  );

  server.registerTool(
    "get_post",
    {
      description:
        "Read a captured post (whatever a source's own top-level item is — a status update, a forum " +
        "submission, a story, …) by id or URL out of the local corpus. NEVER fetches. Returns " +
        "title/text, author reference, engagement metrics, its container, and provenance. If it " +
        "hasn't been captured yet, returns a `not_captured` result telling you to browse to it " +
        "in-session first.",
      inputSchema: {
        source: sourceSchema,
        idOrUrl: z.string().describe("Native post id OR a full canonical URL to the post. Both are accepted."),
      },
    },
    async ({ source, idOrUrl }) => {
      try {
        return ok(queries.getPost(storeDir, { source, idOrUrl }));
      } catch (e) {
        return fail(errorMessage(e));
      }
    },
  );

  server.registerTool(
    "get_comments",
    {
      description:
        "Read the captured comment/reply tree under a post out of the local corpus. NEVER fetches. " +
        "Each comment carries its author, text, score, parentUrl, threadRootUrl, nesting depth, and " +
        "provenance. PAGINATED: returns { items, nextCursor?, truncated }. truncated:true means more " +
        "comments MAY exist beyond what was captured — DO NOT treat the result as the complete thread. " +
        "Pass nextCursor back as 'cursor' for the next page. If nothing under this post has been " +
        "captured yet, returns a `not_captured` result telling you to browse to the thread first.",
      inputSchema: {
        source: sourceSchema,
        postIdOrUrl: z.string().describe("Native post id OR full URL whose comments you want."),
        depth: z
          .number()
          .int()
          .min(0)
          .max(10)
          .optional()
          .describe("Max nesting depth to return (post-filters the captured page). 0 = top-level replies only."),
        limit: z.number().int().min(1).max(500).optional().describe("Max comments per page. Default 50."),
        cursor: z.string().optional().describe("Opaque cursor from a previous page's nextCursor to continue the thread."),
      },
    },
    async ({ source, postIdOrUrl, depth, limit, cursor }) => {
      try {
        return ok(queries.getComments(storeDir, { source, postIdOrUrl, depth, limit: limit ?? 50, cursor }));
      } catch (e) {
        return fail(errorMessage(e));
      }
    },
  );

  server.registerTool(
    "search",
    {
      description:
        "Free-text search over what's been captured so far, returning matches with provenance. NEVER " +
        "fetches or issues a site search request — it filters the local corpus. type='posts' (default) " +
        "matches posts; type='users' matches profiles. PAGINATED: returns { items, nextCursor?, " +
        "truncated }. If nothing captured matches, returns a `not_captured` result suggesting where to " +
        "browse so matching content gets captured.",
      inputSchema: {
        source: sourceSchema,
        query: z.string().describe("Free-text search query, matched against captured text/title/bio/handle."),
        type: z.enum(["posts", "users"]).optional().describe("'posts' (default) returns posts; 'users' returns profiles."),
        container: z.string().optional().describe("Restrict to a named container (e.g. a forum board) when the source has one — no leading sigil."),
        limit: z.number().int().min(1).max(100).optional().describe("Max results per page. Default 25."),
        sort: sortSchema.optional(),
        cursor: z.string().optional().describe("Opaque cursor from a previous page's nextCursor to continue."),
      },
    },
    async ({ source, query, type, container, limit, sort, cursor }) => {
      try {
        return ok(queries.search(storeDir, { source, query, type: type ?? "posts", container, limit: limit ?? 25, sort, cursor }));
      } catch (e) {
        return fail(errorMessage(e));
      }
    },
  );

  server.registerTool(
    "get_timeline",
    {
      description:
        "Read a captured list of posts out of the local corpus: a user's own posts " +
        "(kind='user_posts', needs 'handle'), or a named source list (some sources need 'container'; " +
        "others need nothing else). NEVER fetches or scrolls to load more — it returns whatever has " +
        "been captured so far. PAGINATED: returns { items, nextCursor?, truncated }. If nothing has " +
        "been captured for this list yet, returns a `not_captured` result telling you to browse it " +
        "in-session first.",
      inputSchema: {
        source: sourceSchema,
        kind: z
          .enum(["user_posts", "hot", "new", "top", "best", "ask", "show"])
          .describe("Which list. 'user_posts' needs handle; some source lists need container."),
        handle: z.string().optional().describe("Account handle for kind='user_posts' (no leading sigil)."),
        container: z.string().optional().describe("Named container for a source list that has one (no leading sigil)."),
        limit: z.number().int().min(1).max(100).optional().describe("Max items per page. Default 25."),
        cursor: z.string().optional().describe("Opaque cursor from a previous page's nextCursor."),
        sort: sortSchema.optional(),
      },
    },
    async ({ source, kind, handle, container, limit, cursor, sort }) => {
      try {
        return ok(queries.getTimeline(storeDir, { source, kind, handle, container, limit: limit ?? 25, cursor, sort }));
      } catch (e) {
        return fail(errorMessage(e));
      }
    },
  );
}

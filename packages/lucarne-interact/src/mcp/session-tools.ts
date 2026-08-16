/**
 * The SESSION-LIFECYCLE half of the one platform MCP: mint, list, and destroy lucarne sessions so
 * an agent can get a `cdpUrl` to hand the interact verbs.
 *
 * This talks to a running lucarne daemon over its HTTP API with plain `fetch` — the endpoint
 * contract (`POST /sessions`, `GET /sessions`, `DELETE /sessions/:id`, bearer token) is ported from
 * the engine's own typed client. It deliberately does NOT import the `lucarne` package: this
 * package depends on no lucarne package at all, and a session is reachable over HTTP from anywhere,
 * so a code dependency would buy nothing but coupling.
 *
 * These tools are absent entirely in corpus-only mode (see config.ts) — that mode performs zero
 * network egress, and minting a session is egress by definition.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Where the daemon lives when `LUCARNE_URL` is unset — the engine's own default listen address. */
export const DEFAULT_LUCARNE_URL = "http://127.0.0.1:7800";

export interface SessionToolsOptions {
  /** Daemon base URL. Defaults to `LUCARNE_URL`, else `http://127.0.0.1:7800`. */
  baseUrl?: string;
  /** Bearer token for the daemon, if it requires one. Defaults to `LUCARNE_TOKEN`. */
  token?: string;
  /** Injected `fetch` (tests pass a fake; production uses the global). */
  fetchImpl?: typeof fetch;
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

/** One request against the daemon — the same shape the engine's typed client uses. */
async function req(
  opts: Required<Pick<SessionToolsOptions, "baseUrl">> & { token?: string; fetchImpl: typeof fetch },
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const res = await opts.fetchImpl(opts.baseUrl + path, {
    method,
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`lucarne ${method} ${path} -> ${res.status}`);
  const ct = res.headers.get("content-type") ?? "";
  return ct.includes("application/json") ? res.json() : res.text();
}

export function registerSessionTools(server: McpServer, opts: SessionToolsOptions = {}): void {
  const wire = {
    baseUrl: (opts.baseUrl ?? process.env.LUCARNE_URL ?? DEFAULT_LUCARNE_URL).replace(/\/$/, ""),
    token: opts.token ?? process.env.LUCARNE_TOKEN,
    fetchImpl: opts.fetchImpl ?? fetch,
  };

  const call = async (method: string, path: string, body?: unknown) => {
    try {
      return ok(await req(wire, method, path, body));
    } catch (e) {
      return fail(
        `lucarne-mcp error: ${(e as Error)?.message ?? String(e)} — is a lucarne daemon running at ${wire.baseUrl}? ` +
          "(start one with `lucarne serve`, or point LUCARNE_URL at an existing one)",
      );
    }
  };

  server.registerTool(
    "lucarne_create",
    {
      description:
        "Create a browser session on the lucarne daemon and return it — including the `cdpUrl` " +
        "every interact verb takes, and the `viewUrl` a human can watch it through. The session " +
        "outlives this agent: it lives in the daemon, not in this process.",
      inputSchema: {
        profile: z.string().optional().describe("Named browser profile to run in (persisted cookies/logins). Omit for the default."),
        backend: z.enum(["native", "docker"]).optional().describe("Which backend mints the browser. Omit for the daemon's default."),
      },
    },
    async ({ profile, backend }) =>
      call("POST", "/sessions", {
        ...(profile !== undefined ? { profile } : {}),
        ...(backend !== undefined ? { backend } : {}),
      }),
  );

  server.registerTool(
    "lucarne_list",
    {
      description: "List the daemon's active sessions (id, cdpUrl, viewUrl, status) — how you find a session you or a human already opened.",
      inputSchema: {},
    },
    async () => call("GET", "/sessions"),
  );

  server.registerTool(
    "lucarne_destroy",
    {
      description: "Destroy one session by id. The browser and its window go away; anything you wanted from it must already be captured.",
      inputSchema: {
        id: z.string().min(1).describe("The session id to destroy."),
      },
    },
    async ({ id }) => call("DELETE", `/sessions/${encodeURIComponent(id)}`),
  );
}

/** The tool names this module registers — the reviewed allowlist `test/mcp-charter-gate.mjs` pins. */
export const SESSION_TOOL_NAMES = ["lucarne_create", "lucarne_list", "lucarne_destroy"] as const;

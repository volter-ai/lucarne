// The session-lifecycle tools' WIRE CONTRACT, driven over the real MCP call path with an injected
// `fetch` — no daemon, no browser, no network.
//
// These three tools are the one place this package talks to a lucarne daemon, and they do it with
// plain `fetch` rather than a dependency on the engine package. What must hold is the endpoint
// contract ported from the engine's own typed client: `POST /sessions` (create), `GET /sessions`
// (list), `DELETE /sessions/:id` (destroy), each with a bearer token when one is configured.
//
// Run with `node test/mcp-session-tools.mjs` (after `npm run build`).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerSessionTools, DEFAULT_LUCARNE_URL } from "../dist/mcp/session-tools.js";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

/** A fake `fetch` that records every call and answers with a canned JSON body. */
function recordingFetch(body) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers ?? {}, body: init.body });
    return {
      ok: true,
      status: 200,
      headers: { get: (k) => (k.toLowerCase() === "content-type" ? "application/json" : null) },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  return { calls, impl };
}

async function connect(opts) {
  const server = new McpServer({ name: "lucarne-mcp-session-test", version: "0.0.0" });
  registerSessionTools(server, opts);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "session-tools-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

check("the daemon default matches the engine's own listen address", DEFAULT_LUCARNE_URL === "http://127.0.0.1:7800");

// ── create ────────────────────────────────────────────────────────────────
{
  const { calls, impl } = recordingFetch({ id: "s1", cdpUrl: "ws://127.0.0.1:9222/x", viewUrl: "http://127.0.0.1:7800/view/s1" });
  const { client } = await connect({ baseUrl: "http://127.0.0.1:7800/", token: "sekrit", fetchImpl: impl });
  const res = await client.callTool({ name: "lucarne_create", arguments: { profile: "work", backend: "native" } });
  const data = JSON.parse(res.content[0].text);
  check("lucarne_create: POSTs /sessions", calls.length === 1 && calls[0].method === "POST" && calls[0].url === "http://127.0.0.1:7800/sessions", JSON.stringify(calls[0]));
  check("lucarne_create: sends the profile/backend options as a JSON body", calls[0].body === JSON.stringify({ profile: "work", backend: "native" }), String(calls[0].body));
  check("lucarne_create: carries the bearer token", calls[0].headers.authorization === "Bearer sekrit", JSON.stringify(calls[0].headers));
  check("lucarne_create: returns the session, cdpUrl included (that is what the interact verbs take)", data.id === "s1" && data.cdpUrl === "ws://127.0.0.1:9222/x");
  await client.close().catch(() => {});
}

// ── create with no options: no undefined keys leak into the body ──────────
{
  const { calls, impl } = recordingFetch({ id: "s2", cdpUrl: "ws://x" });
  const { client } = await connect({ baseUrl: "http://127.0.0.1:7800", fetchImpl: impl });
  await client.callTool({ name: "lucarne_create", arguments: {} });
  check("lucarne_create (no args): sends an empty options object, not undefined-valued keys", calls[0].body === "{}", String(calls[0].body));
  check("lucarne_create (no token configured): sends no authorization header", calls[0].headers.authorization === undefined, JSON.stringify(calls[0].headers));
  await client.close().catch(() => {});
}

// ── list ──────────────────────────────────────────────────────────────────
{
  const { calls, impl } = recordingFetch([{ id: "s1" }, { id: "s2" }]);
  const { client } = await connect({ baseUrl: "http://127.0.0.1:7800", fetchImpl: impl });
  const res = await client.callTool({ name: "lucarne_list", arguments: {} });
  const data = JSON.parse(res.content[0].text);
  check("lucarne_list: GETs /sessions", calls[0].method === "GET" && calls[0].url === "http://127.0.0.1:7800/sessions");
  check("lucarne_list: returns the daemon's session array", Array.isArray(data) && data.length === 2);
  await client.close().catch(() => {});
}

// ── destroy ───────────────────────────────────────────────────────────────
{
  const { calls, impl } = recordingFetch({ ok: true });
  const { client } = await connect({ baseUrl: "http://127.0.0.1:7800", fetchImpl: impl });
  await client.callTool({ name: "lucarne_destroy", arguments: { id: "s 1/odd" } });
  check("lucarne_destroy: DELETEs /sessions/:id with the id URL-encoded", calls[0].method === "DELETE" && calls[0].url === `http://127.0.0.1:7800/sessions/${encodeURIComponent("s 1/odd")}`, calls[0].url);
  await client.close().catch(() => {});
}

// ── a dead daemon is a tool error with a pointer, never a transport crash ──
{
  const impl = async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:7800");
  };
  const { client } = await connect({ baseUrl: "http://127.0.0.1:7800", fetchImpl: impl });
  const res = await client.callTool({ name: "lucarne_list", arguments: {} });
  check("a daemon that isn't running yields an MCP tool error, not an unhandled rejection", res.isError === true);
  check("the error names the URL it tried and how to start one", /127\.0\.0\.1:7800/.test(res.content[0].text) && /lucarne serve/.test(res.content[0].text), res.content[0].text);
  await client.close().catch(() => {});
}

// ── an HTTP error status is surfaced, not swallowed ───────────────────────
{
  const impl = async () => ({ ok: false, status: 401, headers: { get: () => "application/json" }, json: async () => ({}), text: async () => "" });
  const { client } = await connect({ baseUrl: "http://127.0.0.1:7800", fetchImpl: impl });
  const res = await client.callTool({ name: "lucarne_list", arguments: {} });
  check("a non-ok HTTP status becomes a tool error carrying the status", res.isError === true && /401/.test(res.content[0].text), res.content[0].text);
  await client.close().catch(() => {});
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

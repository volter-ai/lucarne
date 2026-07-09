// LS-06 dev/02 — drive the actual MCP tool surface (not just the underlying
// query functions): a real McpServer with registerTools() wired to a seeded
// store, talked to over an in-process MCP Client via InMemoryTransport
// (the SDK's own test transport — no stdio process, no socket). Proves the
// five tools are correctly registered/callable through the real MCP
// request/response path and that the x_debug/reload_extension/bridge_status
// bridge-diagnostic tools are NOT present.
//
// Run with `node test/mcp-tools.mjs` (after `npm run build`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { appendRecords } from "lucarne-records";
import { registerTools } from "../dist/tools.js";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-corpus-mcp-e2e-test-"));
const prov = (id, over = {}) => ({
  source: "x",
  id,
  canonicalUrl: `https://x.com/i/status/${id}`,
  fetchedAt: "2026-07-08T12:00:00.000Z",
  via: "internal-api",
  ...over,
});
appendRecords(DIR, [
  {
    kind: "profile",
    provenance: prov("u_grace", { canonicalUrl: "https://x.com/grace" }),
    handle: "grace",
    displayName: "Grace Hopper",
    bio: "Compiler pioneer.",
    metrics: { followers: 4200 },
  },
  {
    kind: "post",
    provenance: prov("7001", { canonicalUrl: "https://x.com/grace/status/7001" }),
    author: { handle: "grace", profileUrl: "https://x.com/grace" },
    text: "it's easier to ask forgiveness than permission",
    metrics: { score: 99 },
  },
]);

const server = new McpServer({ name: "lucarne-corpus-mcp-test", version: "0.1.0" });
registerTools(server, DIR);

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "test-client", version: "0.1.0" });

await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

// ── tools/list: exactly the five reshaped tools, none of the dropped three ──
{
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  check(
    "tools/list: exactly the five reshaped tools are registered",
    JSON.stringify(names) === JSON.stringify(["get_comments", "get_post", "get_profile", "get_timeline", "search"]),
    JSON.stringify(names),
  );
  check("tools/list: x_debug is NOT registered (bridge diagnostic, dropped)", !names.includes("x_debug"));
  check("tools/list: reload_extension is NOT registered (bridge diagnostic, dropped)", !names.includes("reload_extension"));
  check("tools/list: bridge_status is NOT registered (bridge diagnostic, dropped)", !names.includes("bridge_status"));
}

function parse(result) {
  return JSON.parse(result.content[0].text);
}

// ── get_profile over the real MCP call path: hit ──────────────────────────
{
  const result = await client.callTool({ name: "get_profile", arguments: { source: "x", handle: "grace" } });
  const data = parse(result);
  check("get_profile via MCP: status ok", data.status === "ok");
  check("get_profile via MCP: seeded profile with provenance", data.status === "ok" && data.data.handle === "grace" && data.data.provenance.canonicalUrl === "https://x.com/grace");
}

// ── get_profile over the real MCP call path: miss -> not_captured ─────────
{
  const result = await client.callTool({ name: "get_profile", arguments: { source: "x", handle: "totally-unbrowsed" } });
  const data = parse(result);
  check("get_profile via MCP (miss): status not_captured", data.status === "not_captured");
  check("get_profile via MCP (miss): not an MCP-level error (isError unset)", !result.isError);
  check("get_profile via MCP (miss): hint says to browse", /browse/i.test(data.hint));
}

// ── get_post via MCP ───────────────────────────────────────────────────────
{
  const result = await client.callTool({ name: "get_post", arguments: { source: "x", idOrUrl: "https://x.com/grace/status/7001" } });
  const data = parse(result);
  check("get_post via MCP: resolves a captured post by canonical URL", data.status === "ok" && data.data.provenance.id === "7001");
}

// ── search via MCP ─────────────────────────────────────────────────────────
{
  const result = await client.callTool({ name: "search", arguments: { source: "x", query: "forgiveness" } });
  const data = parse(result);
  check("search via MCP: finds the captured post", data.status === "ok" && data.data.items.length === 1);
}

// ── get_timeline via MCP ───────────────────────────────────────────────────
{
  const result = await client.callTool({ name: "get_timeline", arguments: { source: "x", kind: "user_posts", handle: "grace" } });
  const data = parse(result);
  check("get_timeline via MCP: returns grace's captured post", data.status === "ok" && data.data.items.length === 1 && data.data.items[0].author.handle === "grace");
}

// ── get_comments via MCP: nothing captured -> not_captured ────────────────
{
  const result = await client.callTool({ name: "get_comments", arguments: { source: "x", postIdOrUrl: "7001" } });
  const data = parse(result);
  check("get_comments via MCP (nothing captured under this post): not_captured", data.status === "not_captured");
}

await client.close();
await server.close();
fs.rmSync(DIR, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

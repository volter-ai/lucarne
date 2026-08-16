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
import { appendRecords } from "../dist/records/index.js";
import { registerCorpusTools } from "../dist/mcp/corpus/tools.js";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-e2e-test-"));
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

const server = new McpServer({ name: "mcp-test", version: "0.1.0" });
registerCorpusTools(server, DIR);

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

// ── LS-29 (generalize-records) — the OPEN-SOURCE proof: an arbitrary, non-social source ("github")
// against an EMPTY store returns a structured `not_captured` result, NOT a zod validation error —
// proving `sourceSchema` genuinely accepts any non-empty string, not just the old closed enum. ──
{
  const result = await client.callTool({ name: "get_post", arguments: { source: "github", idOrUrl: "volter-ai/lucarne#42" } });
  check("get_post via MCP: an arbitrary source ('github') is NOT rejected by the tool's zod schema", !result.isError, JSON.stringify(result));
  const data = parse(result);
  check("get_post via MCP: source:'github' on an empty store returns not_captured (a genuine miss), not a schema error", data.status === "not_captured", JSON.stringify(data));
  check("get_post via MCP: the not_captured result still carries a browse hint for the arbitrary source", /browse/i.test(data.hint) && data.query.source === "github");
}

// ── LS-34 (corpus-mcp-open) — the OPEN-KIND/SORT proof: `get_timeline`'s `kind` and `sort` args
// used to be closed `z.enum([...])`s carrying social-domain literals (Reddit's 'hot'/'controversial',
// HN's 'ask'/'show'). They are now open strings — an UNKNOWN kind/sort must be accepted by the MCP
// tool's zod schema (never a validation error) and handled gracefully by the query layer underneath
// (capture-order fallback / a genuine not_captured miss), exactly like an unrecognized value from any
// other still-supported source would be. ──

// unknown kind, on an empty/foreign source -> not_captured (a genuine miss), not a zod error.
{
  const result = await client.callTool({ name: "get_timeline", arguments: { source: "github", kind: "github-issues" } });
  check("get_timeline via MCP: an unrecognized kind ('github-issues') is NOT rejected by the tool's zod schema", !result.isError, JSON.stringify(result));
  const data = parse(result);
  check("get_timeline via MCP: unrecognized kind on an empty/foreign source returns not_captured, not a schema error", data.status === "not_captured", JSON.stringify(data));
  check("get_timeline via MCP: the not_captured result echoes the unrecognized kind and still carries a browse hint", /browse/i.test(data.hint) && data.query.kind === "github-issues" && data.query.source === "github");
}

// unknown kind AND unknown sort together, still on an empty/foreign source -> same not_captured shape.
{
  const result = await client.callTool({
    name: "get_timeline",
    arguments: { source: "github", kind: "user_posts", handle: "octocat", sort: "most-reactions" },
  });
  check("get_timeline via MCP: an unrecognized sort ('most-reactions') is NOT rejected by the tool's zod schema", !result.isError, JSON.stringify(result));
  const data = parse(result);
  check("get_timeline via MCP: unrecognized sort on an empty/foreign source returns not_captured, not a schema error", data.status === "not_captured", JSON.stringify(data));
}

// LS-37 (read-kinds generalize): `kind` used to be silently coerced to the social "post" for ANY
// unrecognized value (the exact hardcoding this issue removes) — a LITERAL match against a populated
// source still returns ok, capture-order items, but now HONESTLY: because that literal kind was
// actually captured, not because the query layer assumed it.
{
  const result = await client.callTool({ name: "get_timeline", arguments: { source: "x", kind: "post" } });
  check("get_timeline via MCP: kind:'post' against a populated source is NOT rejected by the tool's zod schema", !result.isError, JSON.stringify(result));
  const data = parse(result);
  check(
    "get_timeline via MCP: kind:'post' against a populated source returns ok, capture-order items for that literal kind",
    data.status === "ok" && data.data.items.length === 1 && data.data.items[0].provenance.id === "7001",
    JSON.stringify(data),
  );
}

// A kind that matches NOTHING actually captured (the store here only has "profile"/"post") is now a
// genuine miss — LS-37 removed the "unrecognized kind silently falls back to posts" residue this
// exact scenario used to hit (pre-fix, this literal string wrongly returned the captured post anyway).
{
  const result = await client.callTool({ name: "get_timeline", arguments: { source: "x", kind: "totally-unenumerated-list-name" } });
  check("get_timeline via MCP: an unrecognized kind against a populated source is NOT rejected by the tool's zod schema", !result.isError, JSON.stringify(result));
  const data = parse(result);
  check(
    "get_timeline via MCP: an unrecognized kind now returns a genuine not_captured — LS-37 removed the silent 'assume post' fallback this used to hit",
    data.status === "not_captured",
    JSON.stringify(data),
  );
}

// ── LS-37 (read-kinds generalize) — THE CORPUS-MCP-LEVEL PROOF: a non-social kind ("issue") reaches
// its data through the REAL MCP tool call path (search + get_timeline), status:"ok", not not_captured
// — not just through the underlying the records store/queries.ts functions directly.
{
  appendRecords(DIR, [
    {
      kind: "issue",
      provenance: {
        source: "github",
        id: "acme/widget#3",
        canonicalUrl: "https://github.com/acme/widget/issues/3",
        fetchedAt: "2026-07-08T12:30:00.000Z",
        via: "internal-api",
      },
      text: "the widget flickers on first paint",
      metrics: { comments: 0 },
    },
  ]);

  const tlResult = await client.callTool({ name: "get_timeline", arguments: { source: "github", kind: "issue" } });
  const tlData = parse(tlResult);
  check(
    "LS-37 get_timeline via MCP (kind:'issue'): a non-social kind returns status:ok, NOT not_captured",
    tlData.status === "ok" && tlData.data.items.length === 1 && tlData.data.items[0].provenance.id === "acme/widget#3",
    JSON.stringify(tlData),
  );

  const searchResult = await client.callTool({ name: "search", arguments: { source: "github", query: "flickers", kind: "issue" } });
  const searchData = parse(searchResult);
  check(
    "LS-37 search via MCP (kind:'issue'): a non-social kind is found by text search, status:ok, NOT not_captured",
    searchData.status === "ok" && searchData.data.items.length === 1 && searchData.data.items[0].kind === "issue",
    JSON.stringify(searchData),
  );
}

await client.close();
await server.close();
fs.rmSync(DIR, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

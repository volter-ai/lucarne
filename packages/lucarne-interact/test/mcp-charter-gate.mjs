// The MCP CHARTER gate — the tool-surface half of this package's anti-bot tier property.
//
// `session.ts`'s law ("there is intentionally NO click, NO goto, NO eval on this class — if a
// bot-like action isn't one of the verbs, it physically cannot be issued") only holds at the agent
// boundary if the MCP server that FRONTS those verbs can't reintroduce them. This gate reads the
// live tool registry of the fully-wired server (all three groups) over the real MCP request path
// and asserts:
//
//   1. no registered tool name carries a banned verb (click/goto/eval/navigate/press/mouse/act/
//      content/html) — the raw computer-use plane is reachable over the engine's HTTP API, never
//      as a tool here;
//   2. the registered set is EXACTLY the reviewed allowlist — a new tool has to be added here
//      deliberately, so "one more little verb" can't land unnoticed;
//   3. `type` and `send` both exist, and are distinct — staging and submitting stay separate
//      operations, which is what makes the send gate a gate at all.
//
// NON-VACUOUS: before checking the real registry, the detector is run against a throwaway server
// with a `lucarne_click_probe` tool planted on it, and must catch it. A gate that only ever reports "0
// banned names" is indistinguishable from a gate whose regexes never match anything.
//
// Run with `node test/mcp-charter-gate.mjs` (after `npm run build`).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerCorpusTools } from "../dist/mcp/corpus/tools.js";
import { registerInteractTools, INTERACT_TOOL_NAMES } from "../dist/mcp/interact-tools.js";
import { registerSessionTools, SESSION_TOOL_NAMES } from "../dist/mcp/session-tools.js";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// A bot-like action this server may never expose as a tool, whatever it is called. `act`/`content`
// are here because they are the two raw computer-use tools this platform deliberately retired from
// its agent surface (coordinate clicks and a rendered-HTML dump).
const BANNED_VERB = /(^|_)(click|goto|go|eval|navigate|press|mouse|keypress|act|content|html|dom|querySelector)(_|$)/i;

const CORPUS_TOOL_NAMES = ["get_comments", "get_post", "get_profile", "get_timeline", "search"];
const EXPECTED = [...CORPUS_TOOL_NAMES, ...INTERACT_TOOL_NAMES, ...SESSION_TOOL_NAMES].sort();

/** The registered tool names, read over the real MCP request path (not from a source-text scan). */
async function toolNamesOf(register) {
  const server = new McpServer({ name: "lucarne-mcp-charter-test", version: "0.0.0" });
  register(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "charter-gate", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close().catch(() => {});
  await server.close().catch(() => {});
  return tools.map((t) => t.name).sort();
}

// ── non-vacuity: the detector must catch a planted banned tool ────────────
{
  const planted = await toolNamesOf((server) => {
    registerInteractTools(server, { env: {} });
    server.registerTool(
      "lucarne_click_probe",
      { description: "planted for the self-test", inputSchema: { x: z.number(), y: z.number() } },
      async () => ({ content: [{ type: "text", text: "planted" }] }),
    );
  });
  const caught = planted.filter((n) => BANNED_VERB.test(n));
  check("non-vacuity: a planted click tool IS caught by the banned-verb detector", caught.includes("lucarne_click_probe"), JSON.stringify(caught));
  check("non-vacuity: the allowlist comparison also rejects the planted server", JSON.stringify(planted) !== JSON.stringify(EXPECTED));
}

// ── the real, fully-wired server ──────────────────────────────────────────
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-charter-gate-"));
const names = await toolNamesOf((server) => {
  registerCorpusTools(server, STORE);
  registerInteractTools(server, { env: {} });
  registerSessionTools(server, { baseUrl: "http://127.0.0.1:7800", fetchImpl: async () => { throw new Error("the charter gate never dials"); } });
});
fs.rmSync(STORE, { recursive: true, force: true });

check(`the fully-wired server registers tools at all (found ${names.length})`, names.length > 0);

const offenders = names.filter((n) => BANNED_VERB.test(n));
check(
  "CHARTER: no click / goto / eval / navigate / act / content tool exists on the MCP surface",
  offenders.length === 0,
  offenders.join(", "),
);

check(
  "the registered tool set is EXACTLY the reviewed allowlist (a new tool must be added here on purpose)",
  JSON.stringify(names) === JSON.stringify(EXPECTED),
  `registered=${JSON.stringify(names)}\n    expected=${JSON.stringify(EXPECTED)}`,
);

check("`lucarne_type` (stage) and `lucarne_send` (submit) both exist and are distinct tools", names.includes("lucarne_type") && names.includes("lucarne_send"));

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

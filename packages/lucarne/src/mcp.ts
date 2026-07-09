#!/usr/bin/env node
import readline from "node:readline";
import { LucarneClient } from "./client.js";
import { VERSION } from "./version.js";

/**
 * A stdio MCP server exposing lucarne as agent tools — mint/list/drive/watch a
 * browser session from any MCP client. Newline-delimited JSON-RPC 2.0 over
 * stdin/stdout (the MCP stdio transport). It talks to a running daemon via
 * LucarneClient (LUCARNE_URL / LUCARNE_TOKEN), so the session outlives the agent.
 */
const TOOLS = [
  { name: "lucarne_create", description: "Create a browser session (returns cdpUrl + viewUrl).", inputSchema: { type: "object", properties: { profile: { type: "string" }, backend: { type: "string", enum: ["native", "docker"] } } } },
  { name: "lucarne_list", description: "List active sessions.", inputSchema: { type: "object", properties: {} } },
  { name: "lucarne_destroy", description: "Destroy a session.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "lucarne_act", description: "Computer-use action: click/move/type/key/scroll/screenshot.", inputSchema: { type: "object", properties: { id: { type: "string" }, action: { type: "string", enum: ["click", "move", "type", "key", "scroll", "screenshot"] }, x: { type: "number" }, y: { type: "number" }, button: { type: "number", description: "0=left 1=middle 2=right" }, clickCount: { type: "number", description: "2=double 3=triple" }, text: { type: "string" }, key: { type: "string" }, code: { type: "string" }, mod: { type: "number" }, dx: { type: "number" }, dy: { type: "number" } }, required: ["id", "action"] } },
  { name: "lucarne_content", description: "Get the page's rendered HTML.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
] as const;

type Io = { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream };

export function startMcpServer(client: LucarneClient, io: Io = process): void {
  const rl = readline.createInterface({ input: io.stdin });
  const send = (msg: unknown): void => { io.stdout.write(JSON.stringify(msg) + "\n"); };

  rl.on("line", async (line) => {
    let req: { id?: unknown; method?: string; params?: any };
    try { req = JSON.parse(line); } catch { return; }
    const id = req.id;
    try {
      if (req.method === "initialize") {
        return send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "lucarne", version: VERSION } } });
      }
      if (req.method === "notifications/initialized") return; // notification, no reply
      if (req.method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      if (req.method === "tools/call") {
        const name = req.params?.name as string;
        const args = req.params?.arguments ?? {};
        let result: unknown;
        if (name === "lucarne_create") result = await client.create(args);
        else if (name === "lucarne_list") result = await client.list();
        else if (name === "lucarne_destroy") result = await client.destroy(args.id);
        else if (name === "lucarne_act") result = await client.act(args.id, args);
        else if (name === "lucarne_content") result = await client.content(args.id);
        else throw new Error(`unknown tool: ${name}`);
        return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] } });
      }
      if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${req.method}` } });
    } catch (e) {
      if (id !== undefined) send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `error: ${(e as Error).message}` }], isError: true } });
    }
  });
}

// Run as a binary: `lucarne-mcp` (configure your MCP client to spawn it).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  startMcpServer(new LucarneClient({ baseUrl: process.env.LUCARNE_URL, token: process.env.LUCARNE_TOKEN }));
}

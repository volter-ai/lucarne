#!/usr/bin/env node
/**
 * `lucarne-mcp` — THE platform MCP server (stdio). One bin, three tool groups:
 *
 *   1. CORPUS      — read-only queries over a records store (`./corpus/tools.ts`). Never fetches:
 *                    a miss returns a structured `not_captured` telling the agent to browse to it
 *                    in-session.
 *   2. INTERACT    — the human-paced act verbs over a session's `cdpUrl` (`./interact-tools.ts`).
 *                    No click, no goto, no eval — those verbs do not exist here any more than they
 *                    exist on `InteractSession` itself; `type` stages, and `send` is the one gated
 *                    submit path.
 *   3. LIFECYCLE   — mint/list/destroy sessions on a lucarne daemon over plain HTTP
 *                    (`./session-tools.ts`).
 *
 * `--corpus-only` (or `LUCARNE_MCP_CORPUS_ONLY=1`) registers group 1 and nothing else. That mode is
 * a hard promise, not a convention: the other two modules are loaded through a DYNAMIC import
 * below, so corpus-only never even loads `playwright-core`, and it opens no socket of any kind
 * (test/mcp-no-egress.mjs poisons every socket primitive Node exposes and drives it).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveConfig } from "./config.js";
import { registerCorpusTools } from "./corpus/tools.js";

/** The package version, read from package.json (two levels above the built `dist/mcp/`). */
const VERSION: string = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
).version;

export async function main(): Promise<void> {
  const config = resolveConfig();

  const server = new McpServer({ name: "lucarne-mcp", version: VERSION });
  registerCorpusTools(server, config.storeDir);

  if (!config.corpusOnly) {
    // Dynamic, so corpus-only mode never loads these modules at all (and therefore never loads
    // playwright-core, which `InteractSession` reaches for when it connects).
    const { registerInteractTools } = await import("./interact-tools.js");
    const { registerSessionTools } = await import("./session-tools.js");
    registerInteractTools(server);
    registerSessionTools(server);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Note: never write to stdout — it carries the MCP protocol. Logs go to stderr.
  process.stderr.write(
    `[lucarne-mcp] up (${config.corpusOnly ? "corpus-only" : "corpus + interact + sessions"}); store: ${config.storeDir}\n` +
      "[lucarne-mcp] corpus queries never fetch — a miss returns not_captured (browse to it in-session)\n" +
      (config.corpusOnly ? "" : "[lucarne-mcp] no click/goto/eval tool exists; type stages only; send is the one gated submit path\n"),
  );

  const shutdown = () => process.exit(0);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`[lucarne-mcp] fatal: ${String(err)}\n`);
    process.exit(1);
  });
}

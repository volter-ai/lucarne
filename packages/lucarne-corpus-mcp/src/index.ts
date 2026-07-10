#!/usr/bin/env node
/**
 * `lucarne-corpus-mcp` — a thin, OPTIONAL, read-only stdio MCP bin over a
 * `lucarne-records` store.
 *
 * Posture: same shape as `packages/lucarne/src/mcp.ts` (stdio MCP, one bin,
 * thin wiring) but built on `@modelcontextprotocol/sdk` the way
 * `claude-socials/packages/mcp-server/src/index.ts` was, because this
 * package's tool surface (zod-typed args/descriptions per tool) is exactly
 * that reshaped surface. Unlike BOTH of those, this bin's only I/O is a
 * synchronous disk read through `lucarne-records`: it never opens a socket,
 * never spawns/attaches a browser, and never fetches. See `queries.ts`'s
 * header and the package README for the categorical "behave like a user" law
 * this enforces (the split spec's §1.3/§1.3a).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveConfig } from "./config.js";
import { registerTools } from "./tools.js";

const VERSION = "0.1.0";

export async function main(): Promise<void> {
  const config = resolveConfig();

  const server = new McpServer({ name: "lucarne-corpus-mcp", version: VERSION });
  registerTools(server, config.storeDir);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Note: never write to stdout — it carries the MCP protocol. Logs go to stderr.
  if (config.deprecationWarning) process.stderr.write(config.deprecationWarning + "\n");
  process.stderr.write(
    `[lucarne-corpus-mcp] up; read-only queries over store: ${config.storeDir}\n` +
      `[lucarne-corpus-mcp] this bin never fetches — a query miss returns not_captured (browse to it in-session)\n`,
  );

  const shutdown = () => process.exit(0);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`[lucarne-corpus-mcp] fatal: ${String(err)}\n`);
    process.exit(1);
  });
}

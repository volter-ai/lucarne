import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The package version, read once from package.json (one source of truth — the
 * CLI `--version`, the MCP `serverInfo`, and the OpenAPI `info.version` all use
 * it, so none can drift). package.json sits one level above the built `dist/`.
 */
export const VERSION: string = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
).version;

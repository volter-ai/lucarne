/**
 * Config resolution for the `lucarne-corpus-mcp` bin.
 *
 * claude-socials' MCP server dialed a browser-extension bridge over a
 * localhost socket server, and `CLAUDE_SOCIALS_PORT` configured which port it
 * listened on (`claude-socials/packages/mcp-server/src/index.ts:14`, the
 * bridge's `DEFAULT_PORT`). That bridge — extension + socket server + replay
 * transport — does not exist in this package (the split spec's
 * §1.3a): this package's ONLY I/O is reading a `lucarne-records` store
 * directory off disk. So the genuinely-configured input here is a STORE
 * DIRECTORY, not a port; `LUCARNE_CORPUS_STORE_DIR` is that.
 *
 * `LUCARNE_CORPUS_PORT` (the renamed `CLAUDE_SOCIALS_PORT`) is kept purely as
 * an INERT back-compat surface: setting it never opens a socket and never
 * changes behavior — there is nothing to dial — but reading it is harmless
 * (an old deployment's environment that still exports the variable should not
 * crash this bin) and it is echoed in the startup banner for continuity. Only
 * the OLD name (`CLAUDE_SOCIALS_PORT`) triggers a deprecation warning; the
 * renamed `LUCARNE_CORPUS_PORT` does not (that's the "current" spelling of an
 * otherwise-inert value).
 */
import { resolve } from "node:path";

/** Where the store lives when nothing is configured. */
export const DEFAULT_STORE_DIR = ".lucarne/corpus";

export interface CorpusConfig {
  /** Absolute path to the `lucarne-records` store directory to READ (no writes happen here). */
  storeDir: string;
  /**
   * Present only for startup-banner / back-compat continuity. NEVER dialed —
   * this package opens no socket, so a set port has zero functional effect.
   */
  port?: number;
  /** Non-empty exactly when the OLD `CLAUDE_SOCIALS_PORT` name supplied the port value. */
  deprecationWarning?: string;
}

const DEPRECATION_WARNING =
  "[lucarne-corpus-mcp] CLAUDE_SOCIALS_PORT is deprecated; use LUCARNE_CORPUS_PORT instead. " +
  "Note: lucarne-corpus-mcp has no bridge/port to dial (the extension + socket bridge it replaces " +
  "was dissolved — see the split spec's §1.3a); this value has no functional effect and is " +
  "accepted only for back-compat continuity. Configure the store location with LUCARNE_CORPUS_STORE_DIR.";

function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Resolve config from an env-like object (defaults to `process.env`; pass a plain object in tests). */
export function resolveConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): CorpusConfig {
  const storeDir = resolve(env.LUCARNE_CORPUS_STORE_DIR ?? env.LUCARNE_CORPUS_DIR ?? DEFAULT_STORE_DIR);

  const newPort = parsePort(env.LUCARNE_CORPUS_PORT);
  const oldPort = parsePort(env.CLAUDE_SOCIALS_PORT);

  if (newPort !== undefined) {
    // the current name wins outright, and is never itself a deprecation trigger.
    return { storeDir, port: newPort };
  }
  if (oldPort !== undefined) {
    return { storeDir, port: oldPort, deprecationWarning: DEPRECATION_WARNING };
  }
  return { storeDir };
}

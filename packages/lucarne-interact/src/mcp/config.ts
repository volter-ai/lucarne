/**
 * Config resolution for the `lucarne-mcp` bin.
 *
 * claude-socials' MCP server dialed a browser-extension bridge over a
 * localhost socket server, and `CLAUDE_SOCIALS_PORT` configured which port it
 * listened on (`claude-socials/packages/mcp-server/src/index.ts:14`, the
 * bridge's `DEFAULT_PORT`). That bridge — extension + socket server + replay
 * transport — does not exist here (the split spec's §1.3a): the CORPUS half's
 * only I/O is reading a records-store directory off disk. So the
 * genuinely-configured input for that half is a STORE DIRECTORY, not a port;
 * `LUCARNE_CORPUS_STORE_DIR` is that. (The interact-verb and session-lifecycle
 * halves take their target per call — a `cdpUrl` argument, and `LUCARNE_URL`/
 * `LUCARNE_TOKEN` respectively — and are absent entirely in corpus-only mode.)
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
  /** Absolute path to the the records store store directory to READ (no writes happen here). */
  storeDir: string;
  /**
   * Present only for startup-banner / back-compat continuity. NEVER dialed —
   * this package opens no socket, so a set port has zero functional effect.
   */
  port?: number;
  /** Non-empty exactly when the OLD `CLAUDE_SOCIALS_PORT` name supplied the port value. */
  deprecationWarning?: string;
  /**
   * CORPUS-ONLY mode: register the read-only corpus query tools and NOTHING else — no interact
   * verbs, no session lifecycle. In this mode the server never imports `playwright-core` and never
   * opens a socket of any kind (proved by test/mcp-no-egress.mjs), so it is the safe surface to
   * hand an agent that should only read what has already been captured.
   *
   * Set by the `--corpus-only` flag or `LUCARNE_MCP_CORPUS_ONLY=1` (either one is enough).
   */
  corpusOnly: boolean;
}

/** Env values that mean "on" for `LUCARNE_MCP_CORPUS_ONLY` (anything else, incl. unset, is off). */
const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** The corpus-only opt-in: the CLI flag OR the env var. */
function resolveCorpusOnly(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  argv: readonly string[],
): boolean {
  if (argv.includes("--corpus-only")) return true;
  const raw = env.LUCARNE_MCP_CORPUS_ONLY;
  return raw !== undefined && TRUTHY.has(raw.trim().toLowerCase());
}

const DEPRECATION_WARNING =
  "[lucarne-mcp] CLAUDE_SOCIALS_PORT is deprecated; use LUCARNE_CORPUS_PORT instead. " +
  "Note: lucarne-mcp has no bridge/port to dial (the extension + socket bridge it replaces " +
  "was dissolved — see the split spec's §1.3a); this value has no functional effect and is " +
  "accepted only for back-compat continuity. Configure the store location with LUCARNE_CORPUS_STORE_DIR.";

function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Resolve config from an env-like object plus the process's own argv (both defaulted; pass plain
 * values in tests).
 */
export function resolveConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  argv: readonly string[] = process.argv.slice(2),
): CorpusConfig {
  const storeDir = resolve(env.LUCARNE_CORPUS_STORE_DIR ?? env.LUCARNE_CORPUS_DIR ?? DEFAULT_STORE_DIR);
  const corpusOnly = resolveCorpusOnly(env, argv);

  const newPort = parsePort(env.LUCARNE_CORPUS_PORT);
  const oldPort = parsePort(env.CLAUDE_SOCIALS_PORT);

  if (newPort !== undefined) {
    // the current name wins outright, and is never itself a deprecation trigger.
    return { storeDir, corpusOnly, port: newPort };
  }
  if (oldPort !== undefined) {
    return { storeDir, corpusOnly, port: oldPort, deprecationWarning: DEPRECATION_WARNING };
  }
  return { storeDir, corpusOnly };
}

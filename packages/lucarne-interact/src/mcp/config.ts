/**
 * Config resolution for the `lucarne-mcp` bin.
 *
 * The CORPUS half's only I/O is reading a records-store directory off disk, so
 * its one configured input is that STORE DIRECTORY (`LUCARNE_CORPUS_STORE_DIR`).
 * The interact-verb and session-lifecycle halves take their target per call —
 * a `cdpUrl` argument, and `LUCARNE_URL`/`LUCARNE_TOKEN` respectively — and are
 * absent entirely in corpus-only mode.
 */
import { resolve } from "node:path";

/** Where the store lives when nothing is configured. */
export const DEFAULT_STORE_DIR = ".lucarne/corpus";

export interface CorpusConfig {
  /** Absolute path to the records store directory to READ (no writes happen here). */
  storeDir: string;
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
  return { storeDir, corpusOnly };
}

// lucarne-mcp config: LUCARNE_CORPUS_STORE_DIR is the corpus half's one
// functional input; corpus-only mode is the flag/env opt-in. An unrecognized
// env var is simply not part of the config surface — nothing else is read.
//
// Run with `node test/mcp-config.mjs` (after `npm run build`).
import path from "node:path";
import { resolveConfig, DEFAULT_STORE_DIR } from "../dist/mcp/config.js";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// ── default: no env at all ───────────────────────────────────────────────
{
  const cfg = resolveConfig({}, []);
  check("default storeDir resolves relative to cwd when nothing is set", cfg.storeDir === path.resolve(DEFAULT_STORE_DIR));
  check("the config surface is exactly {storeDir, corpusOnly}", Object.keys(cfg).sort().join(",") === "corpusOnly,storeDir");
}

// ── LUCARNE_CORPUS_STORE_DIR is the functional config ────────────────────
{
  const cfg = resolveConfig({ LUCARNE_CORPUS_STORE_DIR: "/tmp/some-corpus-dir" }, []);
  check("LUCARNE_CORPUS_STORE_DIR is honored", cfg.storeDir === path.resolve("/tmp/some-corpus-dir"));
}

// ── corpus-only: OFF by default, ON via the flag or the env var ──────────
{
  check("corpus-only is OFF by default (the full three-group server is the normal shape)", resolveConfig({}, []).corpusOnly === false);
  check("--corpus-only turns it on", resolveConfig({}, ["--corpus-only"]).corpusOnly === true);
  check("LUCARNE_MCP_CORPUS_ONLY=1 turns it on", resolveConfig({ LUCARNE_MCP_CORPUS_ONLY: "1" }, []).corpusOnly === true);
  check("LUCARNE_MCP_CORPUS_ONLY=true/yes/on are accepted spellings", ["true", "YES", "on"].every((v) => resolveConfig({ LUCARNE_MCP_CORPUS_ONLY: v }, []).corpusOnly === true));
  check("LUCARNE_MCP_CORPUS_ONLY=0 does NOT turn it on (an explicit off stays off)", resolveConfig({ LUCARNE_MCP_CORPUS_ONLY: "0" }, []).corpusOnly === false);
  check("an unrelated flag does not turn it on", resolveConfig({}, ["--something-else"]).corpusOnly === false);
  check("the flag and the env var are independent doors to the same mode", resolveConfig({ LUCARNE_MCP_CORPUS_ONLY: "0" }, ["--corpus-only"]).corpusOnly === true);
  check("corpus-only is orthogonal to the store dir", resolveConfig({ LUCARNE_CORPUS_STORE_DIR: "/tmp/y", LUCARNE_MCP_CORPUS_ONLY: "1" }, []).storeDir === path.resolve("/tmp/y"));
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

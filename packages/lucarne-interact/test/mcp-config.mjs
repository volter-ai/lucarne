// LS-06 dev/03 — env config: CLAUDE_SOCIALS_PORT -> LUCARNE_CORPUS_PORT
// back-compat alias + deprecation warning; LUCARNE_CORPUS_STORE_DIR is the
// real (functional) config surface since there's no bridge/port to dial.
//
// Run with `node test/config.mjs` (after `npm run build`).
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
  check("default: no port set", cfg.port === undefined);
  check("default: no deprecation warning", cfg.deprecationWarning === undefined);
}

// ── LUCARNE_CORPUS_STORE_DIR is the functional config ────────────────────
{
  const cfg = resolveConfig({ LUCARNE_CORPUS_STORE_DIR: "/tmp/some-corpus-dir" }, []);
  check("LUCARNE_CORPUS_STORE_DIR is honored", cfg.storeDir === path.resolve("/tmp/some-corpus-dir"));
}

// ── new name: LUCARNE_CORPUS_PORT — accepted, inert, NO deprecation warning ──
{
  const cfg = resolveConfig({ LUCARNE_CORPUS_PORT: "8765" }, []);
  check("LUCARNE_CORPUS_PORT is read", cfg.port === 8765);
  check("LUCARNE_CORPUS_PORT does NOT trigger a deprecation warning (it's the current name)", cfg.deprecationWarning === undefined);
}

// ── old name: CLAUDE_SOCIALS_PORT — back-compat alias + deprecation warning ──
{
  const cfg = resolveConfig({ CLAUDE_SOCIALS_PORT: "9999" }, []);
  check("CLAUDE_SOCIALS_PORT still resolves a port value (back-compat alias)", cfg.port === 9999);
  check("CLAUDE_SOCIALS_PORT triggers a deprecation warning", typeof cfg.deprecationWarning === "string" && cfg.deprecationWarning.length > 0);
  check("the deprecation warning names both the old and new env var", cfg.deprecationWarning.includes("CLAUDE_SOCIALS_PORT") && cfg.deprecationWarning.includes("LUCARNE_CORPUS_PORT"));
  check("the deprecation warning is honest that no port is actually dialed", /no bridge|no socket|no functional effect|not dialed/i.test(cfg.deprecationWarning));
}

// ── both set: the NEW name wins, and does not get flagged deprecated ─────
{
  const cfg = resolveConfig({ LUCARNE_CORPUS_PORT: "1111", CLAUDE_SOCIALS_PORT: "2222" }, []);
  check("when both are set, LUCARNE_CORPUS_PORT (new name) wins", cfg.port === 1111);
  check("when the new name is present, no deprecation warning fires even though the old one is also set", cfg.deprecationWarning === undefined);
}

// ── the port is genuinely inert: it never appears in storeDir resolution ──
{
  const cfg = resolveConfig({ LUCARNE_CORPUS_PORT: "8765", LUCARNE_CORPUS_STORE_DIR: "/tmp/x" }, []);
  check("port config and store-dir config are independent", cfg.storeDir === path.resolve("/tmp/x") && cfg.port === 8765);
}

// ── garbage port values don't throw, just resolve to undefined ───────────
{
  const cfg = resolveConfig({ LUCARNE_CORPUS_PORT: "not-a-number" }, []);
  check("a non-numeric port value does not throw and resolves to undefined", cfg.port === undefined);
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

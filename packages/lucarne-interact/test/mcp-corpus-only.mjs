// `--corpus-only` mode, proved against the REAL bin over its REAL stdio transport.
//
// Two properties, both measured rather than asserted from source text:
//  1. TOOL SURFACE — a `--corpus-only` server advertises exactly the five read-only corpus tools:
//     no interact verb, no session lifecycle. (The same server without the flag advertises all
//     three groups — checked here too, so the flag is proved to be what makes the difference,
//     rather than the tools simply never existing.)
//  2. NO playwright-core — the corpus-only process never even RESOLVES `playwright-core`. Measured
//     with a module-resolution recorder registered into the child (mcp-resolve-log-hooks.mjs), and
//     the recorder itself is proved non-vacuous by a control child that DOES import playwright-core
//     and must show up in its own log.
//
// The socket-level "zero egress" half of the same promise lives in test/mcp-no-egress.mjs.
//
// Run with `node test/mcp-corpus-only.mjs` (after `npm run build`).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendRecords } from "../dist/records/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");
const REGISTRAR = path.join(__dirname, "mcp-resolve-log-register.mjs");
const BIN = path.join(PKG_ROOT, "dist", "mcp", "index.js");

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-corpus-only-test-"));
appendRecords(DIR, [
  {
    kind: "profile",
    provenance: {
      source: "x",
      id: "u_seeded",
      canonicalUrl: "https://x.com/seeded",
      fetchedAt: "2026-07-08T12:00:00.000Z",
      via: "internal-api",
    },
    handle: "seeded",
    bio: "a seeded profile",
    metrics: { followers: 5 },
  },
]);

/** Drive the real bin over stdio JSON-RPC; returns the advertised tool names + one tool result. */
async function driveServer({ corpusOnly, resolveLog }) {
  const args = [...(resolveLog ? ["--import", REGISTRAR] : []), BIN, ...(corpusOnly ? ["--corpus-only"] : [])];
  const child = spawn(process.execPath, args, {
    cwd: PKG_ROOT,
    env: {
      ...process.env,
      LUCARNE_CORPUS_STORE_DIR: DIR,
      ...(resolveLog ? { RESOLVE_LOG: resolveLog } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const responses = [];
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) {
        try {
          responses.push(JSON.parse(line));
        } catch {
          /* partial/non-JSON line */
        }
      }
    }
  });
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d.toString();
  });

  const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
  const waitFor = async (id, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const r = responses.find((x) => x.id === id);
      if (r) return r;
      await sleep(50);
    }
    return null;
  };

  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "corpus-only-test", version: "0.0.0" } } });
    const init = await waitFor(1);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const listed = await waitFor(2);
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_profile", arguments: { source: "x", handle: "never-browsed" } } });
    const called = await waitFor(3);
    return {
      serverName: init?.result?.serverInfo?.name,
      names: (listed?.result?.tools ?? []).map((t) => t.name).sort(),
      miss: called?.result?.content?.[0]?.text ? JSON.parse(called.result.content[0].text) : null,
      stderr,
    };
  } finally {
    child.kill();
    await sleep(100);
  }
}

// ── 1. corpus-only: exactly the five read-only corpus tools ───────────────
const corpusLog = path.join(DIR, "resolve-corpus-only.log");
const corpusRun = await driveServer({ corpusOnly: true, resolveLog: corpusLog });
check("corpus-only: the bin comes up and identifies as lucarne-mcp", corpusRun.serverName === "lucarne-mcp", `${corpusRun.serverName} | ${corpusRun.stderr}`);
check(
  "corpus-only: tools/list is exactly the five read-only corpus tools",
  JSON.stringify(corpusRun.names) === JSON.stringify(["get_comments", "get_post", "get_profile", "get_timeline", "search"]),
  JSON.stringify(corpusRun.names),
);
check("corpus-only: a query miss still answers not_captured (the mode is functional, not merely empty)", corpusRun.miss?.status === "not_captured", JSON.stringify(corpusRun.miss));

// ── 2. the flag is what makes the difference: the full server has all three groups ──
const fullRun = await driveServer({ corpusOnly: false });
check("full mode: the interact verbs ARE registered (so the corpus-only list above is the FLAG's doing)", fullRun.names.includes("lucarne_open") && fullRun.names.includes("lucarne_send"), JSON.stringify(fullRun.names));
check("full mode: the session lifecycle tools are registered too", fullRun.names.includes("lucarne_create") && fullRun.names.includes("lucarne_list") && fullRun.names.includes("lucarne_destroy"));
check("full mode: still carries every corpus tool", ["get_comments", "get_post", "get_profile", "get_timeline", "search"].every((n) => fullRun.names.includes(n)));

// ── 3. corpus-only never RESOLVES playwright-core ─────────────────────────
const resolved = fs.existsSync(corpusLog) ? fs.readFileSync(corpusLog, "utf8").split("\n").filter(Boolean) : [];
check(`the resolution recorder captured the corpus-only child's module graph (${resolved.length} specifiers)`, resolved.length > 0);
check(
  "non-vacuity: the recorder really records — the MCP SDK's stdio transport shows up in the log",
  resolved.some((s) => s.includes("@modelcontextprotocol/sdk")),
  resolved.slice(0, 5).join(" | "),
);
const playwrightHits = resolved.filter((s) => s.includes("playwright"));
check("corpus-only: `playwright-core` is never resolved — the browser stack is not loaded at all", playwrightHits.length === 0, playwrightHits.join(" | "));

// ── 4. non-vacuity of the playwright check itself: a control child that DOES import it ──
{
  const controlLog = path.join(DIR, "resolve-control.log");
  await new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ["--import", REGISTRAR, "-e", 'await import("playwright-core");'], {
      cwd: PKG_ROOT,
      env: { ...process.env, RESOLVE_LOG: controlLog },
      stdio: "ignore",
    });
    c.on("exit", () => resolve());
    c.on("error", reject);
  });
  const controlResolved = fs.existsSync(controlLog) ? fs.readFileSync(controlLog, "utf8") : "";
  check(
    "non-vacuity: a control child that imports playwright-core DOES show it in the log (so check 3 could have failed)",
    controlResolved.includes("playwright-core"),
    controlResolved.split("\n").slice(0, 5).join(" | "),
  );
}

fs.rmSync(DIR, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

// The send GATE, as reached through the MCP tool (Chrome-free).
//
// `test/send-gate.mjs` pins the decision table itself. This pins the WIRING: that `lucarne_send`
// reaches the same gate, refuses by default, and — the load-bearing property — never touches the
// browser at all on a refusal. That last part is measurable without a browser precisely BECAUSE the
// refusal is structural: `runSendFlow` returns before any injected transport callback runs, and
// every one of `InteractSession#send`'s callbacks is the only thing that would open a CDP
// connection. So a refusing call against a DEAD cdpUrl still succeeds; a GO decision against the
// same dead cdpUrl fails trying to connect. The difference between those two outcomes is the gate.
//
// Run with `node test/mcp-send-gate.mjs` (after `npm run build`).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerInteractTools } from "../dist/mcp/interact-tools.js";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// A CDP endpoint nothing is listening on: any attempt to actually drive a browser fails loudly.
const DEAD_CDP = "http://127.0.0.1:59999";

async function connect(env) {
  const server = new McpServer({ name: "lucarne-mcp-send-test", version: "0.0.0" });
  registerInteractTools(server, { env });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "send-gate-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function send(env, args) {
  const client = await connect(env);
  try {
    const res = await client.callTool({ name: "lucarne_send", arguments: { cdpUrl: DEAD_CDP, text: "shipping the docs today", ...args } });
    const text = res.content[0].text;
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* an error result is plain text */
    }
    return { isError: res.isError === true, text, parsed };
  } finally {
    await client.close().catch(() => {});
  }
}

// ── default posture: ask mode, no approval → refuse, and the browser is never touched ──
{
  const r = await send({}, { key: "Meta+Enter" });
  check("default (no env, no approval): the send REFUSES", r.parsed?.sent === false, r.text);
  check("default: the action is 'needs-approval' — decideSend's own third priority", r.parsed?.action === "needs-approval", r.text);
  check("default: the refusal happened WITHOUT reaching the browser (a dead cdpUrl was never dialed)", !r.isError, r.text);
}

// ── a blocked-shaped input can't be smuggled in: approval alone doesn't bypass the composer check ──
{
  const r = await send({}, { key: "Meta+Enter", approved: true });
  check("approved: the gate lets it through and the call then FAILS at the dead browser (proving the refusal above was the gate, not the transport)", r.isError === true, r.text);
}

// ── the standing MODE is the operator's, from env — not a tool argument ───
{
  const r = await send({ LUCARNE_SEND_MODE: "yolo" }, { key: "Meta+Enter" });
  check("LUCARNE_SEND_MODE=yolo: no per-send approval is needed, so the call proceeds to the (dead) browser", r.isError === true, r.text);
}
{
  const r = await send({ LUCARNE_SEND_MODE: "anything-else" }, { key: "Meta+Enter" });
  check("an unrecognized LUCARNE_SEND_MODE falls back to ask mode (default-refuse), never to yolo", r.parsed?.action === "needs-approval", r.text);
}

// ── the gesture is required and unambiguous ──────────────────────────────
{
  const r = await send({}, {});
  check("no gesture at all: refused with a message, never a guess", r.isError === true && /exactly one of/.test(r.text), r.text);
}
{
  const r = await send({}, { key: "Meta+Enter", submit: "button[type=submit]" });
  check("both gestures: refused rather than silently picking one", r.isError === true && /exactly one of/.test(r.text), r.text);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

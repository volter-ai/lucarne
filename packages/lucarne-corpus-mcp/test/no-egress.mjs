// LS-06 dev/02 (load-bearing half) — no-egress test harness: monkeypatch
// every socket-opening primitive Node exposes (net.Socket.connect,
// net.createConnection, http.request/get, https.request/get, dgram.createSocket,
// tls.connect) to THROW, then drive the miss path of all five reshaped tools
// (a query with no matching capture). If ANY of them ever attempted a
// network call, this test would fail loudly instead of returning
// `not_captured`. Also proves the HIT path never touches the network either
// (a store read is pure node:fs).
//
// Run with `node test/no-egress.mjs` (after `npm run build`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import dgram from "node:dgram";
import { appendRecords } from "lucarne-records";
import { getProfile, getPost, getComments, search, getTimeline } from "../dist/queries.js";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

class EgressAttempt extends Error {
  constructor(where) {
    super(`EGRESS ATTEMPTED: ${where} was called — this proves a network call was attempted`);
    this.where = where;
  }
}

// ── poison every socket-opening entry point ───────────────────────────────
const poisoned = [];
function poison(obj, key, label) {
  const original = obj[key];
  obj[key] = function (...args) {
    throw new EgressAttempt(label);
  };
  poisoned.push(() => {
    obj[key] = original;
  });
}

poison(net.Socket.prototype, "connect", "net.Socket.prototype.connect");
poison(net, "createConnection", "net.createConnection");
poison(net, "connect", "net.connect");
poison(http, "request", "http.request");
poison(http, "get", "http.get");
poison(https, "request", "https.request");
poison(https, "get", "https.get");
poison(tls, "connect", "tls.connect");
poison(dgram, "createSocket", "dgram.createSocket");
// global fetch (undici) — if the runtime provides it, poison it too.
let restoreFetch;
if (typeof globalThis.fetch === "function") {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function () {
    throw new EgressAttempt("global fetch()");
  };
  restoreFetch = () => {
    globalThis.fetch = originalFetch;
  };
}

// ── seed a small store (so we can prove BOTH hit and miss paths are egress-free) ──
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-corpus-mcp-no-egress-test-"));
const prov = (id, over = {}) => ({
  source: "x",
  id,
  canonicalUrl: `https://x.com/i/status/${id}`,
  fetchedAt: "2026-07-08T12:00:00.000Z",
  via: "internal-api",
  ...over,
});
appendRecords(DIR, [
  {
    kind: "profile",
    provenance: prov("u_seeded", { canonicalUrl: "https://x.com/seeded" }),
    handle: "seeded",
    bio: "a seeded profile",
    metrics: { followers: 5 },
  },
]);

function proveEgressFree(name, fn) {
  try {
    const result = fn();
    check(`${name}: ran to completion with zero network attempts`, true);
    return result;
  } catch (e) {
    if (e instanceof EgressAttempt) {
      check(`${name}: ran to completion with zero network attempts`, false, e.message);
    } else {
      check(`${name}: ran to completion with zero network attempts`, false, `unexpected throw: ${e.message}`);
    }
    return undefined;
  }
}

// ── MISS path: every tool, with nothing matching, must return not_captured — never attempt egress ──
{
  const r = proveEgressFree("get_profile (miss)", () => getProfile(DIR, { source: "x", handle: "never-browsed" }));
  check("get_profile (miss): returns not_captured, not an egress attempt", r?.status === "not_captured");
}
{
  const r = proveEgressFree("get_post (miss)", () => getPost(DIR, { source: "x", idOrUrl: "9999999" }));
  check("get_post (miss): returns not_captured, not an egress attempt", r?.status === "not_captured");
}
{
  const r = proveEgressFree("get_comments (miss)", () => getComments(DIR, { source: "x", postIdOrUrl: "9999999" }));
  check("get_comments (miss): returns not_captured, not an egress attempt", r?.status === "not_captured");
}
{
  const r = proveEgressFree("search (miss)", () => search(DIR, { source: "x", query: "nothing-like-this-was-ever-captured" }));
  check("search (miss): returns not_captured, not an egress attempt", r?.status === "not_captured");
}
{
  const r = proveEgressFree("get_timeline (miss)", () => getTimeline(DIR, { source: "x", kind: "user_posts", handle: "nobody" }));
  check("get_timeline (miss): returns not_captured, not an egress attempt", r?.status === "not_captured");
}

// ── HIT path too: a successful store read must ALSO never attempt egress ──
{
  const r = proveEgressFree("get_profile (hit)", () => getProfile(DIR, { source: "x", handle: "seeded" }));
  check("get_profile (hit): returns the seeded record, not an egress attempt", r?.status === "ok" && r.data.handle === "seeded");
}

// ── restore poisoned primitives before exiting ────────────────────────────
for (const restore of poisoned) restore();
if (restoreFetch) restoreFetch();
fs.rmSync(DIR, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

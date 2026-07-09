// Non-browser proofs for LS-02 (sticky script injection) — everything here runs
// with NO Chrome/Docker: the store's add/remove/list bookkeeping, the
// `injectPolicy` accept/reject hook (including over REAL HTTP, via a fake
// session seeded directly into the engine's session map — the point being that
// `InjectionStore.set()`/`.ids()` never touch the network until `.start()` is
// called, and a fake session here never calls it), and the session-spec
// persistence round-trip on disk (the additive `inject` field on
// `CreateSessionOptions`, through the SAME `readReg`/`writeReg`/`persistInject`
// code paths the engine uses at runtime).
//
// The live-browser assertions this AC also requires (an injected script surviving
// a real page reload / a newly opened real tab / an actual daemon restart) are
// NOT re-proven here — they need a real Chrome, are CI-gated, and live in
// `test/acceptance.mjs` (search "STICKY INJECTION"). This file is the in-sandbox
// half: run with `node test/inject-unit.mjs` (after `npm run build`).
import { Lucarne } from "../dist/index.js";
import { InjectionStore } from "../dist/inject.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// A deliberately unreachable CDP url: legitimate because none of the assertions
// below ever call `store.start()` — `set()`/`remove()`/`ids()` are pure
// bookkeeping over an empty `knownTargets` set until something calls `start()`
// (which is what does the real CDP work: `listPages`/`attachBrowser`/`attachPage`).
const DEAD_CDP = "http://127.0.0.1:1";

// ── dev/01: store add/remove/list logic (no CDP, no network) ────────────────
{
  const store = new InjectionStore(DEAD_CDP);
  check("store: starts empty", store.ids().length === 0);
  await store.set("shell", "console.log('hi')", true);
  check("store: set() registers an id", store.ids().includes("shell"));
  await store.set("shell", "console.log('v2')", false);
  check("store: set() on an existing id replaces (still exactly one entry)", store.ids().length === 1 && store.snapshot().shell.source === "console.log('v2')");
  await store.set("other", "1+1");
  check("store: a second id coexists", store.ids().sort().join(",") === "other,shell");
  const snap = store.snapshot();
  check("store: snapshot() carries the raw desired state (source + bypassCSP)", snap.shell.bypassCSP === false && snap.other.source === "1+1" && snap.other.bypassCSP === false);
  await store.remove("shell");
  check("store: remove() drops just that id", store.ids().length === 1 && store.ids()[0] === "other");
  await store.remove("does-not-exist");
  check("store: remove() of an absent id is a no-op (idempotent, doesn't throw)", store.ids().length === 1);
}

// ── dev/02: injectPolicy hook — default permissive ───────────────────────────
{
  const store = new InjectionStore(DEAD_CDP); // no policy passed
  await store.set("anything-at-all", "1");
  check("policy(default): with no policy every id is accepted", store.ids().includes("anything-at-all"));
}

// ── dev/02: injectPolicy hook — a policy rejecting "X" ────────────────────────
{
  const store = new InjectionStore(DEAD_CDP, (id) => id !== "X");
  await store.set("shell", "1"); // accepted id still works
  let threw = null;
  try { await store.set("X", "evil()"); } catch (e) { threw = e; }
  check("policy(reject): set() on a rejected id throws (route maps this to 4xx)", threw instanceof Error && /rejected by policy/.test(threw.message));
  check("policy(reject): the rejected id was never stored", !store.snapshot().X);
  check("policy(reject): ids() never lists the rejected id", store.ids().includes("shell") && !store.ids().includes("X"));
}

// ── dev/02: injectPolicy hook — over REAL HTTP (the actual route + 4xx code) ──
// A fake session is seeded directly into the engine's session map (bypassing
// backend/CDP spawn entirely — legitimate here because `POST/GET /inject`
// touches only `session.inject`, and that InjectionStore's `.start()` is never
// called, so nothing ever dials the network).
{
  const PORT = 17901, TOKEN = "inject-test-token";
  const engine = new Lucarne({ port: PORT, token: TOKEN, record: false, injectPolicy: (id) => id !== "X" });
  await engine.listen();
  const FAKE_ID = "fake-http";
  engine.sessions.set(FAKE_ID, { inject: new InjectionStore(DEAD_CDP, engine.injectPolicy) });
  const F = (p, opts = {}) => fetch(`http://127.0.0.1:${PORT}${p}`, { ...opts, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(opts.headers || {}) } });
  try {
    const ok = await F(`/sessions/${FAKE_ID}/inject`, { method: "POST", body: JSON.stringify({ id: "shell", source: "1+1", bypassCSP: true }) });
    check("http: accepted id -> 200", ok.status === 200, `status=${ok.status}`);

    const rejected = await F(`/sessions/${FAKE_ID}/inject`, { method: "POST", body: JSON.stringify({ id: "X", source: "evil()" }) });
    check("http: policy-rejected id -> 4xx", rejected.status >= 400 && rejected.status < 500, `status=${rejected.status}`);

    const noId = await F(`/sessions/${FAKE_ID}/inject`, { method: "POST", body: JSON.stringify({ source: "1+1" }) });
    check("http: missing id -> 4xx", noId.status >= 400 && noId.status < 500, `status=${noId.status}`);

    const listed = await (await F(`/sessions/${FAKE_ID}/inject`)).json();
    check("http: GET lists the accepted id and NEVER the rejected one", listed.ids.includes("shell") && !listed.ids.includes("X"));

    const removed = await F(`/sessions/${FAKE_ID}/inject`, { method: "POST", body: JSON.stringify({ id: "shell", remove: true }) });
    const listed2 = await (await F(`/sessions/${FAKE_ID}/inject`)).json();
    check("http: remove:true drops it", removed.status === 200 && !listed2.ids.includes("shell"));

    const missing = await F(`/sessions/no-such-session/inject`);
    check("http: unknown session -> 404", missing.status === 404, `status=${missing.status}`);
  } finally {
    await engine.close().catch(() => {});
  }
}

// ── dev/01: session-spec persistence round-trip on disk (the additive `inject` field) ──
{
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-inject-persist-"));
  const registryFile = path.join(HOME, "sessions.json");
  const engine = new Lucarne({ port: 17902, token: "t", record: false, registryFile });
  try {
    const spec = { profile: "durable1", persist: true, inject: { shell: { source: "console.log(1)", bypassCSP: true } } };
    engine.persistSpec("durable1", spec);
    const onDisk = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    check("persist: registry file on disk carries the additive `inject` field", JSON.stringify(onDisk.durable1.inject) === JSON.stringify(spec.inject));
    const reread = engine.readReg();
    check("persist: readReg() round-trips it losslessly", JSON.stringify(reread.durable1) === JSON.stringify(spec));

    // persistInject(): syncs a durable session's registry entry to its LIVE
    // store snapshot (this is what setInjection() calls after every set/remove
    // over HTTP, so a daemon restart re-applies whatever is live right now).
    const liveStore = new InjectionStore(DEAD_CDP);
    await liveStore.set("shell", "console.log(2)", false);
    await liveStore.set("second", "console.log(3)", true);
    engine.sessions.set("durable1", { inject: liveStore });
    engine.persistInject("durable1");
    const afterSync = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    check("persist: persistInject() syncs the registry to the live store's snapshot",
      JSON.stringify(afterSync.durable1.inject) === JSON.stringify(liveStore.snapshot()) && Object.keys(afterSync.durable1.inject).length === 2);

    // A session that was never persisted (not in the registry) must NOT be
    // written into it just because it's live — persistInject() is a sync, not a
    // promotion to durable.
    engine.sessions.set("ephemeral", { inject: new InjectionStore(DEAD_CDP) });
    engine.persistInject("ephemeral");
    const stillNoEphemeral = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    check("persist: an ephemeral (non-durable) session is never written into the registry", !("ephemeral" in stillNoEphemeral));
  } finally {
    await engine.close().catch(() => {});
    fs.rmSync(HOME, { recursive: true, force: true });
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

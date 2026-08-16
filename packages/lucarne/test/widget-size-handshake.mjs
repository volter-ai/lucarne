// The SIZE-HANDSHAKE state-machine test (Chrome-free) — the committed proof for the defect
// `src/widget/size-handshake.ts` exists to kill: the iframe's FIRST `{action:'resize'}` post can land before the
// host page armed its `message` listener (it is armed inside `injector.ts`'s one-time guard block), and nothing
// ever re-sent it — the anti-jitter rule suppresses a re-post of an unchanged size and a collapsed pill never
// changes size again, so the host stayed at its boot size forever (measured live: a 204x40 pill inside a
// 300x120 card, on a build that settled correctly on the very next session).
//
// Driven entirely with plain objects and a FAKE CLOCK (the module takes its timers injected — the same
// "extract the testable half" shape `reducer.ts`/`widget-envelope-roundtrip.mjs` already use), so this asserts
// the convergence property itself rather than any DOM/Chrome behavior:
//   1. first post LOST → retries → ack → stops
//   2. ack received → not one further post
//   3. two `ns` instances on one page never consume each other's acks (LS-17 coexistence)
//
// Run with `node test/widget-size-handshake.mjs` (after `npm run build`).
import { createSizeHandshake, SIZE_ACK_ACTION } from "../dist/widget/size-handshake.js";
import { chromeKey } from "../dist/widget/ns.js";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// ── a FAKE CLOCK: timers are injected, so the retry interval is driven explicitly instead of waited on. ──
function createClock() {
  let seq = 0;
  const timers = new Map();
  return {
    setTimer(fn, ms) {
      const id = ++seq;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    /** Fire every timer currently armed (each retry arms exactly one, so this is one interval tick). */
    tick() {
      const due = [...timers.entries()];
      timers.clear();
      for (const [, t] of due) t.fn();
      return due.length;
    },
    get armed() {
      return timers.size;
    },
  };
}

/** One mounted instance: the handshake plus the outbound messages it posted (each already `chromeKey`-wrapped by the caller, exactly as `runtime.ts`'s `post` does). */
function mount(ns, clock, opts = {}) {
  const sent = [];
  const handshake = createSizeHandshake({
    ns,
    post: (msg) => sent.push({ [chromeKey(ns)]: msg }),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    retryMs: 400,
    ...opts,
  });
  return { handshake, sent };
}

const ackFor = (ns, w, h) => ({ [chromeKey(ns)]: { action: SIZE_ACK_ACTION, w, h } });

// ── 1. THE DEFECT ITSELF: the first post is dropped on the floor (the host's listener isn't armed yet), so the
// loop keeps re-posting the SAME size until an ack finally comes back — then stops. ──────────────────────────
{
  const clock = createClock();
  const { handshake, sent } = mount("tenant-a", clock);

  handshake.measured(204, 40);
  check("the measured size is posted immediately", sent.length === 1 && sent[0][chromeKey("tenant-a")].w === 204 && sent[0][chromeKey("tenant-a")].h === 40, JSON.stringify(sent));
  check("an unacknowledged post leaves the size pending", !!handshake.pending && handshake.pending.w === 204, JSON.stringify(handshake.pending));

  // …that post was LOST. The pill never changes size again, so a re-measure alone would send nothing:
  handshake.measured(204, 40);
  check("a re-measure of the SAME size does not itself re-post (the ±2px anti-jitter rule is intact)", sent.length === 1, `sent=${sent.length}`);

  // …but the retry loop does.
  clock.tick();
  check("the retry loop re-posts the unacknowledged size (post #2)", sent.length === 2 && sent[1][chromeKey("tenant-a")].w === 204, JSON.stringify(sent[1]));
  clock.tick();
  clock.tick();
  check("it keeps re-posting for as long as the host stays silent (posts #3, #4)", sent.length === 4, `sent=${sent.length}`);

  // the host finally hears one and acks it
  const consumed = handshake.handleMessage(ackFor("tenant-a", 204, 40));
  check("the host's ack is recognized as this instance's", consumed === true);
  check("the ack settles the pending size", handshake.pending === null);
  check("the ack disarms the retry timer (no timer left running)", clock.armed === 0, `armed=${clock.armed}`);
  clock.tick();
  clock.tick();
  check("after the ack, nothing is ever re-posted for that size", sent.length === 4, `sent=${sent.length}`);
}

// ── 2. THE HAPPY PATH — the first post is heard: exactly ONE message ever goes out for that size. ────────────
{
  const clock = createClock();
  const { handshake, sent } = mount("tenant-a", clock);
  handshake.measured(204, 40);
  handshake.handleMessage(ackFor("tenant-a", 204, 40));
  clock.tick();
  clock.tick();
  check("an immediately-acked size costs exactly one post (no retry storm on the normal path)", sent.length === 1, `sent=${sent.length}`);

  // and a genuine LATER change (pill → panel) still posts, and converges on its own ack
  handshake.measured(380, 260);
  check("a genuine later size change posts again", sent.length === 2 && sent[1][chromeKey("tenant-a")].h === 260, JSON.stringify(sent[1]));
  // a STALE ack (for the size already superseded) must NOT settle the new one
  handshake.handleMessage(ackFor("tenant-a", 204, 40));
  check("a stale ack (for a superseded size) does not settle the post now in flight", !!handshake.pending && handshake.pending.h === 260, JSON.stringify(handshake.pending));
  clock.tick();
  check("…and the loop keeps retrying the current size after a stale ack", sent.length === 3 && sent[2][chromeKey("tenant-a")].h === 260);
  handshake.handleMessage(ackFor("tenant-a", 380, 260));
  check("the matching ack settles it", handshake.pending === null && clock.armed === 0);
}

// ── 3. A host that NEVER acks must not retry forever — the loop gives up after its attempt budget, and a later
// real size change still starts a fresh loop. ───────────────────────────────────────────────────────────────
{
  const clock = createClock();
  const { handshake, sent } = mount("tenant-a", clock, { maxAttempts: 4 });
  handshake.measured(204, 40);
  for (let i = 0; i < 20; i++) clock.tick();
  check("a never-acking host costs a BOUNDED number of posts (maxAttempts), then the loop stops", sent.length === 4 && clock.armed === 0, `sent=${sent.length} armed=${clock.armed}`);
  handshake.measured(380, 260);
  check("giving up does not disable the relay: a later real change posts and re-arms", sent.length === 5 && clock.armed === 1, `sent=${sent.length} armed=${clock.armed}`);
}

// ── 4. NS COEXISTENCE — two instances on one page share the `window` `message` channel, so each must ignore the
// other's ack completely (the ack rides under `chromeKey(ns)`, never a bare unscoped message). ───────────────
{
  const clock = createClock();
  const a = mount("tenant-a", clock);
  const b = mount("tenant-b", clock);
  a.handshake.measured(204, 40);
  b.handshake.measured(204, 40); // deliberately the SAME size — only the ns key distinguishes the two acks

  // one shared page channel: every listener sees every message
  const broadcast = (data) => [a.handshake.handleMessage(data), b.handshake.handleMessage(data)];

  const [aSawB, bSawB] = broadcast(ackFor("tenant-b", 204, 40));
  check("instance A does not consume instance B's ack", aSawB === false);
  check("instance B consumes its own ack", bSawB === true);
  check("instance A is still pending (B's ack settled nothing of A's)", !!a.handshake.pending, JSON.stringify(a.handshake.pending));
  check("instance B is settled", b.handshake.pending === null);

  clock.tick();
  check("A alone keeps retrying; B posted nothing further", a.sent.length === 2 && b.sent.length === 1, `A=${a.sent.length} B=${b.sent.length}`);

  const [aSawA, bSawA] = broadcast(ackFor("tenant-a", 204, 40));
  check("instance A consumes its own ack; instance B ignores it", aSawA === true && bSawA === false);
  check("both instances end settled, with no timers left armed", a.handshake.pending === null && b.handshake.pending === null && clock.armed === 0, `armed=${clock.armed}`);
}

// ── 5. non-ack traffic on the same channel is never mistaken for an ack (theme flips, envelopes, junk). ──────
{
  const clock = createClock();
  const { handshake } = mount("tenant-a", clock);
  handshake.measured(204, 40);
  const ignored = [null, undefined, "string", 7, {}, { theme: "dark" }, { [chromeKey("tenant-a")]: { action: "ready" } }, { [chromeKey("tenant-a")]: "not-an-object" }];
  const anyConsumed = ignored.some((d) => handshake.handleMessage(d));
  check("no non-ack message is mistaken for an ack, and none of them settle the pending size", anyConsumed === false && !!handshake.pending);
  handshake.dispose();
  check("dispose() stops the retry loop", clock.armed === 0 && handshake.pending === null);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

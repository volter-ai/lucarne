// LS-14 dev — wire-sensor threading (Chrome-free): the reviewer's note this task closes out is
// "the wire sensor emits `kind:'wire'` `RecallSignal`s but never calls `status.publish` itself" (it
// has no per-tick loop to publish FROM — see `status.ts`'s header). `RecallStatusHolder#recordSignal`
// is the fix: `index.ts`'s ONE observer chokepoint (`emit`) calls it for EVERY signal — capture,
// video, AND wire — so both sensors are covered from that one stream without `wire.ts` importing
// `status.ts` at all (checked structurally below too).
//
// Run with `node test/recall-status-wire-thread.mjs` (after `npm run build`).
import { RecallStatusHolder } from "../dist/recall/status.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// ── recordSignal: a 'wire' signal bumps the cumulative counter + stamps lastAt ──
{
  let now = 1_000_000;
  const holder = new RecallStatusHolder(() => now);
  const initial = holder.snapshot();
  check("initial snapshot always carries a 'wire' layer, even before any wire signal", initial.wire && initial.wire.captures === 0 && initial.wire.lastAt === null, JSON.stringify(initial.wire));

  now = 1_001_000;
  const s1 = holder.recordSignal({ kind: "wire", ts: "2026-07-08T00:00:00.000Z", url: "https://x.com/i/api/graphql/abc/UserTweets", recordsAdded: 3 });
  check("a wire signal adds its recordsAdded to the cumulative wire.captures count", s1.wire.captures === 3);
  check("a wire signal stamps wire.lastAt to the CURRENT clock read", s1.wire.lastAt === 1_001_000);

  now = 1_002_500;
  const s2 = holder.recordSignal({ kind: "wire", ts: "2026-07-08T00:00:01.000Z", url: "https://x.com/i/api/graphql/def/TweetDetail", recordsAdded: 2 });
  check("a SECOND wire signal ACCUMULATES rather than overwriting the count", s2.wire.captures === 5, s2.wire.captures);
  check("a SECOND wire signal advances lastAt to its own clock read", s2.wire.lastAt === 1_002_500);
}

// ── recordSignal: capture/video signals are a no-op on the wire layer (the screen sensor already
//    publishes its own L3/L4 transitions directly — recordSignal must not double-count or clobber) ──
{
  let now = 2_000_000;
  const holder = new RecallStatusHolder(() => now);
  holder.recordSignal({ kind: "wire", recordsAdded: 4 });
  const before = holder.snapshot();
  now = 2_000_500;
  const afterCapture = holder.recordSignal({ kind: "capture", recordsAdded: 99 });
  check("a 'capture' signal never touches wire.captures", afterCapture.wire.captures === before.wire.captures);
  check("a 'capture' signal never touches wire.lastAt", afterCapture.wire.lastAt === before.wire.lastAt);
  now = 2_001_000;
  const afterVideo = holder.recordSignal({ kind: "video" });
  check("a 'video' signal never touches wire.captures either", afterVideo.wire.captures === before.wire.captures);
}

// ── recordSignal: a signal with no recordsAdded field is treated as 0 (never throws / NaN) ──
{
  const holder = new RecallStatusHolder(() => 3_000_000);
  const s = holder.recordSignal({ kind: "wire" });
  check("a wire signal missing recordsAdded contributes 0, not NaN/undefined", s.wire.captures === 0);
}

// ── structural gate: wire.ts never imports status.ts (the coupling lives in index.ts's `emit`
//    chokepoint alone, per this file's header) ──
{
  const wireSrc = readFileSync(resolve(__dirname, "../src/recall/wire.ts"), "utf8");
  check("wire.ts has NO import of status.ts (status-threading is index.ts's job, not the sensor's)", !/from ["']\.\/status\.js["']/.test(wireSrc));
  const indexSrc = readFileSync(resolve(__dirname, "../src/recall/index.ts"), "utf8");
  check("index.ts's emit() calls status.recordSignal (the actual threading chokepoint)", /status\.recordSignal\(signal\)/.test(indexSrc));
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

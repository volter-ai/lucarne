// LS-13 dev — singleton lock + orphan-frame-dir sweep + media reconcile (Chrome-free): ported from
// cadence's `recall.ts:252-287`.
//
// Run with `node test/recall-lock.mjs` (after `npm run build`).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendRecords, loadRecords } from "../dist/records/index.js";
import { acquireSingletonLock, RECALL_LOCK_FILE, reconcileMedia, releaseSingletonLock, sweepOrphanVideoDirs } from "../dist/recall/lock.js";
import { MediaCropTracker } from "../dist/recall/media-crop.js";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const WORK = mkdtempSync(path.join(tmpdir(), "lucarne-recall-lock-"));

// ── singleton lock ──
{
  const lockPath = path.join(WORK, RECALL_LOCK_FILE);
  const alwaysAlive = () => true;
  const neverAlive = () => false;

  const first = acquireSingletonLock(lockPath, 111, alwaysAlive);
  check("first acquire (no existing lock file) succeeds", first.acquired === true);
  check("the lock file now holds our pid", readFileSync(lockPath, "utf8").trim() === "111");

  const second = acquireSingletonLock(lockPath, 222, alwaysAlive);
  check("a second acquire while the first pid is ALIVE is refused", second.acquired === false && second.otherPid === 111, JSON.stringify(second));

  const takeover = acquireSingletonLock(lockPath, 333, neverAlive);
  check("a stale/dead lock pid is taken over silently", takeover.acquired === true);
  check("the lock file now holds the new (takeover) pid", readFileSync(lockPath, "utf8").trim() === "333");

  releaseSingletonLock(lockPath, 999);
  check("release() by a DIFFERENT pid does not clobber the current holder's lock", existsSync(lockPath) && readFileSync(lockPath, "utf8").trim() === "333");

  releaseSingletonLock(lockPath, 333);
  check("release() by the ACTUAL holder removes the lock file", !existsSync(lockPath));

  const afterRelease = acquireSingletonLock(lockPath, 444, alwaysAlive);
  check("acquire() after a genuine release succeeds", afterRelease.acquired === true);
  releaseSingletonLock(lockPath, 444);
}

// ── orphan frame-dir sweep ──
{
  const dataDir = path.join(WORK, "sweep-scope");
  mkdirSync(path.join(dataDir, ".vid-111"), { recursive: true });
  writeFileSync(path.join(dataDir, ".vid-111", "f-000000.jpg"), "fake-frame-bytes");
  mkdirSync(path.join(dataDir, ".vid-222"), { recursive: true });
  writeFileSync(path.join(dataDir, "watched-333.mp4"), "not-really-an-mp4"); // a FINISHED video artifact — must survive

  const swept = sweepOrphanVideoDirs(dataDir);
  check("sweepOrphanVideoDirs reports the count it reclaimed", swept === 2, String(swept));
  check("both orphaned .vid-* dirs are gone", !existsSync(path.join(dataDir, ".vid-111")) && !existsSync(path.join(dataDir, ".vid-222")));
  check("a finished watched-*.mp4 artifact is left untouched", existsSync(path.join(dataDir, "watched-333.mp4")));

  const noop = sweepOrphanVideoDirs(path.join(WORK, "does-not-exist-at-all"));
  check("sweeping a missing dataDir returns 0, does not throw", noop === 0);
}

// ── media reconcile ──
{
  const dataDir = path.join(WORK, "reconcile-scope");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, "media-501.png"), "fake-png-bytes-501");
  writeFileSync(path.join(dataDir, "media-502.png"), "fake-png-bytes-502");

  const post501 = {
    kind: "post",
    provenance: { source: "x", id: "501", canonicalUrl: "https://x.com/i/status/501", fetchedAt: "2026-01-01T00:00:00.000Z", via: "screen" },
    author: { handle: "a", profileUrl: "https://x.com/a" },
    text: "a post whose crop is on disk but never got attached",
    metrics: {},
  };
  const post502 = {
    ...post501,
    provenance: { ...post501.provenance, id: "502" },
    raw: { media: [{ image: "already-attached.png", alt: "existing" }] }, // already has media — must NOT be clobbered
  };
  appendRecords(dataDir, [post501, post502]);

  const tracker = new MediaCropTracker(dataDir, () => ({ ok: true }));
  const result = reconcileMedia(dataDir, tracker);
  check("reconcileMedia seeds the tracker for every on-disk crop it doesn't already know", result.seeded === 2, JSON.stringify(result));
  check("reconcileMedia fixes the ONE record missing media (not the one that already has it)", result.fixed === 1, JSON.stringify(result));

  const after = loadRecords(dataDir);
  const fixed501 = after.find((r) => r.provenance.id === "501");
  const untouched502 = after.find((r) => r.provenance.id === "502");
  check("post 501's raw.media now points at its on-disk crop", fixed501?.raw?.media?.[0]?.image?.endsWith("media-501.png"), JSON.stringify(fixed501?.raw));
  check("post 502's ALREADY-attached media is unchanged (not overwritten)", untouched502?.raw?.media?.[0]?.image === "already-attached.png");

  // A second reconcile pass is a no-op (idempotent — nothing left to fix).
  const second = reconcileMedia(dataDir, tracker);
  check("reconcileMedia is idempotent: a second pass fixes nothing further", second.fixed === 0, JSON.stringify(second));

  const emptyDir = path.join(WORK, "empty-reconcile-scope");
  mkdirSync(emptyDir, { recursive: true });
  const emptyResult = reconcileMedia(emptyDir, new MediaCropTracker(emptyDir, () => ({ ok: true })));
  check("reconcileMedia on a dir with no store yet -> {seeded:0, fixed:0}, no throw", emptyResult.seeded === 0 && emptyResult.fixed === 0);
}

// ── media reconcile: KIND-AGNOSTIC (LS-38) — a NON-SOCIAL `kind:"issue"` record's orphaned crop is
// rebound exactly like a `kind:"post"` one. Before the fix, `reconcileMedia` skipped every record
// whose `kind !== "post"`, so this same scenario for an "issue" record produced `fixed:0` — a
// behavioral bug for any non-social consumer of the (kind-agnostic) crop pipeline. This test would
// fail against that old behavior (revert the `lock.ts` fix to see `fixed === 0` here instead of 1).
{
  const dataDir = path.join(WORK, "reconcile-scope-nonsocial");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, "media-701.png"), "fake-png-bytes-701");

  const issue701 = {
    kind: "issue",
    provenance: {
      source: "github",
      id: "701",
      canonicalUrl: "https://github.com/acme/repo/issues/701",
      fetchedAt: "2026-01-01T00:00:00.000Z",
      via: "screen",
    },
    text: "an issue whose screenshot crop is on disk but never got attached",
    metrics: {},
  };
  appendRecords(dataDir, [issue701]);

  const tracker = new MediaCropTracker(dataDir, () => ({ ok: true }));
  const result = reconcileMedia(dataDir, tracker);
  check(
    "reconcileMedia (LS-38): rebinds an orphaned crop for a NON-social kind:'issue' record, same as kind:'post' (fixed:1, not fixed:0)",
    result.fixed === 1,
    JSON.stringify(result),
  );

  const after = loadRecords(dataDir);
  const fixedIssue = after.find((r) => r.provenance.id === "701");
  check(
    "reconcileMedia (LS-38): the issue record's raw.media now points at its on-disk crop",
    fixedIssue?.raw?.media?.[0]?.image?.endsWith("media-701.png"),
    JSON.stringify(fixedIssue?.raw),
  );
}

rmSync(WORK, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

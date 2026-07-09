// Singleton lock + orphan-frame-dir sweep + media reconcile — ported from cadence's
// `recall.ts:252-287`. All three are `dataDir`-scoped filesystem operations (no cadence-specific
// paths, no browser) so they run before recall ever opens a CDP connection, and are Chrome-free
// unit-testable (test/recall-lock.mjs).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Entity } from "lucarne-records";
import { appendRecords, loadRecords } from "lucarne-records";
import type { MediaCropTracker } from "./media-crop.js";

export const RECALL_LOCK_FILE = ".recall.lock";

export interface LockResult {
  acquired: boolean;
  otherPid?: number;
}

/** Duck-typed liveness check, injectable for deterministic tests — defaults to the real `process.kill(pid, 0)` probe. */
export type IsAlive = (pid: number) => boolean;

const defaultIsAlive: IsAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * SINGLETON LOCK — refuse to start a second recall process against the same `dataDir` (would
 * duplicate captures + race the status heartbeat). A stale/dead pid in the lock file is taken over
 * silently (cadence's `recall.ts:256-263`).
 */
export function acquireSingletonLock(lockPath: string, pid: number, isAlive: IsAlive = defaultIsAlive): LockResult {
  try {
    const other = parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    if (other && other !== pid && isAlive(other)) {
      return { acquired: false, otherPid: other };
    }
  } catch {
    // no lock file yet, or unreadable — proceed to claim it
  }
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch {
    /* best-effort */
  }
  try {
    writeFileSync(lockPath, String(pid));
  } catch {
    /* best-effort — see cadence's own comment: claiming the lock is best-effort too */
  }
  return { acquired: true };
}

/** Release the lock, but ONLY if it's still ours (avoid clobbering a lock a later process took over). */
export function releaseSingletonLock(lockPath: string, pid: number): void {
  try {
    if (parseInt(readFileSync(lockPath, "utf8").trim(), 10) === pid) rmSync(lockPath, { force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * ORPHANED FRAME-DIR SWEEP: `.vid-*` directories are transient screencast scratch — a finished
 * video becomes a `watched-*.mp4` and its frame dir is removed. If the process was killed
 * mid-video, the dir is left behind full of JPGs. Since the singleton lock is held before this
 * runs, no live recording owns any `.vid-*` dir, so any that exist are orphans (cadence's
 * `recall.ts:266-276`).
 */
export function sweepOrphanVideoDirs(dataDir: string): number {
  let entries: string[];
  try {
    entries = readdirSync(dataDir);
  } catch {
    return 0;
  }
  let swept = 0;
  for (const d of entries) {
    if (d.startsWith(".vid-")) {
      try {
        rmSync(resolve(dataDir, d), { recursive: true, force: true });
        swept++;
      } catch {
        /* best-effort */
      }
    }
  }
  return swept;
}

export interface ReconcileResult {
  seeded: number;
  fixed: number;
}

/**
 * RECONCILE MEDIA: bind every image crop already on disk (`media-<id>.png`) to its record, fixing
 * crops that were orphaned by a prior run (a capture that made the crop, but a crash before the
 * unit/record carrying it was ever written or re-merged) — cadence's `recall.ts:277-287`. Seeds
 * `tracker` so future attaches survive a restart too. Read-only of the store except for the
 * PATCHED records this actually fixes, which it writes back through `appendRecords` (still a
 * MERGE, not an overwrite — richest-text-wins / stub-never-degrades hold, `lucarne-records`).
 */
export function reconcileMedia(dataDir: string, tracker: MediaCropTracker): ReconcileResult {
  let files: string[];
  try {
    files = readdirSync(dataDir);
  } catch {
    return { seeded: 0, fixed: 0 };
  }
  const crops: Record<string, string> = {};
  for (const f of files) {
    const m = f.match(/^media-(.+)\.png$/);
    if (m) crops[m[1]!] = resolve(dataDir, f);
  }
  let seeded = 0;
  for (const sid in crops) {
    if (!tracker.infoFor(sid)) {
      tracker.seed(sid, { image: crops[sid]!, alt: "" });
      seeded++;
    }
  }
  if (!existsSync(resolve(dataDir, "records.jsonl"))) return { seeded, fixed: 0 };
  const records = loadRecords(dataDir);
  const patched: Entity[] = [];
  for (const r of records) {
    if (r.kind !== "post") continue;
    const cropPath = crops[r.provenance.id];
    if (!cropPath) continue;
    const raw = (r as { raw?: Record<string, unknown> }).raw;
    if (raw && Array.isArray((raw as { media?: unknown }).media) && ((raw as { media: unknown[] }).media as unknown[]).length) continue;
    patched.push({ ...r, raw: { ...(raw ?? {}), media: [{ image: cropPath, alt: "" }] } } as Entity);
  }
  if (patched.length) appendRecords(dataDir, patched); // a MERGE (fixes raw.media in place), not a brand-new identity
  return { seeded, fixed: patched.length };
}

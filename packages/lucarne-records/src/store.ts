/**
 * The pure record store: `appendRecords`/`loadRecords`.
 *
 * Generalized from cadence's per-identity unit store (`cadence/src/units.ts:105-142`,
 * `appendUnits`/`loadUnits`) onto the normalized `Entity` shape (LS-03). Same
 * on-disk shape too: one JSONL file, one JSON object per line, one line per
 * DISTINCT record identity — re-running `appendRecords` over the same capture
 * is idempotent, exactly like the original.
 *
 * On-disk layout: `<dir>/records.jsonl` — every entity kind (profile/post/comment)
 * lives in the ONE file, discriminated by each line's own `kind` field (a store
 * directory is the unit other packages point at; nothing else is written there
 * by this module, except a transient `records.jsonl.tmp` during a write). `dir`
 * is created if absent.
 *
 * CONCURRENCY MODEL. This store is designed for the §1.6 architecture: ONE
 * recorder PROCESS is the only writer (its two sensors — screen + wire — write
 * through the same in-process `appendRecords`), and any number of separate
 * READER processes (e.g. `lucarne-corpus-mcp`) call `loadRecords`/`getRecord`/
 * `queryRecords`. `appendRecords` writes to `records.jsonl.tmp` and then
 * `renameSync`s it over `records.jsonl` — an atomic swap on POSIX — so a reader
 * NEVER sees a torn/partial file and a crash mid-write can never truncate the
 * live store (the half-written bytes land in `.tmp`, which is discarded). The
 * atomic rename makes readers safe regardless of writer timing; it does NOT make
 * two concurrent WRITER processes safe (last-rename-wins would drop the other's
 * merge) — the single-writer-process expectation above is the contract for that.
 *
 * MERGE INVARIANTS (must hold — ported from `units.ts:114-131`):
 *  - richest-text-wins: for the same identity, the record carrying MORE text
 *    (bio, for a Profile) replaces a thinner one. This is the ONLY place text
 *    length matters — it is NOT how stub-ness is decided (see below).
 *  - stub-never-degrades: a record known to be REAL is never overwritten by a
 *    stub for the same identity. Cadence decided this from an EXPLICIT `Unit.stub`
 *    flag, never from text length — its own comment (`units.ts:122`) warns that
 *    "real" is NOT "text is empty": an image/video-only post is REAL with empty
 *    text. So we honor an explicit stub signal FIRST (a top-level `stub:boolean`
 *    or `raw.stub`, which LS-04's `unitToRecord` will set) — when present it is
 *    authoritative and real-ness is STICKY (a known-real record never loses to a
 *    stub, even when the real one is text-less). Only when NO explicit signal
 *    exists do we fall back to the structural heuristic (empty text/bio AND no
 *    real metric) so a bare LS-03 record still degrades sensibly.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Entity } from "./schema.js";
import { assertEntity, isEntity, isRecordShaped } from "./validate.js";

const STORE_FILE = "records.jsonl";
const TMP_SUFFIX = ".tmp";

function storePath(dir: string): string {
  return resolve(dir, STORE_FILE);
}

/** Stable per-identity key: source-scoped id, disambiguated by kind. */
export function recordKey(e: Pick<Entity, "kind" | "provenance">): string {
  return `${e.provenance.source}:${e.kind}:${e.provenance.id}`;
}

function textOf(e: Entity): string {
  return e.kind === "profile" ? e.bio ?? "" : e.text ?? "";
}

function hasRealMetrics(m: Record<string, unknown> | undefined | null): boolean {
  return !!m && Object.values(m).some((v) => v !== undefined && v !== null);
}

/**
 * Read an EXPLICIT stub signal off a record if one is present: a top-level
 * `stub:boolean` (LS-04's `unitToRecord` writes this), else `raw.stub`. Returns
 * `undefined` when the record carries no explicit signal at all — the caller
 * then falls back to the structural heuristic. The field isn't on the `Entity`
 * type yet (LS-04 adds it); read it defensively.
 */
function explicitStub(e: Entity): boolean | undefined {
  const m = e as unknown as { stub?: unknown; raw?: { stub?: unknown } };
  if (typeof m.stub === "boolean") return m.stub;
  if (m.raw && typeof m.raw.stub === "boolean") return m.raw.stub;
  return undefined;
}

/** Structurally "stub-like": no text/bio content AND no real metric value. */
function isStubLike(e: Entity): boolean {
  return textOf(e).length === 0 && !hasRealMetrics(e.metrics as Record<string, unknown>);
}

/**
 * Is this record a stub? Explicit signal wins (authoritative); the structural
 * heuristic is only the fallback when no explicit signal exists.
 */
function isStub(e: Entity): boolean {
  const flag = explicitStub(e);
  if (flag !== undefined) return flag;
  return isStubLike(e);
}

/** Reflect the merged real-ness on the output record (top-level `stub` is canonical). */
function setMergedStub(merged: Entity, stub: boolean): void {
  const m = merged as unknown as { stub?: boolean; raw?: Record<string, unknown> };
  if (stub) {
    m.stub = true;
  } else {
    // real iff EITHER contributor is real — clear any stale stub flag it inherited
    delete m.stub;
    if (m.raw && "stub" in m.raw) delete m.raw.stub;
  }
}

function richerText(a: Entity, b: Entity): string {
  const at = textOf(a);
  const bt = textOf(b);
  return bt.length > at.length ? bt : at;
}

function richerMetrics(a: Entity, b: Entity): Entity["metrics"] {
  const am = a.metrics as Record<string, unknown>;
  const bm = b.metrics as Record<string, unknown>;
  const hasA = hasRealMetrics(am);
  const hasB = hasRealMetrics(bm);
  if (hasB && !hasA) return b.metrics;
  if (hasA && !hasB) return a.metrics;
  // both real, or both empty: prefer the newer contributor (b)
  return b.metrics ?? a.metrics;
}

/**
 * Merge two records for the SAME identity, holding both invariants. `next` is
 * the newer/incoming record; `prev` is what the store already has.
 */
export function mergeEntity(prev: Entity, next: Entity): Entity {
  if (prev.kind !== next.kind) {
    // A kind change for the same (source,kind,id) key can't happen through
    // `recordKey` (kind is part of the key) — guard defensively anyway by
    // preferring the incoming record rather than corrupting a merge.
    return next;
  }
  const prevStub = isStub(prev);
  const nextStub = isStub(next);
  // stub-never-degrades: a stub incoming over a real prior yields the structural
  // base (author/provenance/other fields) to the real record. Real-ness is
  // sticky — this holds even when the real prior is text-less (an image-only
  // post), which the explicit signal captures and a text-length test never could.
  const donor = nextStub && !prevStub ? prev : next;
  const base = donor === next ? prev : next;
  const merged = { ...base, ...donor } as Entity;
  // richest-text-wins, applied independently of which side was the donor above
  // (an older real capture may still hold more text than a fresher real one).
  const text = richerText(prev, next);
  if (merged.kind === "profile") {
    merged.bio = text || undefined;
  } else {
    merged.text = text;
  }
  merged.metrics = richerMetrics(prev, next) as never;
  // the merged record is a stub ONLY if BOTH contributors were stubs.
  setMergedStub(merged, prevStub && nextStub);
  return merged;
}

/**
 * Merge `entities` into the store at `dir`, keyed by `recordKey`. Returns the
 * count of BRAND-NEW identities added (matching `appendUnits`'s return shape).
 * Idempotent: re-appending the same capture adds nothing new and does not
 * regress any previously-merged field.
 *
 * WRITER contract: this must be the only writer PROCESS for `dir` (see the
 * concurrency model at the top of this file). The write itself is crash- and
 * reader-safe — records go to `records.jsonl.tmp` and are `renameSync`d over the
 * live file atomically, so a reader never observes a partial store.
 *
 * Forward-compatibility: lines that parse as JSON and are record-shaped (carry a
 * `provenance` object) but fail the CURRENT validator — e.g. a future
 * `via:'screen'` record written by a newer package — are PRESERVED verbatim
 * through the rewrite rather than dropped, so an older `appendRecords` never
 * silently deletes records it doesn't yet understand. Only non-JSON garbage is
 * discarded.
 */
export function appendRecords(dir: string, entities: readonly Entity[]): number {
  if (!dir || !entities || !entities.length) return 0;
  for (const e of entities) assertEntity(e);
  const file = storePath(dir);
  const byKey = new Map<string, Entity>();
  const passthrough: string[] = [];
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // non-JSON garbage — the only thing we drop
        continue;
      }
      if (isEntity(parsed)) {
        byKey.set(recordKey(parsed), parsed);
      } else if (isRecordShaped(parsed)) {
        // record-shaped but not valid under THIS version's schema — carry it
        // through untouched rather than deleting a forward-schema record.
        passthrough.push(trimmed);
      }
      // else: JSON but not record-shaped — drop
    }
  }
  let added = 0;
  for (const e of entities) {
    const key = recordKey(e);
    const prev = byKey.get(key);
    if (!prev) {
      added++;
      byKey.set(key, e);
      continue;
    }
    byKey.set(key, mergeEntity(prev, e));
  }
  mkdirSync(dirname(file), { recursive: true });
  const lines = [...byKey.values()].map((e) => JSON.stringify(e)).concat(passthrough);
  // atomic: write to a temp file, then rename over the live store so readers
  // and crashes never see a partially-written file.
  const tmp = file + TMP_SUFFIX;
  writeFileSync(tmp, lines.join("\n") + "\n");
  renameSync(tmp, file);
  return added;
}

/** Load every currently-merged record from the store at `dir`. */
export function loadRecords(dir: string): Entity[] {
  const file = storePath(dir);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as unknown;
      } catch {
        return null;
      }
    })
    .filter((v): v is Entity => v !== null && isEntity(v));
}

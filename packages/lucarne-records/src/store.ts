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
 * by this module). `dir` is created if absent.
 *
 * MERGE INVARIANTS (must hold — ported from `units.ts:114-131`):
 *  - richest-text-wins: for the same identity, the record carrying MORE text
 *    (bio, for a Profile) replaces a thinner one.
 *  - stub-never-degrades: a record with real content (non-empty text/bio, or any
 *    real metric) is NEVER overwritten by a stub/empty one for the same identity.
 *    The schema itself has no `stub` flag (that's LS-04's job, mapping cadence's
 *    `Unit.stub` into this schema) — so "stub-like" is derived structurally here:
 *    empty text/bio AND no real metric value. That is exactly the signal
 *    `units.ts:114`'s `richVals` check + the text-length comparison already used,
 *    generalized to a schema that doesn't (yet) carry an explicit stub flag.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Entity } from "./schema.js";
import { assertEntity, isEntity } from "./validate.js";

const STORE_FILE = "records.jsonl";

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

/** Structurally "stub-like": no text/bio content AND no real metric value. */
function isStubLike(e: Entity): boolean {
  return textOf(e).length === 0 && !hasRealMetrics(e.metrics as Record<string, unknown>);
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
  const prevStub = isStubLike(prev);
  const nextStub = isStubLike(next);
  // stub-never-degrades: an incoming stub-like record never becomes the
  // structural base over a real prior record.
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
  return merged;
}

/**
 * Merge `entities` into the store at `dir`, keyed by `recordKey`. Returns the
 * count of BRAND-NEW identities added (matching `appendUnits`'s return shape).
 * Idempotent: re-appending the same capture adds nothing new and does not
 * regress any previously-merged field.
 */
export function appendRecords(dir: string, entities: readonly Entity[]): number {
  if (!dir || !entities || !entities.length) return 0;
  for (const e of entities) assertEntity(e);
  const file = storePath(dir);
  const byKey = new Map<string, Entity>();
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isEntity(parsed)) byKey.set(recordKey(parsed), parsed);
      } catch {
        // corrupt line — skip, don't fail the whole load
      }
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
  writeFileSync(file, [...byKey.values()].map((e) => JSON.stringify(e)).join("\n") + "\n");
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

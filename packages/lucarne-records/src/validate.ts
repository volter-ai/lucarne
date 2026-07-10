/**
 * Runtime validation for the GENERAL record language — schema.ts's types erase at compile time, but
 * records round-trip through `node:fs` (a store file, a fixture, a captured JSON blob) — so
 * "provenance is structural, never advisory" (schema.ts's own design rule) has to be enforced at
 * runtime too, not just typed. `isEntity`/`assertEntity` are the one gate every record passes through
 * on the way into a store (`store.ts`) or out of a disk read (`loadRecords`): a record missing
 * `provenance` — or missing any of provenance's required fields — is not a valid record, full stop.
 *
 * LS-29 (generalize-records): this validator used to enforce a CLOSED source allow-list and per-kind
 * (`profile`/`post`/`comment`) required-field shapes — that was a closed domain baked into what's
 * supposed to be a general engine primitive. It now validates the GENERAL CORE only: `source` is any
 * non-empty string, `kind` is any non-empty string, and the only per-field checks left are the ones
 * `schema.ts`'s `CorpusRecord` itself declares (`text`/`metrics`/`stub`/`capture`, each optional and
 * structurally checked when present). A domain package that wants closed-set / per-kind validation
 * (e.g. "a Post must carry an `author`") layers its own validator on top of this one — via its own
 * type guards, structural narrowing functions independent of this package.
 */

import type { Capture, CorpusRecord, Entity, Provenance } from "./schema.js";

// LS-04: 'screen' added alongside 'internal-api'/'dom' — kept in lockstep with `schema.ts`'s
// `Provenance.via` union (the LS-03 reviewer flagged these two lists as a place that must never
// drift apart). This list is the one CLOSED set validate.ts still enforces — `via` names a capture
// MECHANISM this package itself implements/consumes, not a domain, so it stays closed.
const VIA: readonly Provenance["via"][] = ["internal-api", "dom", "screen"];

function isRecordObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Structural check: every required Provenance field present and well-typed. `source` is any
 *  non-empty string — OPEN, not a closed allow-list (LS-29). */
export function isProvenance(v: unknown): v is Provenance {
  if (!isRecordObject(v)) return false;
  return (
    isNonEmptyString(v.source) &&
    isNonEmptyString(v.id) &&
    isNonEmptyString(v.canonicalUrl) &&
    isNonEmptyString(v.fetchedAt) &&
    VIA.includes(v.via as Provenance["via"])
  );
}

/**
 * A weaker check than `isEntity`: does `v` look like a record at all — an object carrying a
 * `provenance` OBJECT? Used by the store to distinguish a forward-schema record it doesn't yet fully
 * understand (preserve it) from outright garbage (drop it). Deliberately does NOT validate
 * provenance's fields or `kind`, so a record from a newer schema version still qualifies.
 */
export function isRecordShaped(v: unknown): boolean {
  return isRecordObject(v) && isRecordObject((v as { provenance?: unknown }).provenance);
}

/**
 * The optional SCREEN-sensor `capture` pointer, when present, must be an object (its own fields —
 * `from`/`screenshot`/`ts`/`reason`/`by`/`page`, `schema.ts`'s `Capture` — are all individually
 * optional/nullable, so there's nothing further to require here beyond "it's a record, not garbage").
 */
function isCaptureShape(v: unknown): v is Capture | undefined {
  return v === undefined || isRecordObject(v);
}

/**
 * Full structural validation of a candidate record against the GENERAL CORE ONLY: `kind` is any
 * non-empty string, `provenance` is present and itself valid, and the handful of general fields
 * `schema.ts`'s `CorpusRecord` declares (`text`/`metrics`/`stub`/`capture`) are well-typed WHEN
 * present. Every other top-level field (author, container, handle, bio, …) is opaque to this
 * validator — a domain package's own type guards are what check those.
 */
export function isEntity(v: unknown): v is Entity {
  if (!isRecordObject(v)) return false;
  if (!isNonEmptyString(v.kind)) return false;
  if (!isProvenance(v.provenance)) return false;
  if (v.text !== undefined && typeof v.text !== "string") return false;
  if (v.metrics !== undefined && !isRecordObject(v.metrics)) return false;
  if (v.stub !== undefined && typeof v.stub !== "boolean") return false;
  if (!isCaptureShape(v.capture)) return false;
  return true;
}

/** Raises an error with a descriptive message when `v` is not a valid record. */
export function assertEntity(v: unknown): CorpusRecord {
  if (!isRecordObject(v)) {
    throw new Error("invalid record: not an object");
  }
  if (!isNonEmptyString(v.kind)) {
    throw new Error(`invalid record: missing or empty kind ${JSON.stringify(v.kind)}`);
  }
  if (!isProvenance(v.provenance)) {
    throw new Error(
      `invalid record: missing or malformed provenance (kind=${String(v.kind)}, id=${String(
        (v as { provenance?: { id?: unknown } }).provenance?.id ?? "?",
      )})`,
    );
  }
  if (!isEntity(v)) {
    throw new Error(`invalid record: malformed general field (text/metrics/stub/capture) for kind=${String(v.kind)}`);
  }
  return v;
}

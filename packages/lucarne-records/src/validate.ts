/**
 * Runtime validation for the record language.
 *
 * `schema.ts`'s types erase at compile time, but records round-trip through
 * `node:fs` (a store file, a fixture, a captured JSON blob) — so "provenance is
 * structural, never advisory" (schema.ts's own design rule) has to be enforced
 * at runtime too, not just typed. `isEntity`/`assertEntity` are the one gate
 * every record passes through on the way into a store (`store.ts`) or out of a
 * disk read (`loadRecords`): a record missing `provenance` — or missing any of
 * provenance's required fields — is not a valid Entity, full stop.
 */

import type { AuthorRef, Container, Entity, EntityKind, Provenance, Source } from "./schema.js";

const SOURCES: readonly Source[] = ["x", "reddit", "hackernews"];
const VIA: readonly Provenance["via"][] = ["internal-api", "dom"];
const KINDS: readonly EntityKind[] = ["profile", "post", "comment"];

function isRecordObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Structural check: every required Provenance field present and well-typed. */
export function isProvenance(v: unknown): v is Provenance {
  if (!isRecordObject(v)) return false;
  return (
    SOURCES.includes(v.source as Source) &&
    isNonEmptyString(v.id) &&
    isNonEmptyString(v.canonicalUrl) &&
    isNonEmptyString(v.fetchedAt) &&
    VIA.includes(v.via as Provenance["via"])
  );
}

/**
 * A weaker check than `isEntity`: does `v` look like a record at all — an object
 * carrying a `provenance` OBJECT? Used by the store to distinguish a
 * forward-schema record it doesn't yet fully understand (preserve it) from
 * outright garbage (drop it). Deliberately does NOT validate provenance's fields
 * or the entity kind, so a record from a newer schema version still qualifies.
 */
export function isRecordShaped(v: unknown): boolean {
  return isRecordObject(v) && isRecordObject((v as { provenance?: unknown }).provenance);
}

function isAuthorRef(v: unknown): v is AuthorRef {
  return isRecordObject(v) && isNonEmptyString(v.handle) && isNonEmptyString(v.profileUrl);
}

function isContainer(v: unknown): v is Container {
  return isRecordObject(v) && isNonEmptyString(v.name) && isNonEmptyString(v.url);
}

function isProfileShape(v: Record<string, unknown>): boolean {
  return v.kind === "profile" && isNonEmptyString(v.handle) && isRecordObject(v.metrics);
}

function isPostShape(v: Record<string, unknown>): boolean {
  return (
    v.kind === "post" &&
    isAuthorRef(v.author) &&
    typeof v.text === "string" &&
    isRecordObject(v.metrics) &&
    (v.container === undefined || isContainer(v.container))
  );
}

function isCommentShape(v: Record<string, unknown>): boolean {
  return (
    v.kind === "comment" &&
    isAuthorRef(v.author) &&
    typeof v.text === "string" &&
    isRecordObject(v.metrics) &&
    isNonEmptyString(v.parentUrl) &&
    isNonEmptyString(v.threadRootUrl) &&
    typeof v.depth === "number"
  );
}

/**
 * Full structural validation of a candidate Entity: the entity-kind-specific
 * required fields hold AND `provenance` is present and itself valid. Provenance
 * is checked unconditionally — a record failing only on provenance still fails
 * here, which is the load-bearing behavior LS-03's dev/02 AC exercises.
 */
export function isEntity(v: unknown): v is Entity {
  if (!isRecordObject(v)) return false;
  if (!KINDS.includes(v.kind as EntityKind)) return false;
  if (!isProvenance(v.provenance)) return false;
  if (v.kind === "profile") return isProfileShape(v);
  if (v.kind === "post") return isPostShape(v);
  if (v.kind === "comment") return isCommentShape(v);
  return false;
}

/** Raises an error with a descriptive message when `v` is not a valid Entity. */
export function assertEntity(v: unknown): Entity {
  if (!isRecordObject(v)) {
    throw new Error("invalid record: not an object");
  }
  if (!KINDS.includes(v.kind as EntityKind)) {
    throw new Error(`invalid record: unknown kind ${JSON.stringify(v.kind)}`);
  }
  if (!isProvenance(v.provenance)) {
    throw new Error(
      `invalid record: missing or malformed provenance (kind=${String(v.kind)}, id=${String(
        (v as { provenance?: { id?: unknown } }).provenance?.id ?? "?",
      )})`,
    );
  }
  if (!isEntity(v)) {
    throw new Error(`invalid record: fields missing for kind=${String(v.kind)}`);
  }
  return v;
}

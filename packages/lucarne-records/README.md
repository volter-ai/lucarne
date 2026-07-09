# lucarne-records

The one provenance record language for the lucarne platform: a normalized
cross-site schema (`Profile`/`Post`/`Comment`), opaque `Page<T>`/cursor
pagination helpers, and a pure `node:fs` record store + query API.

Dependency-free, zero network. This package never issues an HTTP request, opens
a socket, or touches a browser — it is pure data shape + pure disk I/O, so both
a recorder (`lucarne-interact`) and a read-only query surface
(`lucarne-corpus-mcp`) can depend on it without inheriting each other's runtime
weight.

## What's here

- **`schema.ts`** — `Provenance`, `Profile`, `Post`, `Comment`, `Entity`,
  `Page<T>` and their supporting types. Ported from
  `claude-socials/packages/shared/src/schema.ts`. Every entity carries
  `provenance` — structural, not advisory (see `validate.ts`).
- **`cursor.ts`** — `encodeCursor`/`decodeCursor`: opaque base64-of-JSON
  pagination tokens. Ported verbatim from
  `claude-socials/packages/shared/src/cursor.ts`.
- **`validate.ts`** — `isEntity`/`assertEntity`: the runtime gate every record
  passes through. A record missing `provenance`, or missing any of
  `provenance`'s required fields, fails validation — not just at the type
  level, at runtime.
- **`store.ts`** — `appendRecords`/`loadRecords`: an on-disk JSONL store,
  merged by identity (`source:kind:id`). Generalizes cadence's
  `appendUnits`/`loadUnits` (`cadence/src/units.ts:105-142`) onto the
  normalized schema, preserving both merge invariants:
  - **richest-text-wins** — the record with more text (or, for a `Profile`,
    more `bio`) replaces a thinner one for the same identity.
  - **stub-never-degrades** — a record known to be real is never overwritten by
    a stub for the same identity. Cadence decided this from an explicit
    `Unit.stub` flag, never from text length (an image/video-only post is real
    with empty text). So an explicit stub signal is honored first — a top-level
    `stub:boolean` or `raw.stub`, which LS-04's `unitToRecord` will set — and
    when present it is authoritative with real-ness **sticky** (a known-real
    record never loses to a stub, even when the real one is text-less). Only
    when no explicit signal exists does the merge fall back to a structural
    heuristic (empty text/bio AND no real metric).
- **`query.ts`** — `getRecord`/`queryRecords`: pure reads over the store,
  reshaped from the shape of `claude-socials/packages/mcp-server/src/tools.ts`'s
  five ops. `getRecord` is the single-entity lookup (`get_profile`/`get_post`'s
  shape); `queryRecords` is the paginated list op (`get_comments`/`search`/
  `get_timeline`'s shape), always returning a `Page<T>`. Neither fetches
  anything — a miss is just an empty result or `undefined`.

## On-disk format

A store is a directory. `appendRecords`/`loadRecords` read and write exactly one
durable file inside it: `<dir>/records.jsonl` — one JSON-encoded `Entity` per
line, one line per distinct `source:kind:id` identity (not one line per capture
— merges happen in place). A transient `<dir>/records.jsonl.tmp` exists only for
the instant of a write. Any other file in that directory is not this package's
concern.

## Concurrency: one writer process, many readers

This store targets the platform's §1.6 architecture: **one recorder process is
the only writer** (its two sensors — screen + wire — write through the same
in-process `appendRecords`), and any number of **separate reader processes**
(e.g. `lucarne-corpus-mcp`) call `loadRecords`/`getRecord`/`queryRecords`.

`appendRecords` writes the full store to `records.jsonl.tmp` and then
`renameSync`s it over `records.jsonl` — an **atomic swap on POSIX**. Two
consequences:

- A reader **never observes a torn or partial file**: it sees either the old
  complete store or the new complete store, never bytes mid-write.
- A crash mid-write **cannot truncate the live store**: the half-written bytes
  land in `.tmp`, which is simply discarded.

The atomic rename makes readers safe regardless of writer timing. It does **not**
make two concurrent *writer* processes safe — a last-rename-wins race would drop
the other process's merge — so the single-writer-process expectation is the
contract callers must uphold.

## Forward compatibility

`appendRecords` preserves any line that parses as JSON and is record-shaped
(carries a `provenance` object) even when it fails the *current* validator —
e.g. a future `via:'screen'` record written by a newer package. Such lines are
carried through the rewrite untouched rather than dropped, so an older
`appendRecords` never silently deletes records it doesn't yet understand. Only
non-JSON garbage is discarded.

## API

```ts
import {
  appendRecords, loadRecords, recordKey, mergeEntity,
  getRecord, queryRecords,
  isEntity, assertEntity,
  encodeCursor, decodeCursor,
} from "lucarne-records";

// appendRecords(dir: string, entities: readonly Entity[]): number   -- count of NEW identities added
// loadRecords(dir: string): Entity[]                                -- every currently-merged record
// getRecord(dir: string, ref: RecordRef): Entity | undefined
// queryRecords(dir: string, q: RecordQuery): Page<Entity>
```

## Out of scope here (later tasks)

- `Provenance.via:'screen'` + the `capture` pointer, and `unitToRecord` — LS-04.
- Per-site parsers (`lucarne-records/sites`) — LS-05.
- An MCP bin over this store — LS-06.

## Build / test

```
npm run build       # tsc -b
npm run typecheck    # tsc --noEmit
npm test             # build, then the committed .mjs proofs in test/
```

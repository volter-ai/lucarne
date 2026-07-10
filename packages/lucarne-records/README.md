# lucarne-records

A domain-agnostic capture-corpus record store: a general provenance record shape
(`CorpusRecord`/`Entity`), opaque `Page<T>`/cursor pagination helpers, and a pure
`node:fs` record store + query API. Any capture sensor — social, code-forge,
papers, anything else — writes into the SAME `records.jsonl`; this package
never inspects a record's domain-specific fields by name.

## Charter

This package owns record **shape** and **storage**, and nothing past that
boundary: no domain-specific parsing, no browser, and no network client. That
narrow charter is exactly what lets both a writer (`lucarne-interact`'s
recall) and a read-only reader (`lucarne-corpus-mcp`) depend on this one
package without inheriting each other's runtime weight — and what lets a
downstream domain package (e.g. `cadence/src/records/`) build its own typed
projection (a social schema, an X ARIA/GraphQL parser family, …) on top of
this general core without this package knowing anything about that domain.

## Security posture

**Dependency-free, zero network.** This package never issues an HTTP request,
opens a socket, or touches a browser — it is pure data shape + pure disk I/O.
That is a security property, not just a footprint one: a recorder process and
any number of reader processes can pull in this package's store/query surface
without pulling in a network-capable runtime alongside it — there is nothing
here to compromise into an egress path. On disk, `appendRecords` writes to a
`.tmp` file and `renameSync`s it over `records.jsonl` — an atomic swap on
POSIX — so a reader never observes a torn file and a crash mid-write can't
truncate the live store (see "Concurrency", below). Every record is run
through `validate.ts`'s runtime gate: one missing `provenance` field fails
validation, structurally, not just at the type level.

## What's here

- **`schema.ts`** — `Provenance`, `Capture`, `CorpusRecord` (aliased as
  `Entity`), `Page<T>` and their supporting types. `Provenance.source` is an
  OPEN, non-empty string (any sensor's namespace — "x", "github", "arxiv", …);
  `CorpusRecord.kind` is likewise an open string. Every record carries
  `provenance` — structural, not advisory (see `validate.ts`).
  `Provenance.via` is `'internal-api'` (a passively CDP-captured wire
  response) | `'dom'` | `'screen'` (a passive ARIA capture); a record may
  carry an optional SCREEN-sensor `capture` pointer and an explicit
  `stub?: boolean` — the authoritative real/stub signal `store.ts`'s
  `mergeEntity` reads for its stub-never-degrades invariant. Every OTHER
  top-level field (author, container, handle, bio, labels, …) rides along
  OPAQUELY via `CorpusRecord`'s index signature — this package never reads or
  writes any of them by name. A downstream domain package refines
  `CorpusRecord` with its own named interfaces over the same top-level field
  names (see `cadence/src/records/schema.ts` for the pattern).
- **`cursor.ts`** — `encodeCursor`/`decodeCursor`: opaque base64-of-JSON
  pagination tokens.
- **`validate.ts`** — `isEntity`/`assertEntity`: the runtime gate every record
  passes through, validating the GENERAL CORE only (`source`/`kind` non-empty
  strings, `via` a closed capture-mechanism enum, the handful of general
  optional fields well-typed when present). A record missing `provenance`, or
  missing any of `provenance`'s required fields, fails validation — not just
  at the type level, at runtime. A domain package layers its own closed-set /
  per-kind validation on top of this (its own type guards), if it wants one.
- **`store.ts`** — `appendRecords`/`loadRecords`: an on-disk JSONL store,
  merged by identity (`source:kind:id`), preserving both merge invariants:
  - **richest-text-wins** — the record with more `text` (or the legacy `bio`
    content alias, for any `kind`) replaces a thinner one for the same
    identity.
  - **stub-never-degrades** — a record known to be real is never overwritten by
    a stub for the same identity, decided from an EXPLICIT `stub` signal
    (never from text length — an image/video-only post is real with empty
    text) when one is present; real-ness is **sticky**. Only when no explicit
    signal exists does the merge fall back to a structural heuristic (empty
    text/bio AND no real metric).
  - Every OTHER top-level (domain) field merges via a shallow, donor-wins
    spread — a domain field a caller's own record carries survives a merge
    unmolested (see `test/open-source.mjs`).
- **`query.ts`** — `getRecord`/`queryRecords`: pure reads over the store.
  `getRecord` is the single-record lookup; `queryRecords` is the paginated
  list op (`comments`/`search`/`timeline`), always returning a `Page<T>`.
  These list ops stay thread/timeline-SHAPED as a CONVENTION this package
  still offers, but every domain field they filter/sort on (`container`,
  `handle`, `author.handle`, `depth`, `threadRootUrl`, `title`, metrics keys)
  is read DEFENSIVELY, not typed — a caller whose domain doesn't use these
  conventions just gets `undefined` back, never a crash. Neither op fetches
  anything — a miss is just an empty result or `undefined`.

## On-disk format

A store is a directory. `appendRecords`/`loadRecords` read and write exactly one
durable file inside it: `<dir>/records.jsonl` — one JSON-encoded record per
line, one line per distinct `source:kind:id` identity (not one line per capture
— merges happen in place), ANY domain's records living in the SAME file. A
transient `<dir>/records.jsonl.tmp` exists only for the instant of a write.
Any other file in that directory is not this package's concern.

## Concurrency: one writer process, many readers

This store targets a single-writer/many-readers architecture: **one recorder
process is the only writer** (its sensors write through the same in-process
`appendRecords`), and any number of **separate reader processes** (e.g.
`lucarne-corpus-mcp`) call `loadRecords`/`getRecord`/`queryRecords`.

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
e.g. a hypothetical future `via` value from a schema version newer than this
one understands. Such lines are carried through the rewrite untouched rather
than dropped, so an older `appendRecords` never silently deletes records it
doesn't yet understand. Only non-JSON garbage is discarded.

## API

```ts
import {
  appendRecords, loadRecords, recordKey, mergeEntity,
  getRecord, queryRecords,
  isEntity, assertEntity, isRecordShaped,
  encodeCursor, decodeCursor,
} from "lucarne-records";

// appendRecords(dir: string, entities: readonly Entity[]): number   -- count of NEW identities added
// loadRecords(dir: string): Entity[]                                -- every currently-merged record
// getRecord(dir: string, ref: RecordRef): Entity | undefined
// queryRecords(dir: string, q: RecordQuery): Page<Entity>
```

## Building a domain on top

A domain package (e.g. `cadence/src/records/`) refines `CorpusRecord` with its
own named interfaces over the same top-level field names — a `Post`/`Comment`/
`Profile` union with a closed `Source`, its own site-specific parsers (an ARIA
extractor, a GraphQL response parser family), its own type guards
(`isSocialPost`/…) for narrowing a general record at a read seam. None of that
lives here; this package stays domain-agnostic on purpose.

## Out of scope here

- Domain-specific schema + parsers (moved downstream, e.g. `cadence/src/records/`).
- An MCP bin over this store (`lucarne-corpus-mcp`).

## Build / test

```
npm run build       # tsc -b
npm run typecheck    # tsc --noEmit
npm test             # build, then the committed .mjs proofs in test/
```

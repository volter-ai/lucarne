# Changelog — lucarne-records

## 0.2.0 — LS-29 (generalize-records)

**On-disk format: UNCHANGED.** `records.jsonl` is byte-shape-identical to what a 0.1.x store wrote —
one JSON object per line, one line per identity, atomic `.tmp`+`renameSync` writes, the same merge
invariants (richest-text-wins, stub-never-degrades). No data migration is required or possible to run:
an existing `records.jsonl` from 0.1.x is a valid 0.2.x store as-is.

**TypeScript surface: GENERALIZED.** This package is no longer a social-media-specific record store
wearing a general-sounding name — it is now a domain-agnostic capture-corpus store:

- `schema.ts`: the closed `Source = "x" | "reddit" | "hackernews"` union is gone — `Provenance.source`
  is now an open, non-empty `string`. The closed `Profile`/`Post`/`Comment` union is replaced by a
  single general `CorpusRecord` (`kind: string`, `provenance`, a handful of general optional fields —
  `text`/`metrics`/`stub`/`capture`/`raw` — plus an index signature so any domain field rides along
  opaquely). `Entity` is now an alias for `CorpusRecord` (was `Profile | Post | Comment`).
- `validate.ts`: validates the GENERAL CORE only — `source`/`kind` non-empty strings, `via` still a
  closed capture-mechanism enum, the handful of general fields checked when present. The closed
  `SOURCES`/`KINDS` allow-lists and the per-kind (`author`/`parentUrl`/`depth`/`handle`) required-field
  checks are gone.
- `store.ts`: merge LOGIC is byte-identical to 0.1.x — only the types widened. The one deliberate
  generalization: `textOf` now honors a legacy `bio` content alias for ANY `kind`, not just
  `kind==="profile"`.
- `query.ts`: `source`/`kind` are open strings; the list ops (`comments`/`search`/`timeline`) stay
  thread/timeline-SHAPED as a convention, but every domain field they read (`container`, `handle`,
  `author.handle`, `depth`, `threadRootUrl`, `title`, metrics keys) is now read DEFENSIVELY, not typed.
- **MOVED** (not deleted): the closed social schema
  (`EngagementMetrics`/`ProfileMetrics`/`AuthorRef`/`Container`, narrowed `Profile`/`Post`/`Comment`),
  `unit-to-record.ts`, and the X-specific parsers (`sites/x-aria.ts`, `sites/x-graphql.ts`) moved
  downstream to a domain package (e.g. `cadence/src/records/`), which now builds its own social
  projection on top of this package's general `CorpusRecord`.
- `index.ts` now exports 5 modules (`schema`/`cursor`/`validate`/`store`/`query`) — down from 8.

**Proof of generality:** `test/open-source.mjs` — an arbitrary `source:"github"`/`source:"arxiv"`
record, with domain fields this package has never heard of, validates/merges/round-trips and coexists
with an `x`-sourced record in ONE store, with its own domain fields surviving a merge unmolested.

## 0.1.0

Initial extraction from the origin app's split (LS-03/LS-04/LS-05): the social-media provenance record
language — schema, store, query, X ARIA + GraphQL parsers.

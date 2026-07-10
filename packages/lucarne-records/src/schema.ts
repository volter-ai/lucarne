/**
 * The general capture-corpus record language — a DOMAIN-AGNOSTIC provenance record shape any
 * capture sensor can write into and any consumer can read back, regardless of what kind of thing it
 * captured (a social post, a GitHub issue, an arXiv abstract, …).
 *
 * LS-29 (the generalize-records split): this file used to hard-code a closed social/microblogging
 * domain (a closed `Source` union of a handful of named sites, `Profile`/`Post`/`Comment` with their
 * own site-specific fields) directly into what was meant to be a general engine primitive — the
 * finding was that "nothing general may remain locked in a downstream app" cuts both ways: nothing
 * DOMAIN-SPECIFIC may be baked into what's supposed to be general either. That closed domain schema
 * (closed `Source`, `EngagementMetrics`/`ProfileMetrics`/`AuthorRef`/`Container`, narrowed
 * `Profile`/`Post`/`Comment`) has MOVED downstream, to a domain package that builds its own
 * projection ON TOP of the general `CorpusRecord` shape below — see that package's schema module for
 * the refinement pattern this file's own header describes.
 *
 * THE SEAM (no on-disk change): every domain-specific field a sensor writes (author, container,
 * parentUrl, media, handle, bio, …) rides along OPAQUELY as a top-level field on `CorpusRecord` (the
 * index signature below) — `store.ts`'s merge logic treats it as an opaque donor-wins payload (see
 * that file's header), never inspecting it by name except for the handful of GENERAL fields declared
 * here (`text`/`metrics`/`stub`/`capture`/`raw`) plus the one legacy content alias (`bio`, honored by
 * `store.ts`'s `textOf` for a profile-shaped record — see that file). This means the JSONL on disk
 * (`records.jsonl`) is BYTE-IDENTICAL in shape to what a pre-LS-29 social-only store would have
 * written; only the TypeScript surface widened, not the storage format.
 *
 * Design rules (unchanged from the original, LS-03-ported, header):
 *  - Every record carries `provenance` so a consumer can cite, link, and reason about freshness.
 *    Provenance is structural, never advisory — see `validate.ts`, which makes "provenance is
 *    required" a runtime law, not just a type.
 *  - We keep a `raw` escape hatch for site/domain-specific fields a consumer doesn't want to
 *    normalize onto a top-level field, so nothing is lost — but a normalized top-level field (via the
 *    index signature) is just as legitimate; nothing is forced through `raw`.
 *
 * `Provenance.via`: `'internal-api'` denotes a passively CDP-captured wire response (never a
 * replayed/synthetic request), `'dom'` is scraped from a rendered page, `'screen'` is a passive ARIA
 * capture. `capturedUrl` is an optional forward-compat field for a sensor that wants to distinguish
 * the url it captured FROM (which may differ from the record's own `canonicalUrl`).
 */

export type Via = "internal-api" | "dom" | "screen";

/**
 * Structural provenance attached to every record. This is what makes the data trustworthy for an
 * agent: a stable identity, a clickable canonical URL, and a fetch timestamp so freshness is
 * explicit. `source` is an OPEN string — any namespace a sensor writes ("x", "github", "arxiv", …) is
 * a legitimate source; nothing here closes the set (see `validate.ts`'s `isProvenance`, which only
 * requires it be a non-empty string).
 */
export interface Provenance {
  source: string;
  /** Stable, source-scoped id (e.g. a forum item id, a status id, a GitHub issue number). */
  id: string;
  /** Canonical, user-shareable URL for this exact record. */
  canonicalUrl: string;
  /** ISO-8601 time the data was captured. */
  fetchedAt: string;
  via: Via;
  /** Optional: the url the sensor was actually observing when it captured this record, when that
   *  differs from `canonicalUrl` (forward-compat; no current sensor sets this). */
  capturedUrl?: string;
}

/**
 * Provenance for a SCREEN-sensor (ARIA) capture: a pointer back to the exact recorded moment a
 * record's fields were observed from. Kept nullable-optional exactly as the origin app wrote it,
 * since the ARIA capture plumbing that feeds this (a screen sensor) already produces `null` (not
 * just `undefined`) for an unknown field.
 */
export interface Capture {
  /** The raw ARIA snapshot file this record was parsed out of. */
  from?: string | null;
  /** The in-session screenshot it was cropped/observed from. */
  screenshot?: string | null;
  /** ISO-8601 time of the capture. */
  ts?: string | null;
  /** Why the sensor fired (navigated · scrolled · new-content · …). */
  reason?: string | null;
  /** Who was driving the session when the capture happened. */
  by?: "agent" | "human" | null;
  /** The url the capture was taken on. */
  page?: string | null;
}

/**
 * The general capture-corpus record: a `kind`-discriminated, provenance-carrying object whose
 * domain-specific fields (author, container, parentUrl, media, handle, bio, …) ride along OPAQUELY
 * via the index signature — this package never inspects them by name (see this file's header). `kind`
 * is an OPEN string (a sensor picks its own convention — "post"/"comment"/"profile" for a social
 * domain, "issue"/"pr" for a code-forge domain, "abstract" for a papers domain, …); `store.ts` carries
 * ZERO `kind`-literals (LS-33) — it never inspects `kind`'s VALUE, only that two records being merged
 * share the SAME one. `bio` is honored as a legacy content-length alias for richest-text-wins
 * regardless of `kind` (`store.ts`'s `textOf`, read-only — the merge always WRITES the winner to
 * `text`) — everything about `kind` is a caller convention, not a closed set this package enforces.
 */
export interface CorpusRecord {
  kind: string;
  provenance: Provenance;
  /** Normalized content text, when the domain has a natural "body" (a post's text, an issue's
   *  description, an abstract). Absent is legitimate for a record with no natural body text. */
  text?: string;
  /** Normalized numeric signals (likes/score/followers/stars/…), when the domain has any. Absent or
   *  per-key `null`/`undefined` are all legitimate — "no metric known", not "zero". */
  metrics?: Record<string, number | null | undefined>;
  /** Explicit real/stub signal: `true` for a minted placeholder (identity known, content not yet
   *  observed), `false`/absent for a genuine capture. When present this is AUTHORITATIVE for
   *  `store.ts`'s `mergeEntity` stub-never-degrades invariant — see that file's header. */
  stub?: boolean;
  /** SCREEN-sensor provenance: the ARIA/screenshot capture this record's fields were observed from.
   *  Present on `via:'screen'` records; absent for wire/DOM-sourced records. */
  capture?: Capture;
  /** Escape hatch for domain-specific fields a sensor doesn't want to normalize onto a top-level
   *  field. Nothing is forced through here — a top-level field via the index signature below is
   *  equally legitimate. */
  raw?: Record<string, unknown>;
  /** Every other field a domain's sensor writes (author, container, parentUrl, threadRootUrl, depth,
   *  handle, bio, media, …) rides along here, OPAQUELY — this package never reads or writes any of
   *  them by name. A downstream domain package refines `CorpusRecord` with its own named interfaces
   *  over exactly these same top-level field names — see this package's README for the pattern. */
  [domainField: string]: unknown;
}

/** Back-compat alias — every pre-LS-29 consumer imported `Entity`; it now names the GENERAL record
 *  shape rather than a closed domain union. A downstream domain package may still define its own
 *  narrower `Entity` (e.g. a `Profile | Post | Comment` union) for its own typed reads — the two
 *  names are independent, not in conflict, since a domain-narrowed record is always structurally
 *  assignable to this general shape (see this file's header). */
export type Entity = CorpusRecord;

/**
 * A page of results from a list-returning operation (search, comments, timeline).
 *
 * Pagination is explicit so a consumer can always fetch more and is never misled into thinking a
 * truncated result is complete:
 *  - `nextCursor` is an OPAQUE token; pass it back as the call's `cursor` to get the next page.
 *    Absent means there is no known next page.
 *  - `truncated` is true whenever more items exist beyond this page — even when `nextCursor` is
 *    absent (e.g. sources that can't paginate statelessly).
 */
export interface Page<T> {
  items: T[];
  nextCursor?: string;
  truncated: boolean;
}

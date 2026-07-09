/**
 * `unitToRecord()` — maps cadence's fact-unit shape (`cadence/src/units.ts`'s
 * `Unit = Post | Comment | StubPost`, `cadence/src/types.ts:42-69`) onto this
 * package's normalized `Entity` schema, with `Provenance.via: 'screen'` (LS-04).
 *
 * This is the seam LS-13 (recall's screen sensor) writes through: cadence's
 * ARIA extractor (`units.ts:33-103`, ported to `lucarne-records/sites/x-aria.ts`
 * in LS-05) parses one `Unit` per post/comment; `unitToRecord` turns each into
 * a record `appendRecords` (`store.ts`) can merge into the shared store.
 *
 * `Unit` itself is NOT imported from cadence (this package stays dependency-
 * free and cadence is a separate app, not a workspace dependency of
 * `lucarne-records`) — the shape below is a faithful structural copy of
 * `cadence/src/types.ts:7-69`, kept only as wide as `unitToRecord` needs.
 *
 * FIELD MAPPING (per LS-04's spec):
 *   Unit.id            ('x:<sid>')  → provenance.source (the channel) + provenance.id (the bare sid)
 *   Unit.permalink                  → provenance.canonicalUrl
 *   Unit.handle                     → author.handle (leading '@' stripped) + author.profileUrl
 *   Unit.text                       → text (verbatim, including '' for a stub or image-only post)
 *   Unit.created_at                 → createdAt (omitted when null)
 *   Unit.metrics.{likes,reposts,replies,views} → metrics.{score,reposts,replies,views}
 *   Unit.metrics.bookmarks          → raw.bookmarks (no EngagementMetrics field for it)
 *   Unit.media                      → raw.media (schema has no first-class media field)
 *   Unit.capture                    → capture (the shape matches `Capture` field-for-field)
 *   Unit.stub (posts only)          → stub: Boolean(unit.stub) — ALWAYS set explicitly (never left
 *                                      `undefined`), so `store.ts`'s `mergeEntity` reads an authoritative
 *                                      signal instead of falling back to the "is text empty?" heuristic.
 *   Comment.parent      ('x:<sid>') → parentUrl + threadRootUrl (cadence's model is flat: every comment's
 *                                      `parent` already points at the THREAD ROOT, never an intermediate
 *                                      reply — `cadence/src/types.ts:40-41` — so parentUrl and
 *                                      threadRootUrl are the same derived URL; depth is always 0).
 */

import type { AuthorRef, Comment, Entity, EngagementMetrics, Post, Provenance, Source } from "./schema.js";
import type { Capture } from "./schema.js";

/** cadence's `Channel` (`cadence/src/types.ts:13`) — wider than this schema's `Source`. */
export type UnitChannel = "x" | "reddit" | "hackernews" | "linkedin";

/** cadence's `Handle` (`cadence/src/types.ts:14`): always `@`-prefixed. */
export type UnitHandle = `@${string}`;

/** Structural copy of cadence's `Metrics` (`cadence/src/types.ts:26-32`). */
export interface UnitMetrics {
  replies?: number;
  reposts?: number;
  likes?: number;
  bookmarks?: number;
  views?: number;
}

/** Structural copy of cadence's `Media` (`cadence/src/types.ts:34-37`). */
export interface UnitMedia {
  image: string;
  alt: string;
}

/**
 * Structural copy of cadence's `Capture` (`cadence/src/types.ts:17-24`) — this
 * is exactly `schema.ts`'s `Capture`, re-exported under the cadence-facing name
 * so callers porting fixtures from cadence can use the field names verbatim.
 */
export type UnitCapture = Capture;

interface UnitBase {
  /** Branded `'<channel>:<sid>'`, e.g. `'x:1234567890123456789'`. */
  id: string;
  channel: UnitChannel;
  handle: UnitHandle | null;
  permalink: string;
  text: string;
  created_at: string | null;
  metrics: UnitMetrics;
  capture: UnitCapture;
  media?: UnitMedia[];
  /** A minted placeholder (StubPost narrows this to `true`); absent/false on a real capture. */
  stub?: boolean;
}

export interface UnitPost extends UnitBase {
  kind: "post";
}

export interface UnitComment extends UnitBase {
  kind: "comment";
  /** The THREAD ROOT's branded id — cadence's model has no deeper nesting. */
  parent: string;
  stub?: never;
}

/** A minted placeholder root (`cadence/src/types.ts:62-68`): honest empty text + `stub:true`. */
export interface UnitStubPost extends Omit<UnitPost, "text"> {
  text: "";
  stub: true;
}

export type Unit = UnitPost | UnitComment | UnitStubPost;

function channelToSource(channel: UnitChannel): Source {
  if (channel === "x" || channel === "reddit" || channel === "hackernews") return channel;
  throw new Error(
    `unitToRecord: unsupported channel "${channel}" — lucarne-records' Source type has no mapping for it yet ` +
      `(cadence's Unit.channel also allows "linkedin", which no parser produces today)`,
  );
}

/** e.g. `'x:1234'` → `{ channel: 'x', sid: '1234' }`. */
function splitUnitId(id: string): { channel: string; sid: string } {
  const i = id.indexOf(":");
  if (i < 0) {
    throw new Error(`unitToRecord: malformed unit id "${id}" (expected "<channel>:<sid>")`);
  }
  return { channel: id.slice(0, i), sid: id.slice(i + 1) };
}

function stripAt(handle: UnitHandle | null): string {
  return handle ? handle.replace(/^@/, "") : "unknown";
}

const HOST_OF: Record<Source, string> = {
  x: "x.com",
  reddit: "reddit.com",
  hackernews: "news.ycombinator.com",
};

/**
 * Best-effort canonical URL for a comment's thread root, given only its
 * branded `parent` id. Cadence's own stub-minting (`units.ts:97-100`) uses the
 * SAME fallback — trust the capturing page's handle only when that page's own
 * status id matches the parent's sid, else fall back to x's `i` placeholder
 * segment (which x.com resolves regardless of the actual handle).
 */
function deriveThreadRootUrl(parentId: string, page: string | null | undefined, source: Source): string {
  const { sid } = splitUnitId(parentId);
  const host = HOST_OF[source];
  if (source === "x" && typeof page === "string") {
    const m = page.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]+)\/status\/(\d+)/);
    if (m && m[2] === sid) return `https://${host}/${m[1]}/status/${sid}`;
  }
  return `https://${host}/i/status/${sid}`;
}

/**
 * Map a cadence `Unit` (post, comment, or minted stub) to a `lucarne-records`
 * `Entity` (`Post` or `Comment`), with `provenance.via: 'screen'`.
 *
 * Lossless in the sense that every `Unit` field is carried through: normalized
 * fields where the schema has a direct equivalent (see the field mapping table
 * in this file's header), `raw.bookmarks`/`raw.media` for the two cadence
 * fields the schema doesn't normalize, and the full `capture` pointer verbatim.
 */
export function unitToRecord(unit: Unit): Post | Comment {
  const source = channelToSource(unit.channel);
  const { sid } = splitUnitId(unit.id);
  const handle = stripAt(unit.handle);

  const provenance: Provenance = {
    source,
    id: sid,
    canonicalUrl: unit.permalink,
    fetchedAt: unit.capture.ts ?? new Date().toISOString(),
    via: "screen",
  };

  const author: AuthorRef = {
    handle,
    profileUrl: `https://${HOST_OF[source]}/${handle}`,
  };

  const metrics: EngagementMetrics = {
    score: unit.metrics.likes,
    reposts: unit.metrics.reposts,
    replies: unit.metrics.replies,
    views: unit.metrics.views,
  };

  const raw: Record<string, unknown> = {};
  if (unit.metrics.bookmarks !== undefined) raw.bookmarks = unit.metrics.bookmarks;
  if (unit.media && unit.media.length) raw.media = unit.media;

  const shared = {
    provenance,
    author,
    text: unit.text,
    ...(unit.created_at ? { createdAt: unit.created_at } : {}),
    metrics,
    capture: unit.capture,
    ...(Object.keys(raw).length ? { raw } : {}),
  };

  if (unit.kind === "comment") {
    const threadRootUrl = deriveThreadRootUrl(unit.parent, unit.capture.page, source);
    const comment: Comment = {
      kind: "comment",
      ...shared,
      // cadence's model is flat — `parent` IS the thread root, so both URLs
      // are the same derived value, and depth is always 0 (no nesting depth
      // is tracked by cadence's Unit shape).
      parentUrl: threadRootUrl,
      threadRootUrl,
      depth: 0,
    };
    return comment;
  }

  const post: Post = {
    kind: "post",
    ...shared,
    // ALWAYS explicit (never `undefined`): this is the signal `mergeEntity`
    // (store.ts) treats as authoritative for stub-never-degrades, so a real
    // capture must assert `stub:false` even when its `text` is empty (e.g. an
    // image-only post) — the whole point of carrying this field at all.
    stub: Boolean(unit.stub),
  };
  return post;
}

/** Convenience: map a batch of `Unit`s in one call (the shape `appendRecords` wants). */
export function unitsToRecords(units: readonly Unit[]): Entity[] {
  return units.map(unitToRecord);
}

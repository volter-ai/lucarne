/**
 * X (x.com/twitter.com) ARIA-snapshot extractor — the SCREEN sensor's per-site
 * parser (LS-05a).
 *
 * Ported faithfully from `cadence/src/units.ts:21-103` (`extractUnits`, "PURE:
 * text in, units out" — `:33`) onto this package's `Unit` shape
 * (`../unit-to-record.js`), so its output maps to records via `unitToRecord`/
 * `unitsToRecords` (LS-04) — that mapping is reused verbatim here, never
 * reimplemented.
 *
 * Preserves, faithfully:
 *  - Snowflake-timestamp decode (`units.ts:23-25`) — an X status id encodes its
 *    authored time in its top bits (ms since the Twitter epoch), so every unit
 *    carries an exact post time for free — no extra capture, no scraped string.
 *  - player/UI-chrome stripping (`units.ts:27-31`) — X injects video-player and
 *    "Replying to"/"Translate"/etc strings as article text children; these are
 *    NOT post content and must not pollute the verbatim text.
 *  - post-vs-comment page logic (`units.ts:35-38,81`): on a thread page (the
 *    page url has `/status/<sid>`) the article matching that sid IS the post;
 *    every other article on the page is a reply/comment. On a feed (no
 *    `/status/` in the page url) every article is a top-level post.
 *  - stub-parent minting (`units.ts:92-101`): a comment's parent is ALWAYS the
 *    thread root; if the root itself never appeared in this snapshot, a
 *    placeholder Post is minted from its KNOWN id+handle (both recoverable
 *    from the page url) so no comment is ever orphaned. `text:''` + `stub:true`
 *    is honest — the thread's existence is known, not its content — and
 *    upgrades to a full post the moment the root is ever captured for real
 *    (`store.ts`'s stub-never-degrades merge, LS-03).
 *
 * PURE: no filesystem access, no network, no DOM — text in, `Unit[]`/records out. The
 * caller (recall's SCREEN sensor, LS-13) is responsible for obtaining `aria`
 * (e.g. Playwright's `locator('body').ariaSnapshot()`) and the `capture`
 * pointer; this module never reads a file or drives a page itself.
 */

import type { Entity } from "../schema.js";
import type { Unit, UnitCapture, UnitComment, UnitHandle, UnitMetrics, UnitPost, UnitStubPost } from "../unit-to-record.js";
import { unitsToRecords } from "../unit-to-record.js";

const num = (blob: string, re: RegExp): number | undefined => {
  const m = blob.match(re);
  return m ? parseInt(m[1]!.replace(/,/g, ""), 10) : undefined;
};

// X status IDs are Snowflakes: the AUTHORED time is encoded in the id (top bits
// = ms since the Twitter epoch). So every unit carries an exact post time for
// free — no extra capture, no scraping a timestamp string.
const X_EPOCH = 1288834974657n;
export function snowflakeTime(sid: string): string | null {
  try {
    return new Date(Number((BigInt(sid) >> 22n) + X_EPOCH)).toISOString();
  } catch {
    return null;
  }
}

// X injects player/UI strings as article text children (not post content) —
// drop them from the verbatim text.
const CHROME = [
  /^\d{1,2}:\d{0,2}( \/ \d{1,2}:\d{2})?$/,
  /Video will play after ad/i,
  /Skip Ad in/i,
  /Embedded video/i,
  /Play Video\b/i,
  /^Visit /,
  /^\d+ seconds? long$/i,
  /^Show (more|this thread)$/i,
  /^Translate/i,
  /^Replying to/i,
  /^GIF$/i,
  /^Image$/i,
  /^Quote$/i,
  /^Verified account$/i,
];
const isChrome = (s: string): boolean => CHROME.some((re) => re.test(s));

/**
 * Parse one ARIA snapshot (X's article shape) into fact-only `Unit`s. PURE:
 * text in, units out.
 */
export function extractXAriaUnits(aria: string, capture: UnitCapture = {}): Unit[] {
  const lines = String(aria || "").split("\n");
  // POST vs COMMENT: on a thread page (url has /status/<sid>) the article matching
  // that sid is THE post; the rest are replies/comments. On a feed (no /status/ in
  // the page url) every article is a top-level post.
  const pm = String(capture.page || "").match(/\/status\/(\d+)/);
  const pageSid = pm ? pm[1] : null;
  // the thread root's HANDLE from the page url (x.com/<handle>/status/<id>) — so a
  // minted stub parent (below) is addressable even when the root post itself never
  // appeared in a capture.
  const phm = String(capture.page || "").match(/(?:x|twitter)\.com\/([A-Za-z0-9_]+)\/status\/\d+/);
  const pageHandle = (phm ? "@" + phm[1] : null) as UnitHandle | null;
  const out: Unit[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = lines[i]!.match(/^(\s*)- article "/);
    if (!m) {
      i++;
      continue;
    }
    const base = m[1]!.length;
    const childPad = " ".repeat(base + 2);
    const block: string[] = [lines[i]!];
    let j = i + 1;
    while (j < lines.length) {
      const ind = lines[j]!.match(/^(\s*)/)![1]!.length;
      if (lines[j]!.trim() && ind <= base) break;
      block.push(lines[j]!);
      j++;
    }
    i = j;
    // the PERMALINK = the first /<handle>/status/<id> link (the timestamp) → the
    // unit's stable id + handle
    let handle: UnitHandle | null = null;
    let sid: string | null = null;
    for (const l of block) {
      const p = l.match(/\/url:\s*\/([A-Za-z0-9_]+)\/status\/(\d+)/);
      if (p) {
        handle = ("@" + p[1]!) as UnitHandle;
        sid = p[2]!;
        break;
      }
    }
    if (!sid) continue; // no permalink → not an addressable unit (ad slot, separator, etc.)
    // PROMOTED/AD posts carry a direct `text: Ad` child — they're not the pilot's
    // niche corpus, so drop them.
    if (
      block
        .slice(1)
        .some((l) => l.startsWith(childPad + "- ") && l.slice((childPad + "- ").length).trim() === "text: Ad")
    ) {
      continue;
    }
    const blob = block.join(" ");
    // metrics — CASE-INSENSITIVE: feed posts render "64675 likes" (lowercase) but
    // thread replies render "0 Likes. Like" / "0 Replies. Reply" (capitalized)
    // inside the action group, so /i catches both.
    const metrics: UnitMetrics = {
      replies: num(blob, /([\d,]+) repl(?:y|ies)/i),
      reposts: num(blob, /([\d,]+) reposts?/i),
      likes: num(blob, /([\d,]+) likes?/i),
      bookmarks: num(blob, /([\d,]+) bookmarks?/i),
      views: num(blob, /([\d,]+) views?/i),
    };
    // VERBATIM text = the article's DIRECT text children, up to the quote-tweet or
    // the metrics group (deeper-nested text — the author label, the quoted post —
    // is at a greater indent, so it's excluded). Drop player/UI CHROME (video
    // "Skip Ad" / "Video will play after ad" / duration timestamps / "Replying to" /
    // "Translate") that X injects as text children and which would otherwise
    // pollute the verbatim post text.
    const text: string[] = [];
    for (const l of block.slice(1)) {
      if (!l.startsWith(childPad + "- ")) continue;
      const t = l.slice((childPad + "- ").length);
      if (t.startsWith('group "') && /repl/.test(t)) break; // metrics group → end of this post's content
      const bm = t.match(/^button\s+"([^"]*)"/); // a media/player BUTTON ends the post text (video/quote follows)
      if (bm && /^(Play Video|Play \d|Skip Ad|Embedded video)/i.test(bm[1]!)) break;
      const tm = t.match(/^text:\s*(.*)$/);
      if (tm) {
        const s = tm[1]!.replace(/^"|"$/g, "");
        // the MEDIA/PLAYER region begins here → everything after is chrome
        // (duration, "Skip Ad", the quoted post)
        if (
          s === "Quote" ||
          /Embedded video|Video will play after ad|Skip Ad in|Play Video/i.test(s) ||
          /^\d{1,2}:\d{2}( of | \/ )/.test(s)
        ) {
          break;
        }
        if (s && !/^@\w+$/.test(s) && !isChrome(s)) text.push(s);
      }
    }
    const kind: "post" | "comment" = pageSid ? (sid === pageSid ? "post" : "comment") : "post";
    // strip a TRAILING video-duration token ("… 1:26", "tomorrow. 0:32") — X
    // sometimes bakes the player's duration overlay into the caption's own
    // accessible text, so it can't be split as a separate child.
    const cleanText = text
      .join(" ")
      .replace(/\s+/g, " ")
      .replace(/\s*\b\d{1,2}:\d{2}\s*$/, "")
      .trim();
    const permalink = `https://x.com/${handle!.slice(1)}/status/${sid}`;
    const created_at = snowflakeTime(sid);
    if (kind === "comment") {
      const comment: UnitComment = {
        id: "x:" + sid,
        channel: "x",
        kind: "comment",
        handle,
        permalink,
        text: cleanText,
        created_at,
        metrics,
        capture,
        parent: "x:" + pageSid!,
      };
      out.push(comment);
    } else {
      const post: UnitPost = {
        id: "x:" + sid,
        channel: "x",
        kind: "post",
        handle,
        permalink,
        text: cleanText,
        created_at,
        metrics,
        capture,
      };
      out.push(post);
    }
  }
  // STUB-UPSERT — every comment's parent is the thread root. If the root itself
  // wasn't captured in THIS snapshot (it moved above the viewport / virtualized
  // out of the DOM), mint a STUB post from its KNOWN id+handle (we have both from
  // the page url) so no comment is ever orphaned. text:'' + stub:true is honest —
  // we know the thread exists, not its content; it upgrades to a full post IN
  // PLACE the moment the root is ever seen (the store's merge keeps the richest
  // text and drops the stub flag, `store.ts`). This makes "every comment has a
  // parent" a structural invariant.
  if (pageSid && out.some((u) => u.kind === "comment") && !out.some((u) => u.id === "x:" + pageSid)) {
    const stub: UnitStubPost = {
      id: "x:" + pageSid,
      channel: "x",
      kind: "post",
      stub: true,
      handle: pageHandle,
      permalink: `https://x.com/${(pageHandle || "@i").slice(1)}/status/${pageSid}`,
      text: "",
      created_at: snowflakeTime(pageSid),
      metrics: {},
      capture,
    };
    out.push(stub);
  }
  return out;
}

/**
 * Convenience: extract + map straight to `lucarne-records` `Entity` records
 * (`provenance.via:'screen'`) via `unitsToRecords` (LS-04) — never reimplements
 * that mapping. This is the function the SCREEN sensor (LS-13) is expected to
 * call: ARIA text in, records out.
 */
export function extractXAriaRecords(aria: string, capture: UnitCapture = {}): Entity[] {
  return unitsToRecords(extractXAriaUnits(aria, capture));
}

/**
 * A ready `{match, extract}` plugin for LS-13's extractor registry
 * ("Extractors are plugins ({match, extract} — cadence passes LS-05's X ARIA
 * extractor)", CADENCE-SPLIT-TASKSPEC.md §2 LS-13). `match` accepts any
 * x.com/twitter.com page url; `extract` is `extractXAriaRecords`.
 */
export const xAriaExtractor: {
  match: (url: string) => boolean;
  extract: (aria: string, capture?: UnitCapture) => Entity[];
} = {
  match: (url: string) => /(?:^|\/\/)(?:www\.)?(?:x|twitter)\.com\//.test(String(url || "")),
  extract: extractXAriaRecords,
};

// wire.ts — the WIRE sensor (LS-13W): a SECOND passive sensor on the SAME recorder as the screen
// sensor (`index.ts`), observing the site app's OWN JSON/GraphQL responses via CDP's `Network`
// domain as they fly by during genuine human browsing.
//
// SAFETY LAW 3 / §1.3-§1.3a ("behave like a user" / no-synthetic-requests): this module issues
// ZERO requests of its own. `Network.enable` (via `RecallConnection#networkSession`) plus
// `Network.responseReceived`/`Network.loadingFinished`/`Network.getResponseBody` are OBSERVE-ONLY
// — they read traffic the PAGE's own JS already generated. The CDP `Fetch` domain (which PAUSES and
// can rewrite/replay a request) is categorically never used — see test/recall-readonly-gates.mjs's
// "Network is the only new domain" gate. This sensor never opens a tab, never navigates, never
// scrolls, never re-issues or paginates a site endpoint; it only watches.
//
// This REPLACES claude-socials's MV3 extension + ws bridge + MAIN-world fetch/XHR tee
// (`packages/extension/src/content/x-main.ts`) — §1.3a's verdict is that a CDP-level passive tap on
// the SAME bytes is adopted instead of a MAIN-world monkeypatch relayed over a bridge; the operation
// dispatch table below is preserved from that file's `isGraphql`/`opOf` helpers (:29-33) and from
// `lucarne-records/sites/x-graphql.ts`'s own header, which records the operationName -> parser
// mapping this module was written against.
//
// Records this sensor writes carry `provenance.via:'internal-api'` (LS-04's `Provenance.via` doc)
// and land in the SAME `lucarne-records` store the screen sensor writes to, via the same
// `appendRecords` — ONE recorder, two independent sensors, one store.
import type { CDPSession, Page } from "playwright-core";
import type { Entity } from "lucarne-records";
import { appendRecords, parseSearchTimeline, parseTweetDetail, parseUserTweets, tweetToPost, userResultToProfile, type SearchType } from "lucarne-records";
import type { RecallConnection } from "./connection.js";
import type { RecallSignal } from "./types.js";

/** Safe nested getter — same shape as `x-graphql.ts`'s own private `dig`, kept local here so this
 *  module has no non-parser coupling to that file beyond its exported functions. */
function dig(obj: unknown, path: string[]): any {
  let cur: any = obj;
  for (const key of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Does this url look like an x GraphQL endpoint? Ported verbatim from claude-socials's
 *  `x-main.ts:29`'s `isGraphql`. */
export function isXGraphqlUrl(url: string): boolean {
  return url.includes("/i/api/graphql/");
}

/** Extract the x GraphQL operationName from a `/i/api/graphql/<queryId>/<OperationName>` url —
 *  ported verbatim from claude-socials's `x-main.ts:30-33`'s `opOf`. Returns `null` for a url that
 *  doesn't match the GraphQL shape at all. */
export function xOperationNameOf(url: string): string | null {
  const m = url.match(/\/i\/api\/graphql\/[^/]+\/([^/?]+)/);
  return m ? m[1]! : null;
}

/**
 * Which kind of items a `SearchTimeline` response holds, recovered from the REQUEST url's own
 * `variables.product` query param ('People' -> 'users', else 'posts') — the response body alone
 * never carries this (`parseSearchTimeline`'s own doc). This is claude-socials's `x.ts:356-357`
 * `searchMetaFromUrl` logic, reimplemented here (not ported verbatim, since LS-05b's header notes
 * that function parsed a *request* url rather than a response body and so was out of that package's
 * scope) — it is pure URL/query-string parsing, never a request of its own, so it belongs to the
 * wire sensor that owns "how do I read the request this response came back for".
 */
export function searchTypeFromUrl(url: string): SearchType {
  try {
    const u = new URL(url);
    const raw = u.searchParams.get("variables");
    if (raw) {
      const vars = JSON.parse(raw);
      if (vars && typeof vars === "object" && (vars as Record<string, unknown>).product === "People") return "users";
    }
  } catch {
    /* malformed/absent `variables` query param -> fall through to the 'posts' default below */
  }
  return "posts";
}

/**
 * A registered WIRE site adapter — this sensor's plugin contract, mirroring `RecallExtractor`'s
 * shape for the screen sensor (`types.ts`): `match` decides whether this adapter owns a captured
 * response's url, `dispatch` is PURE (JSON in, normalized records out — no filesystem/network
 * access of its own) so it is independently Chrome-free unit-testable off a captured-response
 * fixture (test/recall-wire-dispatch.mjs) without ever touching a browser. A throwing `dispatch`
 * must never break the sensor or any sibling adapter — see `dispatchWireAdapters` below.
 */
export interface WireSiteAdapter {
  match(url: string): boolean;
  /** `requestUrl` is the response's OWN request url (including its query string — some operations,
   *  e.g. x's `SearchTimeline`, need it since the response body doesn't carry everything). Must
   *  never throw; return `[]` for an operation this adapter doesn't recognize or a payload it can't
   *  parse. */
  dispatch(requestUrl: string, payload: unknown): Entity[];
}

/**
 * x's wire adapter — the operationName -> pure-parser dispatch table named in
 * the split task spec, §2 LS-13W / preserved in `x-graphql.ts`'s header:
 *   `UserByScreenName`/`UserByRestId` -> `userResultToProfile(dig(payload,['data','user','result']))`
 *   `TweetResultByRestId`             -> `tweetToPost(dig(payload,['data','tweetResult','result']))`
 *   `TweetDetail`                     -> `parseTweetDetail(payload)`
 *   `SearchTimeline`                  -> `parseSearchTimeline(payload, type)`, `type` from the
 *                                          REQUEST url's `variables.product` (`searchTypeFromUrl`)
 *   `UserTweets`                      -> `parseUserTweets(payload)`
 * PURE: only `lucarne-records`' already-pure parsers + this module's own request-url parsing — no
 * I/O of its own.
 */
export const xWireAdapter: WireSiteAdapter = {
  match: isXGraphqlUrl,
  dispatch(requestUrl, payload) {
    const op = xOperationNameOf(requestUrl);
    if (!op) return [];
    try {
      switch (op) {
        case "UserByScreenName":
        case "UserByRestId": {
          const p = userResultToProfile(dig(payload, ["data", "user", "result"]));
          return p ? [p] : [];
        }
        case "TweetResultByRestId": {
          const p = tweetToPost(dig(payload, ["data", "tweetResult", "result"]));
          return p ? [p] : [];
        }
        case "TweetDetail": {
          const r = parseTweetDetail(payload);
          return r.post ? [r.post, ...r.comments] : [...r.comments];
        }
        case "SearchTimeline": {
          const type = searchTypeFromUrl(requestUrl);
          return parseSearchTimeline(payload, type).items;
        }
        case "UserTweets":
          return parseUserTweets(payload).posts;
        default:
          return []; // an operation not in the dispatch table above — not this adapter's concern
      }
    } catch {
      return []; // a malformed/unexpected payload for a known op must never break capture
    }
  },
};

/**
 * Dispatch one captured response through every adapter whose `match(requestUrl)` is true,
 * concatenating records — mirrors `capture.ts`'s `dispatchExtractors` selection loop exactly, so
 * the wire sensor's plugin posture matches the screen sensor's. PURE (no I/O); one throwing
 * adapter never breaks capture or its siblings.
 */
export function dispatchWireAdapters(requestUrl: string, payload: unknown, adapters: readonly WireSiteAdapter[]): Entity[] {
  let records: Entity[] = [];
  for (const adapter of adapters) {
    if (!adapter.match(requestUrl)) continue;
    try {
      records = records.concat(adapter.dispatch(requestUrl, payload));
    } catch {
      /* one misbehaving adapter must never break capture or its siblings */
    }
  }
  return records;
}

export interface WireSensorOptions {
  dataDir: string;
  /** Registered site adapters — the caller supplies these (mirrors `StartRecallOptions.extractors`
   *  for the screen sensor); `index.ts` defaults this to `[xWireAdapter]`. */
  adapters: readonly WireSiteAdapter[];
  /** Fired for every response that produced at least one record — a `kind:'wire'` `RecallSignal`
   *  (`types.ts`), the SAME union `startRecall`'s screen-sensor `observers` already consume. */
  emit?: (signal: RecallSignal) => void;
  /** Caller-supplied read of the deliberate on/off toggle — checked before turning a captured
   *  response into a record, so a paused recorder writes nothing while still leaving `Network`
   *  enabled (matching the screen sensor's own toggle posture, `types.ts`'s `RecallToggles` doc:
   *  recall never turns itself off, only ever obeys an external state). Absent means always on. */
  isEnabled?: () => boolean;
  /** How often to check for newly opened tabs to attach the passive `Network` tap to, ms. Default
   *  1000 — this is page DISCOVERY polling only; the actual capture is fully event-driven (CDP
   *  `Network.responseReceived`/`loadingFinished` callbacks), never a poll of a site endpoint. */
  discoverIntervalMs?: number;
}

export interface WireSensorHandle {
  /** Stop discovering new tabs and detach. Idempotent. Existing CDP sessions are left to close with
   *  their page/connection (mirrors the screen sensor's `stop()`, which closes the whole connection
   *  rather than tearing down each session individually). */
  stop(): Promise<void>;
}

/**
 * Start the WIRE sensor: for every page `conn` already knows about (and every one it discovers
 * later), enable `Network` (via `RecallConnection#networkSession` — a passive subscribe, not a
 * request) and listen for the site's own GraphQL responses.
 *
 * `Network.responseReceived` fires with the response's metadata (including its own `url`) as soon
 * as headers land; a response is only tracked (in `pending`) when its url matches a registered
 * adapter, so untracked traffic (images, scripts, unrelated XHRs) costs nothing beyond the one url
 * match check. `Network.getResponseBody` is called INSIDE the `Network.loadingFinished` handler —
 * the CDP body buffer for a finished request can be evicted once a NEW navigation starts, so asking
 * for it any later (e.g. on a timer, or after yielding to the next tick) risks losing it; firing the
 * request synchronously off `loadingFinished` is the buffer-eviction guard (LS-13W dev/03). A body
 * that's already gone (evicted, or the request errored) rejects `getResponseBody` — that promise
 * rejection is caught and the response is simply skipped, never thrown out of the sensor.
 */
export async function startWireSensor(conn: RecallConnection, opts: WireSensorOptions): Promise<WireSensorHandle> {
  const attachedPages = new WeakSet<Page>();
  // Every per-page `Network`-enabled CDP session this sensor opened, tracked so `stop()` can tear
  // them down under STANDALONE use (when there's no outer `startRecall.stop()`→`conn.close()` to
  // close the whole connection for us). Held as a plain array (not a WeakMap) precisely because
  // `stop()` needs to iterate them — the pages themselves are still referenced by the connection.
  const openedSessions: CDPSession[] = [];
  let stopped = false;

  const attach = async (page: Page): Promise<void> => {
    if (attachedPages.has(page)) return;
    attachedPages.add(page);
    let cdp: CDPSession;
    try {
      cdp = await conn.networkSession(page);
    } catch {
      return; // the page closed (or the session couldn't attach) mid-discovery — never fatal
    }
    if (stopped) return;
    openedSessions.push(cdp);

    // requestId -> the matched response's OWN url, held only long enough to bridge
    // responseReceived -> loadingFinished for a response at least one adapter cares about.
    const pendingByRequestId = new Map<string, string>();

    cdp.on("Network.responseReceived", (e: { requestId: string; response?: { url?: string } }) => {
      const url = e.response?.url ?? "";
      if (url && opts.adapters.some((a) => a.match(url))) {
        pendingByRequestId.set(e.requestId, url);
      }
    });

    // A matched request that ERRORS or is CANCELLED mid-flight (navigating away before its body
    // lands) fires `loadingFailed`, never `loadingFinished` — without this its `pendingByRequestId`
    // entry would leak for the life of the always-on recorder. This is a `.on` LISTENER, not a
    // `.send` (it issues no request; it only frees a map slot), and never throws.
    cdp.on("Network.loadingFailed", (e: { requestId: string }) => {
      pendingByRequestId.delete(e.requestId);
    });

    cdp.on("Network.loadingFinished", (e: { requestId: string }) => {
      const url = pendingByRequestId.get(e.requestId);
      if (!url) return; // not a response any registered adapter matched
      pendingByRequestId.delete(e.requestId);
      if (opts.isEnabled && !opts.isEnabled()) return; // caller's deliberate pause — obeyed, never self-toggled

      // Called synchronously off loadingFinished (never deferred to a timer/microtask boundary
      // beyond this handler's own body) — the buffer-eviction guard described above.
      cdp.send("Network.getResponseBody", { requestId: e.requestId }).then(
        (raw: { body: string; base64Encoded: boolean }) => {
          let payload: unknown;
          try {
            const text = raw.base64Encoded ? Buffer.from(raw.body, "base64").toString("utf8") : raw.body;
            payload = JSON.parse(text);
          } catch {
            return; // non-JSON or truncated body — skip, never throw
          }
          const records = dispatchWireAdapters(url, payload, opts.adapters);
          if (!records.length) return;
          const recordsAdded = appendRecords(opts.dataDir, records);
          try {
            opts.emit?.({ kind: "wire", ts: new Date().toISOString(), url, recordsAdded });
          } catch {
            /* one misbehaving observer must never break the sensor */
          }
        },
        () => {
          /* the body is already gone (evicted by a navigation, or the request errored/was
           * cancelled) — self-heal: skip this one response, never break the sensor */
        },
      );
    });
  };

  const discoverOnce = async (): Promise<void> => {
    if (stopped) return;
    try {
      const pages = await conn.pages();
      for (const page of pages) await attach(page);
    } catch {
      /* transient (e.g. the connection is mid-reconnect) — retried on the next tick, never fatal */
    }
  };

  await discoverOnce();
  const timer = setInterval(() => {
    discoverOnce().catch(() => {});
  }, opts.discoverIntervalMs ?? 1000);
  // Never hold the process open on this timer alone (mirrors how the rest of recall never blocks
  // process exit on its own background work).
  if (typeof timer === "object" && typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref();
  }

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      // Best-effort teardown of the per-page `Network`-enabled sessions this sensor opened, so a
      // STANDALONE `startWireSensor` user isn't left leaking enabled sessions. `Network.disable`
      // is domain `Network` (still within the capture allowlist — it stops observing, never issues
      // a request); each is fire-and-forget and never throws. In the INTEGRATED path this runs just
      // before `startRecall.stop()`'s `conn.close()` tears the whole connection down anyway, so it
      // changes no capture behavior there — it only makes the standalone path self-contained.
      await Promise.allSettled(openedSessions.map((cdp) => cdp.send("Network.disable")));
    },
  };
}

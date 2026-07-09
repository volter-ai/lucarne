// Recall's OWN `playwright-core` connection over the session `cdpUrl` — the replacement for
// cadence's retired arbitrary-code HTTP endpoint + cross-eval `globalThis` state (`recall.ts:53-59`'s
// `read()`). This is a
// SECOND, independent client of the same CDP endpoint the act half (`InteractSession`, session.ts)
// connects to — the engine's own tap-sharing design (`lucarne`'s `cdp.ts:1-3`) is precedent that
// concurrent CDP consumers of one target coexist; recall never imports the engine's internal
// `src/cdp.ts` (this package has no `lucarne` dependency, matching §1.6's dependency graph).
//
// Recall NEVER acts through this connection — no `goto`, no `click`, no `type`, no `send` that
// issues a request. It is used ONLY to read (ARIA snapshots, screenshots, DOM probes, screencast
// frames, and — LS-13W — the `Network` domain's passive response tap) and to resolve the browser's
// own CDP `Target.targetId` for actor attribution (LS-12's `attributeActor`).
//
// LS-13W EXTENSION: `networkSession` hands the WIRE sensor (`wire.ts`) a `Network.enable`-capable
// CDP session for a page, cached per `Page` object (same `WeakMap` posture as `#targetIds`) so a
// second call for the same page reuses the one already-enabled session rather than re-enabling.
// `Network.enable` only turns ON event delivery for traffic the PAGE itself generates — it issues
// no request of its own, and this connection never enables CDP's OTHER, request-PAUSING network
// domain — categorically banned, see test/recall-readonly-gates.mjs's domain-allowlist gate.
import type { Browser, CDPSession, Page } from "playwright-core";

export class RecallConnection {
  readonly #cdpUrl: string;
  readonly #targetIds = new WeakMap<Page, Promise<string>>();
  readonly #networkSessions = new WeakMap<Page, Promise<CDPSession>>();
  #browser: Browser | undefined;
  #connecting: Promise<Browser> | undefined;

  constructor(cdpUrl: string) {
    this.#cdpUrl = cdpUrl;
  }

  async #connect(): Promise<Browser> {
    if (this.#browser) return this.#browser;
    if (!this.#connecting) {
      const { chromium } = await import("playwright-core");
      this.#connecting = chromium.connectOverCDP(this.#cdpUrl);
    }
    this.#browser = await this.#connecting;
    return this.#browser;
  }

  /** Every open page in the connected context — recall's OWN view of the session's tabs. */
  async pages(): Promise<Page[]> {
    const b = await this.#connect();
    return b.contexts()[0]?.pages() ?? [];
  }

  /** Resolve (and cache, per Page object) the browser's own CDP `Target.targetId` for `p` — the
   *  connection-independent identity `attributeActor`/`presenceTieBreakBonus` compare against a
   *  session's `PresenceMarker.drivenTargetId`. Mirrors `InteractSession#targetIdFor` (session.ts). */
  async targetIdFor(p: Page): Promise<string> {
    let cached = this.#targetIds.get(p);
    if (!cached) {
      cached = (async () => {
        const cdp = await p.context().newCDPSession(p);
        try {
          const info = await cdp.send("Target.getTargetInfo");
          return (info as { targetInfo: { targetId: string } }).targetInfo.targetId;
        } finally {
          await cdp.detach().catch(() => {});
        }
      })();
      this.#targetIds.set(p, cached);
    }
    return cached;
  }

  /**
   * Resolve (and cache, per Page object) a CDP session for `p` with the `Network` domain enabled —
   * the WIRE sensor's only capture surface. `Network.enable` is a passive subscribe: it makes the
   * browser start DELIVERING events for network activity the page already does; it never causes the
   * page (or this connection) to issue, replay, or alter a request — that's what makes it distinct
   * from the `Fetch` domain (which pauses/mutates requests and is never used here).
   */
  async networkSession(p: Page): Promise<CDPSession> {
    let cached = this.#networkSessions.get(p);
    if (!cached) {
      cached = (async () => {
        const cdp = await p.context().newCDPSession(p);
        await cdp.send("Network.enable");
        return cdp;
      })();
      this.#networkSessions.set(p, cached);
    }
    return cached;
  }

  async close(): Promise<void> {
    if (this.#browser) {
      await this.#browser.close().catch(() => {});
      this.#browser = undefined;
      this.#connecting = undefined;
    }
  }
}

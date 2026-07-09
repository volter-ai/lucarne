// Recall's OWN `playwright-core` connection over the session `cdpUrl` — the replacement for
// cadence's retired arbitrary-code HTTP endpoint + cross-eval `globalThis` state (`recall.ts:53-59`'s
// `read()`). This is a
// SECOND, independent client of the same CDP endpoint the act half (`InteractSession`, session.ts)
// connects to — the engine's own tap-sharing design (`lucarne`'s `cdp.ts:1-3`) is precedent that
// concurrent CDP consumers of one target coexist; recall never imports the engine's internal
// `src/cdp.ts` (this package has no `lucarne` dependency, matching §1.6's dependency graph).
//
// Recall NEVER acts through this connection — no `goto`, no `click`, no `type`, no `send`. It is
// used ONLY to read (ARIA snapshots, screenshots, DOM probes, screencast frames) and to resolve the
// browser's own CDP `Target.targetId` for actor attribution (LS-12's `attributeActor`).
import type { Browser, Page } from "playwright-core";

export class RecallConnection {
  readonly #cdpUrl: string;
  readonly #targetIds = new WeakMap<Page, Promise<string>>();
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

  async close(): Promise<void> {
    if (this.#browser) {
      await this.#browser.close().catch(() => {});
      this.#browser = undefined;
      this.#connecting = undefined;
    }
  }
}

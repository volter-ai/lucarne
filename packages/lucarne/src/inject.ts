import { attachBrowser, attachPage, listPages, type CdpConn } from "./cdp.js";

/** One durable script injection: the source to run + whether the page's CSP must be bypassed to run it. */
export interface StickyDef {
  source: string;
  bypassCSP: boolean;
}

/**
 * Accept/reject an injection id. Default (no policy passed) is PERMISSIVE — every
 * id is accepted. A caller (e.g. cadence's shell-only allow-list, wired in LS-20)
 * supplies a stricter predicate; this hook only decides accept/reject, it knows
 * nothing about what "shell" or "content" mean.
 */
export type InjectPolicy = (id: string) => boolean;

interface PageSession {
  cdp: CdpConn;
  /** CDP script identifier per injection id, so a later removal targets the right registration. */
  scriptIds: Map<string, string>;
  cspEnabled: boolean;
}

/**
 * Sticky, per-session script injection over the engine's OWN raw CDP client — no
 * Playwright involved (see `cdp.ts`). Ported from cadence's eval-server sticky
 * store (`cadence/src/browser/server.ts:124-208`), which rode a Playwright
 * `BrowserContext`'s `page` event to cover new tabs; the engine has none, so
 * coverage of newly opened tabs instead comes from raw CDP target discovery
 * (`Target.setDiscoverTargets` → `Target.targetCreated`, see `start()` below).
 *
 * Three invariants carried over from the cadence original:
 *  - `Page.addScriptToEvaluateOnNewDocument` re-runs the script on every
 *    reload/navigation for free — that's what makes it "sticky".
 *  - `Page.setBypassCSP` is bound to the CDP SESSION's lifetime, not the page's —
 *    dropping the session silently drops the bypass on the next reload. So a
 *    LIVE per-page CDP session is held for as long as the page is open, not
 *    reopened per call.
 *  - A script registered on a page that already has a document loaded (the
 *    common case — you rarely inject into a fresh blank page) needs to also be
 *    evaluated into that already-loaded document; `addScriptToEvaluateOnNewDocument`
 *    only covers documents loaded AFTER it's registered.
 *
 * Lifecycle: LAZY. The browser-level discovery tap (one CDP socket + a
 * `targetCreated`/`targetDestroyed` stream) only opens once there's something to
 * cover — the first `set()`, or a boot-restore that re-applies a non-empty
 * persisted set. A session that never injects pays nothing (matters on a
 * "don't behave like a bot" tool, and on attached FOREIGN browsers we shouldn't
 * touch beyond what's asked).
 */
export class InjectionStore {
  private readonly sticky = new Map<string, StickyDef>();
  private readonly pageSessions = new Map<string, PageSession>();
  /** Every page target we know is open (from the initial list + `Target.targetCreated`/`targetDestroyed`) — the set `applyAll()` walks; a page only gets a live CDP session in `pageSessions` lazily, once there's something to apply to it. */
  private readonly knownTargets = new Set<string>();
  /** Per-target promise chain so a `set()`→`applyAll()` and a `targetCreated` for the SAME target never interleave and double-register (which would orphan the first script id). */
  private readonly applyChains = new Map<string, Promise<void>>();
  private readonly policy: InjectPolicy;
  private browserConn: CdpConn | undefined;
  private started = false;
  private closed = false;

  constructor(private readonly cdpUrl: string, policy?: InjectPolicy) {
    this.policy = policy ?? (() => true);
  }

  /** Ids currently registered AND accepted by the policy — a policy-rejected id is never listed, even if it was accepted under a since-changed policy. */
  ids(): string[] {
    return [...this.sticky.keys()].filter((id) => this.policy(id));
  }

  /** The raw desired-state map (unfiltered by policy) — for persisting into the session spec. See `ids()` for the served/GET view. */
  snapshot(): Record<string, StickyDef> {
    const out: Record<string, StickyDef> = {};
    for (const [id, def] of this.sticky) out[id] = def;
    return out;
  }

  /**
   * Register/replace a sticky injection. Rejected by the policy → throws (the
   * HTTP route turns this into a 4xx) and nothing is stored — a rejected id can
   * therefore never appear in `ids()`/persisted state.
   */
  async set(id: string, source: string, bypassCSP = false): Promise<void> {
    if (!this.policy(id)) throw new Error(`lucarne: injection '${id}' rejected by policy`);
    // LAZY: the first injection is what opens the browser-level discovery tap.
    // Best-effort — like cadence's `/sticky`, the DESIRED STATE is recorded even
    // if the browser can't be reached right now (it's applied on the next
    // reachable moment / a restart), so a transient CDP hiccup never loses an id.
    await this.start().catch(() => { /* browser not reachable yet — state still recorded below */ });
    await this.clearId(id); // drop any prior per-page registration before re-registering
    this.sticky.set(id, { source, bypassCSP });
    await this.applyAll();
  }

  /** Drop a sticky injection. Idempotent — removing an absent id is a no-op. */
  async remove(id: string): Promise<void> {
    await this.clearId(id);
    this.sticky.delete(id);
  }

  /**
   * Start covering this session's pages: apply the current sticky set to every
   * open page now (this is also the BOOT-RESTORE path — a fresh engine process
   * re-seeds `sticky` from the persisted session spec by calling `set()` per
   * entry, and the first such `set()` calls this), then keep covering pages that
   * open LATER. Idempotent: safe to call on every `set()`; opens the browser tap
   * only once.
   */
  async start(): Promise<void> {
    if (this.started || this.closed) return;
    await this.openBrowserTap();   // may throw if the browser isn't reachable yet
    this.started = true;           // only latch success, so a failed first attempt retries on the next set()
  }

  /**
   * Open (or, after a drop, RE-open) the browser-level discovery tap: list the
   * open pages and apply to each, then subscribe to target churn so new tabs are
   * covered and closed tabs release their per-page session.
   *
   * New-tab coverage: cadence rode Playwright's `context.on('page', ...)`; the
   * engine has no Playwright `BrowserContext`, so this attaches to the session's
   * BROWSER-level CDP endpoint and turns on target discovery
   * (`Target.setDiscoverTargets`) — `Target.targetCreated` then fires for every
   * new target, which this applies (page targets only) exactly like an
   * already-open one. (`Target.setAutoAttach` is deliberately NOT used: it emits
   * `attachedToTarget`, not `targetCreated`, and would make Chrome attach a
   * debugger session to every target — needless here, and rude on an attached
   * foreign browser — while `setDiscoverTargets` alone gives us the events.)
   */
  private async openBrowserTap(): Promise<void> {
    if (this.closed) return;
    for (const t of await listPages(this.cdpUrl)) {
      this.knownTargets.add(t.id);
      await this.applyToTarget(t.id).catch(() => { /* a page that's already gone — nothing to cover */ });
    }
    const conn = await attachBrowser(this.cdpUrl);
    if (this.closed) { try { conn.close(); } catch { /* ignore */ } return; }
    this.browserConn = conn;
    conn.on("Target.targetCreated", (p: { targetInfo?: { targetId: string; type: string } }) => {
      if (p.targetInfo?.type !== "page") return;
      const targetId = p.targetInfo.targetId;
      this.knownTargets.add(targetId);
      void this.applyToTarget(targetId).catch(() => { /* races the tab's own close — ignore */ });
    });
    conn.on("Target.targetDestroyed", (p: { targetId?: string }) => {
      if (!p.targetId) return;
      this.knownTargets.delete(p.targetId);
      const s = this.pageSessions.get(p.targetId);
      if (s) { try { s.cdp.close(); } catch { /* already gone */ } this.pageSessions.delete(p.targetId); }
    });
    // RESILIENCE: if this discovery socket drops while Chrome lives (a transient
    // blip), target-churn coverage would otherwise die silently. Re-open once on
    // close (unless WE closed it, or it was already superseded). A genuinely-dead
    // Chrome makes the re-attach throw → swallow + log (degraded, not a crash);
    // the fresh tap's own onClose re-arms this for the next blip.
    conn.onClose(() => {
      if (this.closed || this.browserConn !== conn) return;
      this.browserConn = undefined;
      this.openBrowserTap().catch(() => { console.warn(`lucarne: inject discovery tap for ${this.cdpUrl} dropped and could not be re-opened — new-tab coverage degraded until the next inject`); });
    });
    await conn.call("Target.setDiscoverTargets", { discover: true }).catch(() => { /* best-effort */ });
  }

  /** Release every held per-page CDP session + the browser-level discovery tap (session teardown). */
  close(): void {
    this.closed = true;
    for (const s of this.pageSessions.values()) { try { s.cdp.close(); } catch { /* ignore */ } }
    this.pageSessions.clear();
    try { this.browserConn?.close(); } catch { /* ignore */ }
  }

  /** Drop one id's registration from every page that currently holds it. */
  private async clearId(id: string): Promise<void> {
    for (const s of this.pageSessions.values()) {
      const scriptId = s.scriptIds.get(id);
      if (scriptId !== undefined) {
        try { await s.cdp.call("Page.removeScriptToEvaluateOnNewDocument", { identifier: scriptId }); } catch { /* page gone */ }
        s.scriptIds.delete(id);
      }
    }
  }

  private async applyAll(): Promise<void> {
    for (const targetId of this.knownTargets) await this.applyToTarget(targetId).catch(() => { /* one bad target must not block the rest */ });
  }

  /**
   * Serialize `applyToTargetInner` PER TARGET: a `set()`→`applyAll()` and a
   * `targetCreated` for the same target must not both pass the
   * `!scriptIds.has(id)` check and double-register the same script (which orphans
   * the first identifier → a removed injection keeps firing as a ghost). Each
   * target runs its applies one-at-a-time via a tail-chained promise.
   */
  private applyToTarget(targetId: string): Promise<void> {
    const prev = this.applyChains.get(targetId) ?? Promise.resolve();
    const next = prev.catch(() => { /* a prior apply failing must not block the next */ }).then(() => this.applyToTargetInner(targetId));
    this.applyChains.set(targetId, next);
    // Drop the chain entry once it settles (if still the tail) so the map doesn't grow per-target forever.
    void next.finally(() => { if (this.applyChains.get(targetId) === next) this.applyChains.delete(targetId); }).catch(() => { /* caller owns the rejection */ });
    return next;
  }

  /**
   * Register every policy-accepted sticky script on ONE page. Lazily opens (and
   * then holds) a dedicated CDP session for the page — the LIVE session cadence's
   * comment calls out, needed because `Page.setBypassCSP` dies with the session.
   */
  private async applyToTargetInner(targetId: string): Promise<void> {
    if (this.closed) return;
    const ids = this.ids();
    if (!ids.length) return; // nothing accepted yet — don't pay for a page session
    let s = this.pageSessions.get(targetId);
    if (!s) {
      const cdp = await attachPage(this.cdpUrl, targetId);
      await cdp.call("Page.enable").catch(() => { /* best-effort */ });
      // A targetDestroyed/close() during the awaits above means this conn is now
      // stale — storing it would leak a socket + a ghost page session. Close + skip.
      if (this.closed || !this.knownTargets.has(targetId)) { try { cdp.close(); } catch { /* ignore */ } return; }
      s = { cdp, scriptIds: new Map(), cspEnabled: false };
      this.pageSessions.set(targetId, s);
    }
    if (ids.some((id) => this.sticky.get(id)?.bypassCSP) && !s.cspEnabled) {
      try { await s.cdp.call("Page.setBypassCSP", { enabled: true }); s.cspEnabled = true; } catch { /* best-effort */ }
    }
    for (const id of ids) {
      const def = this.sticky.get(id);
      if (!def) continue;
      if (!s.scriptIds.has(id)) {
        try {
          const r = await s.cdp.call("Page.addScriptToEvaluateOnNewDocument", { source: def.source });
          s.scriptIds.set(id, r.identifier);
        } catch { /* best-effort — a future reload will retry via applyAll() */ }
      }
      // Also run it into the document that's ALREADY loaded — `addScriptToEvaluateOnNewDocument`
      // only fires for documents loaded from now on, so a script registered mid-session
      // would otherwise sit inert until the next navigation.
      try { await s.cdp.call("Runtime.evaluate", { expression: def.source }); } catch { /* page not ready / navigating — ignore */ }
    }
  }
}

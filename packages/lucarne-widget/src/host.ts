// The HOST-side runtime — Node, next to the session. Ported from the prior single-app implementation's
// `widget-bridge.ts:32-61,156-171,252-277` skeleton: `toWidget`/`toWidgets` (postMessage push), the crash-safe
// tick pump (`every` — "a single rejected tick must not take the server down"), and the read-and-clear
// queue-drain with dedup-by-id (`ctlSeen`/`cfgSeen`, generalized to any number of NAMED intent queues).
// Mounting is LS-02's engine feature: `POST /sessions/:id/inject` via `lucarne`'s `LucarneClient` — this is
// the one place this package depends on `lucarne` (per §1.6: "widget MAY depend on `lucarne`, unlike interact").
//
// Everything past the mount call (push/onIntent/every/remove) talks to the page directly over the session's raw
// `cdpUrl` (see `cdp-lite.ts`) — a small, FIXED set of expressions this package builds itself, not a re-exposed
// arbitrary-eval surface (the engine's own `/eval` REPL was retired, not generalized — §1.5).
import { LucarneClient } from "lucarne";
import { evaluateOnAllPages, evaluateOnAllPagesCollecting } from "./cdp-lite.js";
import { type Identity, widgetMessage } from "./envelope.js";
import { injectorSource } from "./injector.js";
import { assertNs, guardGlobal, hostElementId, iframeGlobal, intentQueueGlobal, shellStickyId } from "./ns.js";
import { runWidgetSelftest, type SelftestCheck, type SelftestFixtures, type SelftestResult } from "./selftest.js";

export type { SelftestCheck, SelftestFixtures, SelftestResult } from "./selftest.js";

export interface WidgetHostEngineOptions {
  baseUrl?: string;
  token?: string;
}

/** Accepted as the first arg to `WidgetHost.attach`: either a session id (resolved via the engine client) or an already-fetched `{ id, cdpUrl }` (e.g. the object `LucarneClient#create`/`#get` returns). */
export type SessionRef = string | { id: string; cdpUrl: string };

export interface WidgetHostOptions {
  /** Namespaces every page global, element id, and the sticky-injection id this instance mints. */
  ns: string;
  /** The built, self-contained srcdoc HTML (see `build.ts`) — the iframe's own bundle. */
  html: string;
  /** How to reach the lucarne daemon for the mount call (`POST /sessions/:id/inject`). */
  engine?: WidgetHostEngineOptions;
  /** Stamped into every `push` — the iframe pins to the first identity it sees (see `reducer.ts`). */
  identity?: Identity;
}

export type IntentHandler = (intent: { id: string | number; payload: unknown }) => void | Promise<void>;

/** The crash-safe tick interval for the intent-drain pump — matches `widget-bridge.ts`'s control/settings queues (~1.2s). */
const DRAIN_INTERVAL_MS = 1200;

export interface SelftestOptions {
  /** Namespace for this run's throwaway shell instance. Defaults to a freshly generated one — pass your own for a stable, greppable `ns` in CI logs. */
  ns?: string;
  /** The built, self-contained srcdoc HTML to mount and drive — same shape `WidgetHost.attach` takes (see `build.ts`'s `buildSrcdoc`). Pass your OWN bundle to selftest a real downstream consumer's widget (LS-20); this package's own `test/widget-selftest-acceptance.mjs` passes its NEUTRAL fixture bundle (LS-16 dev/01). */
  html: string;
  /** The neutral test data pushed mid-run and re-pushed after the reload check — see `SelftestFixtures` (`selftest.ts`). */
  fixtures: SelftestFixtures;
  engine?: WidgetHostEngineOptions;
  identity?: Identity;
}

function defaultSelftestNs(): string {
  return `lwselftest${Math.random().toString(36).slice(2, 8)}`;
}

export class WidgetHost {
  private readonly timers = new Set<ReturnType<typeof setInterval>>();
  private readonly intentHandlers = new Map<string, IntentHandler>();
  private readonly seenByName = new Map<string, Set<string | number>>();
  private drainStarted = false;
  private removed = false;

  private constructor(
    private readonly id: string,
    private readonly cdpUrl: string,
    private readonly ns: string,
    private readonly client: LucarneClient,
    private readonly identity: Identity,
  ) {}

  /**
   * Resolve the session, register the injector as a durable sticky injection (`bypassCSP: true` — the shell needs
   * `Page.setBypassCSP` the same way the prior implementation's `widget.ts`'s `stickyp` call did), and return a live host.
   * The mount call is AWAITED and, per the engine's `set()` contract, means every currently-open page already has
   * the shell registered + applied by the time this resolves (pages opened later are covered by the engine's own
   * discovery tap — see `packages/lucarne/src/inject.ts`).
   */
  static async attach(sessionRef: SessionRef, opts: WidgetHostOptions): Promise<WidgetHost> {
    const ns = assertNs(opts.ns);
    const client = new LucarneClient({ baseUrl: opts.engine?.baseUrl, token: opts.engine?.token });
    let id: string;
    let cdpUrl: string;
    if (typeof sessionRef === "string") {
      const session = await client.get(sessionRef);
      id = session.id;
      cdpUrl = session.cdpUrl;
    } else {
      id = sessionRef.id;
      cdpUrl = sessionRef.cdpUrl;
    }
    const source = injectorSource({ ns, html: opts.html });
    await client.setInjection(id, { id: shellStickyId(ns), source, bypassCSP: true });
    return new WidgetHost(id, cdpUrl, ns, client, opts.identity ?? {});
  }

  /** The session id this host is mounted on. */
  get sessionId(): string {
    return this.id;
  }

  /**
   * The package's OWN committed acceptance proof (LS-16), runnable against ANY consumer's built bundle — not
   * just this package's neutral fixture. Mounts `opts.html` on a THROWAWAY `data:` tab of the given session
   * (never a real tab already open for other work), asserts singleton / top-frame-only / size-stable /
   * survives-reload-populated / responsive — each reported INDIVIDUALLY (see `selftest.ts`) — and tears itself
   * down (`remove()`) whether the run passes, fails, or throws. `sessionOrCdpUrl` accepts everything
   * `attach()`'s `SessionRef` does, PLUS a bare `cdpUrl` string (this is a throwaway diagnostic entry point, so
   * skipping the engine round-trip when the caller already has a live `cdpUrl` in hand is worth the extra
   * branch). Needs the OPTIONAL peer dependency `playwright-core` installed — CI-gated, like every other
   * Chrome-driving proof in this monorepo (`npm run test:acceptance`); never runs in a Chrome-free environment.
   */
  static async selftest(sessionOrCdpUrl: SessionRef | string, opts: SelftestOptions): Promise<SelftestResult> {
    const ns = opts.ns ?? defaultSelftestNs();
    let id: string;
    let cdpUrl: string;
    try {
      if (typeof sessionOrCdpUrl === "string" && /^(https?|wss?):\/\//.test(sessionOrCdpUrl)) {
        id = "selftest";
        cdpUrl = sessionOrCdpUrl;
      } else if (typeof sessionOrCdpUrl === "string") {
        const client = new LucarneClient({ baseUrl: opts.engine?.baseUrl, token: opts.engine?.token });
        const session = await client.get(sessionOrCdpUrl);
        id = session.id;
        cdpUrl = session.cdpUrl;
      } else {
        id = sessionOrCdpUrl.id;
        cdpUrl = sessionOrCdpUrl.cdpUrl;
      }
    } catch (e) {
      const check: SelftestCheck = { name: "selftest harness: resolves the session", pass: false, detail: (e as Error)?.message ?? String(e) };
      return { pass: false, checks: [check] };
    }

    let host: WidgetHost;
    try {
      host = await WidgetHost.attach({ id, cdpUrl }, { ns, html: opts.html, engine: opts.engine, identity: opts.identity ?? {} });
    } catch (e) {
      const check: SelftestCheck = { name: "selftest harness: mounts the shell (WidgetHost.attach)", pass: false, detail: (e as Error)?.message ?? String(e) };
      return { pass: false, checks: [check] };
    }
    try {
      return await runWidgetSelftest(cdpUrl, ns, host, opts.fixtures);
    } finally {
      await host.remove().catch(() => {
        /* best-effort teardown — a failed selftest run must still not leak the sticky shell registration */
      });
    }
  }

  /**
   * Push a patch to every mounted widget instance on this session's open pages — the ONE versioned,
   * identity-stamped envelope (`widget-bridge.ts`'s `toWidget`/`toWidgets`, generalized: `ns` rides along too).
   * Content is never frozen anywhere — every push is a live, best-effort delivery; a page without the shell
   * mounted yet, or that navigated away mid-delivery, is silently skipped (matches the original's `try{}catch{}`
   * per-page posture) and will pick up the next push once it (re)mounts.
   */
  async push(patch: unknown): Promise<void> {
    if (this.removed) return;
    const msg = widgetMessage(this.ns, this.identity, patch);
    const expr = `(function(){ var f = window[${JSON.stringify(iframeGlobal(this.ns))}]; if (f && f.contentWindow) { try { f.contentWindow.postMessage(${JSON.stringify(msg)}, '*'); } catch(e){} } })()`;
    await evaluateOnAllPages(this.cdpUrl, expr);
  }

  /**
   * The crash-safe tick pump — ported verbatim in spirit from `widget-bridge.ts:59-61`'s `every`: `fn` is async,
   * but a plain `setInterval` never awaits it, so a rejected tick would surface as an unhandled rejection and take
   * the whole host process down. Every tick is wrapped so a transient fault (a page navigated mid-evaluate, a
   * handler threw) is swallowed + logged and the pump simply tries again next interval.
   */
  every(ms: number, fn: () => unknown): () => void {
    const id = setInterval(() => {
      Promise.resolve()
        .then(fn)
        .catch((e: unknown) => {
          try {
            console.error(`[lucarne-widget:${this.ns}] tick error (continuing): ${(e as Error)?.message ?? e}`);
          } catch {
            /* logging must never throw */
          }
        });
    }, ms);
    this.timers.add(id);
    return () => {
      clearInterval(id);
      this.timers.delete(id);
    };
  }

  /**
   * Register a drain callback for one NAMED intent queue — the generalized form of `widget-bridge.ts`'s two
   * fixed-name queues (drained by their own pair of dedup Sets). A single shared
   * crash-safe tick (started lazily on the first `onIntent` call) drains every registered name each pass; within a
   * name, an intent is dedup'd by its `id` — "add BEFORE acting → never retried", the same ordering the original
   * comments call out (a handler that throws does not cause a re-delivery on the next tick).
   */
  onIntent(name: string, cb: IntentHandler): void {
    this.intentHandlers.set(name, cb);
    if (!this.seenByName.has(name)) this.seenByName.set(name, new Set());
    this.ensureDrainTick();
  }

  private ensureDrainTick(): void {
    if (this.drainStarted) return;
    this.drainStarted = true;
    this.every(DRAIN_INTERVAL_MS, () => this.drainOnce());
  }

  private async drainOnce(): Promise<void> {
    for (const [name, cb] of this.intentHandlers) {
      const key = intentQueueGlobal(this.ns, name);
      const expr = `(function(){ var a = window[${JSON.stringify(key)}] || []; window[${JSON.stringify(key)}] = []; return a; })()`;
      let perPageQueues: unknown[];
      try {
        perPageQueues = await evaluateOnAllPagesCollecting(this.cdpUrl, expr);
      } catch {
        continue; // browser unreachable this tick — try again next tick
      }
      const seen = this.seenByName.get(name)!;
      for (const q of perPageQueues) {
        const items = Array.isArray(q) ? (q as Array<{ id?: string | number; payload?: unknown }>) : [];
        for (const raw of items) {
          if (!raw || raw.id == null || seen.has(raw.id)) continue;
          seen.add(raw.id); // BEFORE acting — a throwing handler must never cause a re-delivery
          try {
            await cb({ id: raw.id, payload: raw.payload });
          } catch (e) {
            try {
              console.error(`[lucarne-widget:${this.ns}] intent '${name}' handler threw (continuing): ${(e as Error)?.message ?? e}`);
            } catch {
              /* ignore */
            }
          }
        }
      }
    }
  }

  /**
   * Drop the durable shell registration (the engine stops re-applying it + forgets it on disk) and tear the
   * widget out of every live tab (host element + the re-mount guard interval) — `widget.ts`'s `remove` command,
   * generalized. Idempotent: safe to call more than once, and stops every timer this host started.
   */
  async remove(): Promise<void> {
    if (this.removed) return;
    this.removed = true;
    for (const id of this.timers) clearInterval(id);
    this.timers.clear();
    await this.client.removeInjection(this.id, shellStickyId(this.ns)).catch(() => {
      /* already gone, or the session itself is gone — either way there's nothing left to remove */
    });
    const hostId = hostElementId(this.ns);
    const guard = guardGlobal(this.ns);
    const iframeG = iframeGlobal(this.ns);
    const expr = `(function(){
      var h = document.getElementById(${JSON.stringify(hostId)}); if (h) h.remove();
      if (window[${JSON.stringify(guard)}]) { clearInterval(window[${JSON.stringify(guard)}]); window[${JSON.stringify(guard)}] = null; }
      window[${JSON.stringify(iframeG)}] = null;
    })()`;
    await evaluateOnAllPages(this.cdpUrl, expr);
  }
}

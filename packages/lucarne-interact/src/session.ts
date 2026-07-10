// InteractSession — the ACT half of "the non-bot-like interaction plane".
//
// Ported (mechanism only, NO origin-app policy) from browser.ts. Every verb here has a
// direct source in that file; the per-app-URL lookup table, the reading-guide-coverage warning,
// and the workspace action-log sink are origin-app POLICY and stay in the origin app (§1.1 of the split
// spec). This class talks to a browser purely over a lucarne session's `cdpUrl` via a vanilla
// `playwright-core` connection — it does not import (or know about) the `lucarne` engine package.
//
// The anti-bot tier property (browser.ts:539-540): there is intentionally NO `click` (synthetic
// mouse), NO `goto` (deep-linking), NO `eval` (arbitrary code) on this class. If a bot-like action
// isn't one of the verbs below, it physically cannot be issued through this API.
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Browser, CDPSession, Page } from "playwright-core";
import { assembleMp4FromFrames, cleanupFramesDir, startScreencastToFrames } from "./video/assembler.js";
import { type PaceKind, type PaceProfile, type PacingConfig, pace as paceOnce, resolvePacing } from "./pacing.js";
import { type ActivityProbe, type PresenceMarker, PresenceTracker } from "./presence.js";
// Re-exported (the DATA SHAPE only, not the mechanism) so `presenceSnapshot()`'s return type is
// nameable from the package root without index.ts importing FROM presence.ts itself (the module
// specifier stays "./session.js" — see test/presence-export-map.mjs, which greps for the literal
// "./presence" specifier, not transitive type references).
export type { PresenceMarker } from "./presence.js";
import { runTypeLoop } from "./type-loop.js";
import { type SendFlowOptions, type SendFlowResult, runSendFlow } from "./send-flow.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const DEFAULT_TIMEOUT_MS = 15000; // the origin app's `PW` (browser.ts:23) — generous per-call timeout for real remote sites
const DEFAULT_CLIP_MAX_MS = 5 * 60 * 1000; // the hard 5-minute clip ceiling (browser.ts:345)
// `typeHuman`'s yield-check rhythm + threshold (browser.ts:187,189): probe every 12 chars, yield
// if the last detected human input landed under 1500ms ago.
const DEFAULT_YIELD_CHECK_EVERY_CHARS = 12;
const DEFAULT_YIELD_THRESHOLD_MS = 1500;
// The two in-app "Back" affordances the origin app recognized (browser.ts:270-271) — generic ARIA/testid
// patterns, not a per-site policy; callers can override entirely via `back({ inAppSelectors })`.
const DEFAULT_BACK_SELECTORS = ['button[aria-label="Back"]', '[data-testid="app-bar-back"]'];

export type CdpUrlSource = string | { cdpUrl: string; activity?: ActivityProbe };

export interface InteractSessionOptions {
  /** Per-kind pacing overrides (see pacing.ts). Unset fields fall back to the origin app's defaults. */
  pacing?: PacingConfig;
  /** Per-Playwright-call timeout, ms. Default matches the origin app's `PW` (15000). */
  timeoutMs?: number;
  /** Hard ceiling for `video.clip`, ms. Default 5 minutes (browser.ts:345). */
  clipMaxMs?: number;
  /**
   * Accessor for lucarne's actor-tagged activity (`now.lastHumanActionMsAgo`) — the PREFERRED
   * yield-to-human probe for `type()` (see yield.ts). Duck-typed so this package never imports
   * `lucarne`: pass e.g. `() => client.activity(session.id)`. Also accepted on the `{ cdpUrl,
   * activity }` object form of the constructor's first argument. When absent, `type()` falls back
   * to the in-page `window.__lastInputAt` probe.
   */
  activity?: ActivityProbe;
}

export interface OpenResult {
  url: string;
}

export interface ScrollResult {
  scrolled: number;
}

export interface ActivateResult {
  activated: true;
}

export interface BackOptions {
  /** Selectors tried (in order, first match wins) for an in-app Back control before falling to history. */
  inAppSelectors?: string[];
}

export interface BackResult {
  via: "in-app" | "history";
  /**
   * Only meaningful on the "history" path: derived from a URL comparison (before vs. after
   * `page.goBack()`), NOT from `goBack`'s return value — Playwright's `goBack` resolves a `null`
   * Response on a bfcache restore even though the navigation DID happen, so `nav !== null` is the
   * wrong signal. `false` when the URL is unchanged (a legitimate no-op: no history entry to go
   * back to), `true` once the URL actually changed (the back navigation committed).
   */
  navigated?: boolean;
}

export interface CaptureResult {
  path: string;
}

export interface TypeOptions {
  /** Probe for a human takeover every N characters. Default 12 (browser.ts:187). */
  yieldCheckEvery?: number;
  /** ms since the last detected human input under which `type()` yields. Default 1500 (browser.ts:189). */
  yieldThresholdMs?: number;
}

export interface TypeResult {
  /** Total characters in the requested text. */
  chars: number;
  /** Characters actually typed before completion (or before yielding). */
  typed: number;
  /** True if typing was aborted mid-way because a live human appeared to take the keyboard. */
  yielded: boolean;
}

/** `send()`'s options — see send-flow.ts for the full field docs (this is a named re-export of the same shape). */
export type SendOptions = SendFlowOptions;
/** `send()`'s resolved outcome — see send-flow.ts for the full field docs. */
export type SendResult = SendFlowResult;

export interface StoryboardOptions {
  /** Where to write the keyframe PNGs — caller-supplied (this package holds no corpus opinion). */
  outDir: string;
  /** Number of keyframes across the video's own duration (default 9, min 2). */
  frames?: number;
}

export interface StoryboardFrame {
  t: number;
  path: string;
}

export interface StoryboardResult {
  duration_s: number | null;
  frames: StoryboardFrame[];
}

export interface ClipResult {
  mp4: string;
  frames: number;
  duration_s: number | null;
  fps: number;
  watched_to_completion: boolean;
  truncated?: boolean;
}

export interface CaptionsResult {
  ok: boolean;
  source: string;
  transcript: string;
  cues?: number;
  note?: string;
  err?: string;
}

export interface VideoVerbs {
  storyboard(selector: string, opts: StoryboardOptions): Promise<StoryboardResult>;
  clip(selector: string, outPath: string): Promise<ClipResult>;
  captions(selector: string): Promise<CaptionsResult>;
}

/** The `on('action', e)` payload — emitted after EVERY verb, success or failure. */
export interface ActionEvent {
  verb: string;
  args: unknown[];
  ok: boolean;
  result?: unknown;
  error?: string;
  /** Wall-clock ms the verb itself took (excludes the enforced pace afterward). */
  actionMs: number;
  /** The enforced post-verb dwell actually sampled and slept, ms. */
  pacedMs: number;
  paceKind: PaceKind;
}

// Declared once so `InteractSession extends TypedEventEmitter` gets a typed `.on('action', ...)`.
interface InteractSessionEvents {
  action: [ActionEvent];
}

export declare interface InteractSession {
  on<K extends keyof InteractSessionEvents>(event: K, listener: (...args: InteractSessionEvents[K]) => void): this;
  emit<K extends keyof InteractSessionEvents>(event: K, ...args: InteractSessionEvents[K]): boolean;
}

/**
 * One human-paced presence over a lucarne session's `cdpUrl`. Wraps a `playwright-core`
 * `chromium.connectOverCDP` connection (playwright-core is a PEER dependency — see README).
 *
 * `new InteractSession(cdpUrl)` or `new InteractSession({ cdpUrl })` (accepts the object shape a
 * lucarne engine `session` already has, so `new InteractSession(session)` works too).
 */
export class InteractSession extends EventEmitter {
  readonly video: VideoVerbs;
  readonly #cdpUrl: string;
  readonly #timeoutMs: number;
  readonly #clipMaxMs: number;
  readonly #pacing: Record<PaceKind, PaceProfile>;
  readonly #activityProbe: ActivityProbe | undefined;
  // The presence contract's ACT-half writer (LS-12, presence.ts) — every verb that resolves/acts
  // on a page records the driven target here (single writer per session; see #markDriven below).
  readonly #presence = new PresenceTracker();
  // Per-Page cache of the browser's own CDP `Target.targetId` — resolved once per Page object
  // (identity-stable within one playwright-core connection) rather than re-queried on every verb.
  readonly #targetIds = new WeakMap<Page, Promise<string>>();
  #browser: Browser | undefined;
  #connecting: Promise<Browser> | undefined;

  constructor(cdpUrlOrSession: CdpUrlSource, opts: InteractSessionOptions = {}) {
    super();
    const cdpUrl = typeof cdpUrlOrSession === "string" ? cdpUrlOrSession : cdpUrlOrSession?.cdpUrl;
    if (!cdpUrl) throw new Error("InteractSession requires a cdpUrl (a string, or an object with a `cdpUrl` field)");
    this.#cdpUrl = cdpUrl;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#clipMaxMs = opts.clipMaxMs ?? DEFAULT_CLIP_MAX_MS;
    this.#pacing = resolvePacing(opts.pacing);
    // PREFERRED yield-to-human probe (yield.ts) — from opts, or duck-typed off the session object.
    this.#activityProbe = opts.activity ?? (typeof cdpUrlOrSession === "object" ? cdpUrlOrSession.activity : undefined);
    this.video = {
      storyboard: (selector, videoOpts) => this.#storyboard(selector, videoOpts),
      clip: (selector, outPath) => this.#clip(selector, outPath),
      captions: (selector) => this.#captions(selector),
    };
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

  /** The active page — this package tracks no multi-tab state; it's the connected context's first page. */
  async #page(): Promise<Page> {
    const b = await this.#connect();
    const ctx = b.contexts()[0] ?? (await b.newContext());
    const p = ctx.pages()[0] ?? (await ctx.newPage());
    await this.#markDriven(p);
    return p;
  }

  /**
   * The presence contract's write side (LS-12): record that a verb just acted on `p`, keyed by the
   * browser's own CDP `Target.targetId` (stable across separate connections — unlike a `Page`
   * object's identity, which only holds within ONE playwright connection; see presence.ts's doc
   * header). Every verb goes through `#page()` (or, for `open()`, marks explicitly) so this is a
   * single, central writer. Best-effort: a presence-marking failure must never break a verb.
   */
  async #markDriven(p: Page): Promise<void> {
    try {
      const targetId = await this.#targetIdFor(p);
      this.#presence.record(targetId);
    } catch {
      // presence is an observability aid, not a correctness dependency — never let it break a verb
    }
  }

  /** Resolve (and cache, per Page object) the browser's own CDP `Target.targetId` for `p`. */
  async #targetIdFor(p: Page): Promise<string> {
    let cached = this.#targetIds.get(p);
    if (!cached) {
      cached = (async () => {
        const cdp = await p.context().newCDPSession(p);
        try {
          const info = await cdp.send("Target.getTargetInfo");
          return info.targetInfo.targetId;
        } finally {
          await cdp.detach().catch(() => {});
        }
      })();
      this.#targetIds.set(p, cached);
    }
    return cached;
  }

  /** Run one verb, always emitting `action` and always paying the enforced post-verb pace — success or failure. */
  async #act<T>(verb: string, args: unknown[], kind: PaceKind, fn: () => Promise<T>): Promise<T> {
    const t0 = Date.now();
    let ok = true;
    let result: T | undefined;
    let error: string | undefined;
    try {
      result = await fn();
      return result;
    } catch (e) {
      ok = false;
      error = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      const actionMs = Date.now() - t0;
      const pacedMs = await paceOnce(kind, this.#pacing);
      this.emit("action", { verb, args, ok, result, error, actionMs, pacedMs, paceKind: kind });
    }
  }

  /** The `cdpUrl` this session was constructed with — lets a sibling consumer (recall, LS-13) open its OWN, separate connection to the SAME session. */
  get cdpUrl(): string {
    return this.#cdpUrl;
  }

  /**
   * The presence contract's READ accessor (LS-12/LS-13): the current driven-target marker, or
   * `null` before any verb has acted on a page. This is how recall — running on its OWN CDP
   * connection (a different `playwright-core` connection means DIFFERENT `Page` object identities
   * for the same tab, see presence.ts's doc header) — reads this session's marker WITHOUT reaching
   * into private state (`#presence`). `startRecall` duck-types for this method: pass an
   * `InteractSession` instance directly and its capture attribution (`by:'agent'|'human'`) is wired
   * automatically; `attributeActor(null, ...)` already handles the case where no verb has acted yet.
   */
  presenceSnapshot(): PresenceMarker | null {
    return this.#presence.marker;
  }

  /**
   * The current page's `url` + `title` — read from the SAME page `#page()` hands every other verb
   * (`snap`, `capture`, `viewportShot`, ...), so a consumer that also calls those verbs gets
   * metadata that matches the exact page they read (self-consistent, not a separately-resolved
   * page that could have navigated in between). Pure read: no navigation, no input, nothing
   * dispatched to the page. This is how recall (LS-22b) records page metadata alongside a
   * `snap()`/`capture()`/`viewportShot()` result without opening its own extra connection.
   */
  async where(): Promise<{ url: string; title: string }> {
    return this.#act("where", [], "read", async () => {
      const p = await this.#page();
      return { url: p.url(), title: await p.title() };
    });
  }

  /** Close the underlying playwright-core connection (does not destroy the lucarne session). */
  async close(): Promise<void> {
    if (this.#browser) {
      await this.#browser.close().catch(() => {});
      this.#browser = undefined;
      this.#connecting = undefined;
    }
  }

  // ── act verbs ────────────────────────────────────────────────────────────────────────────────

  /** The single sanctioned bootstrap navigation (browser.ts:244-268, minus the per-app-URL lookup table + reading-guide-coverage warning — origin-app policy). */
  async open(url: string): Promise<OpenResult> {
    return this.#act("open", [url], "nav", async () => {
      const b = await this.#connect();
      const ctx = b.contexts()[0] ?? (await b.newContext());
      const p = ctx.pages()[0] ?? (await ctx.newPage());
      await this.#markDriven(p);
      await p.goto(url, { timeout: this.#timeoutMs, waitUntil: "domcontentloaded" });
      return { url: p.url() };
    });
  }

  /** ARIA snapshot — the ONLY way to read (browser.ts:275-279). Scope the selector; maxLines bounds output. */
  async snap(selector = "body", maxLines = 120): Promise<string> {
    return this.#act("snap", [selector, maxLines], "read", async () => {
      const p = await this.#page();
      const s = await p.locator(selector).first().ariaSnapshot({ timeout: this.#timeoutMs });
      return s.split("\n").slice(0, Math.max(20, maxLines)).join("\n");
    });
  }

  /** Keyboard scroll (real, trusted key events) — like a keyboard/AT user, NOT JS scrollBy (browser.ts:281-285). */
  async scroll(n = 1): Promise<ScrollResult> {
    return this.#act("scroll", [n], "scroll", async () => {
      const p = await this.#page();
      const count = Math.max(1, n);
      for (let i = 0; i < count; i++) {
        await p.keyboard.press("PageDown");
        await sleep(350);
      }
      return { scrolled: count };
    });
  }

  /** Keyboard-first activation: focus the element + Enter — no mouse (browser.ts:536-537). */
  async activate(selector: string): Promise<ActivateResult> {
    return this.#act("activate", [selector], "nav", async () => {
      const p = await this.#page();
      await p.locator(selector).first().press("Enter", { timeout: this.#timeoutMs });
      return { activated: true as const };
    });
  }

  /** Human back-navigation — the in-app Back button, else browser history (browser.ts:270-274). */
  async back(opts: BackOptions = {}): Promise<BackResult> {
    const selectors = opts.inAppSelectors?.length ? opts.inAppSelectors : DEFAULT_BACK_SELECTORS;
    return this.#act("back", [opts], "nav", async () => {
      const p = await this.#page();
      const loc = p.locator(selectors.join(", ")).first();
      if (await loc.count()) {
        try {
          await loc.press("Enter");
        } catch {
          await loc.click({ timeout: 5000 });
        }
        return { via: "in-app" as const };
      }
      // History fallback. Playwright's DEFAULT `waitUntil` for `goBack` is `'load'`, which does
      // NOT reliably refire on a back navigation — especially back to a bfcache'd / already-loaded
      // page, where the browser restores the page without a fresh `load` event. The navigation
      // itself commits (the URL/history entry changes) in well under a second, but `goBack` would
      // hang waiting for a `load` event that never comes, and eventually throw `TimeoutError` even
      // though back-navigation fully succeeded (the real-Chrome CI failure this fixes). `'commit'`
      // resolves as soon as the navigation is committed — the only thing this verb needs to know
      // back actually happened — so it is robust to the missing refire.
      //
      // `navigated` is derived from the URL, NOT from goBack's return value: Playwright's `goBack`
      // resolves a `null` Response on a bfcache restore even though the navigation DID happen (the
      // restored document is served from the bfcache rather than a fresh network response, so
      // there's no Response object to report) — `nav !== null` was the WRONG signal and reported
      // `navigated: false` on exactly the fast, common case this fix targets (the real-Chrome CI
      // failure this fixes). A genuine no-op (no history entry to go back to) leaves the URL
      // unchanged; a real back navigation — bfcache-restored or not — always changes it.
      const urlBefore = p.url();
      await p.goBack({ timeout: 8000, waitUntil: "commit" });
      return { via: "history" as const, navigated: p.url() !== urlBefore };
    });
  }

  /** LOOK at an image: element-scoped capture via CDP — invisible to the page (browser.ts:287-292). */
  async capture(selector: string, outPath: string): Promise<CaptureResult> {
    return this.#act("capture", [selector, outPath], "read", async () => {
      const p = await this.#page();
      mkdirSync(dirname(outPath), { recursive: true });
      await p.locator(selector).first().screenshot({ path: outPath, timeout: 12000 });
      return { path: outPath };
    });
  }

  /**
   * LOOK at what's on screen RIGHT NOW: a VIEWPORT screenshot via CDP — invisible to the page.
   * Contrast with `capture(selector, ...)`: that verb screenshots one ELEMENT's bounding box (for
   * a tall `body` that's the element's full scroll height, not what's actually visible); this verb
   * screenshots the viewport only (`fullPage` defaults false), bounded to what a human would see on
   * screen. Same CDP path as `capture` — still read-only, no navigation, no input.
   */
  async viewportShot(outPath: string): Promise<{ path: string }> {
    return this.#act("viewportShot", [outPath], "read", async () => {
      const p = await this.#page();
      mkdirSync(dirname(outPath), { recursive: true });
      await p.screenshot({ path: outPath, timeout: 12000 }); // viewport-only (fullPage defaults false) — invisible to the page, same CDP path as capture
      return { path: outPath };
    });
  }

  /**
   * STAGE text via humanized per-keystroke typing (browser.ts:184-195) — NEVER presses Enter/submits.
   * Sending an approved, staged draft is `send()` (LS-11); this verb only enters text into whatever
   * is focused. Yields (aborts) the moment a live human appears to be typing — see yield.ts for the
   * two probe paths (lucarne's actor-tagged activity, preferred; the in-page `__lastInputAt` probe,
   * fallback) — checked every `yieldCheckEvery` characters (default 12, browser.ts:187).
   */
  async type(text: string, opts: TypeOptions = {}): Promise<TypeResult> {
    return this.#act("type", [text, opts], "act", async () => {
      const p = await this.#page();
      await this.#ensureInputProbeInstalled(p);
      // The drive loop is a browser-free unit (type-loop.ts) with injected I/O — here we hand it the
      // real page-backed callbacks. It only ever dispatches the characters of `text` (never Enter).
      return runTypeLoop(
        text,
        {
          yieldCheckEvery: opts.yieldCheckEvery ?? DEFAULT_YIELD_CHECK_EVERY_CHARS,
          yieldThresholdMs: opts.yieldThresholdMs ?? DEFAULT_YIELD_THRESHOLD_MS,
        },
        {
          typeChar: (ch) => p.keyboard.type(ch, { delay: 0 }),
          sleep,
          activityProbe: this.#activityProbe,
          inPageProbe: () => this.#readLastInputAt(p),
        },
      );
    });
  }

  /**
   * Best-effort setter for the FALLBACK yield probe's `window.__lastInputAt` (browser.ts:186-190
   * only ever READS this global — the origin app never wired a setter, which left the probe permanently
   * inert; this installs one). Idempotent (a page-level flag guards re-installation), and failures
   * are swallowed — the fallback probe degrades to "no signal" rather than breaking `type()`.
   */
  async #ensureInputProbeInstalled(p: Page): Promise<void> {
    try {
      await p.evaluate(() => {
        const w = window as unknown as { __lucarneInteractProbeInstalled?: boolean; __lastInputAt?: number };
        if (w.__lucarneInteractProbeInstalled) return;
        w.__lucarneInteractProbeInstalled = true;
        const mark = () => {
          w.__lastInputAt = Date.now();
        };
        window.addEventListener("keydown", mark, true);
        window.addEventListener("pointerdown", mark, true);
        window.addEventListener("touchstart", mark, true);
      });
    } catch {
      // best-effort only — see doc comment above
    }
  }

  /** Read the raw `window.__lastInputAt` timestamp (epoch ms), or null if unset/unreadable. */
  async #readLastInputAt(p: Page): Promise<number | null> {
    try {
      return await p.evaluate(() => {
        const v = (window as unknown as { __lastInputAt?: number }).__lastInputAt;
        return typeof v === "number" ? v : null;
      });
    } catch {
      return null;
    }
  }

  /**
   * The GATED send: the ONLY code path in this package that presses Enter / submits (LS-11). This
   * is the anti-footgun for acting on logged-in accounts — the default is REFUSE; only an
   * explicit approval, or yolo mode, fires the gesture. `send` does not stage text itself; it
   * COMMITS a draft the caller already staged via `type()`.
   *
   * `decideSend` (send-gate.ts) is ported BYTE-IDENTICAL from the origin app's
   * `guardrails/enforce.ts:124-132` (see that file's header + `test/decide-send-provenance.mjs`).
   * ALL policy computation — content rules, rate limits, sourcing/assess, the approvals ledger —
   * is the caller's `policy(text, ctx)` function; this class never evaluates content itself.
   *
   * On a GO decision (approved, or yolo), the staged-composer safety check runs first
   * (`browser.ts:516-525` — skipped for `{ submit }` gestures) and can still refuse
   * (`action: 'composer-mismatch'`) with zero keypress if the focused composer doesn't actually
   * hold the draft. Only past both gates does the gesture fire: a `Meta+Enter`-style keypress, or
   * a keyboard-activated submit-selector click.
   */
  async send(text: string, opts: SendOptions): Promise<SendResult> {
    return this.#act("send", [text, { gesture: opts.gesture, approval: opts.approval }], "act", () =>
      runSendFlow(text, opts, {
        pressKey: async (key) => {
          const p = await this.#page();
          await p.keyboard.press(key);
        },
        pressSubmit: async (selector) => {
          const p = await this.#page();
          await p.locator(selector).first().press("Enter", { timeout: this.#timeoutMs });
        },
        // Mirrors browser.ts:518 exactly: read document.activeElement's held text (input .value,
        // or innerText/textContent for a contenteditable), plus a `focused` signal so
        // composer-check.ts can report a distinct "focus-lost" reason (an enrichment over the
        // original's single combined message — same underlying gate condition).
        readComposerProbe: async () => {
          const p = await this.#page();
          return p.evaluate(() => {
            const el = document.activeElement as (HTMLElement & { value?: string; isContentEditable?: boolean }) | null;
            const focusable = !!el && el !== document.body && el !== document.documentElement;
            if (!focusable) return { focused: false, value: "" };
            const value =
              el!.value != null ? String(el!.value) : el!.isContentEditable ? el!.innerText || el!.textContent || "" : "";
            return { focused: true, value };
          });
        },
      }),
    );
  }

  // ── video.* (browser.ts:294-401) ────────────────────────────────────────────────────────────

  /** WATCH a video as a STORYBOARD: seek across its own duration and capture keyframes (browser.ts:294-317). */
  async #storyboard(selector: string, opts: StoryboardOptions): Promise<StoryboardResult> {
    return this.#act("video.storyboard", [selector, opts], "read", async () => {
      const n = Math.max(2, opts.frames ?? 9);
      const p = await this.#page();
      mkdirSync(opts.outDir, { recursive: true });
      const info = await p.evaluate((s: string) => {
        const root = document.querySelector(s);
        let v = root ? (root.tagName === "VIDEO" ? (root as HTMLVideoElement) : root.querySelector("video")) : null;
        if (!v) v = document.querySelector("video");
        if (!v) return { ok: false as const, err: "no <video> found for " + s };
        (window as any).__liVid = v;
        try {
          v.pause();
        } catch {
          /* ignore */
        }
        return { ok: true as const, duration: Number.isFinite(v.duration) ? v.duration : null };
      }, selector);
      if (!info.ok) throw new Error(info.err);
      const dur = info.duration ?? 0;
      const stamp = Date.now();
      const frames: StoryboardFrame[] = [];
      for (let i = 0; i < n; i++) {
        const frac = i / (n - 1);
        await p.evaluate(async (f: number) => {
          const v = (window as any).__liVid as HTMLVideoElement | undefined;
          if (!v) return;
          try {
            v.pause();
          } catch {
            /* ignore */
          }
          v.currentTime = f * (v.duration || 0);
          await new Promise<void>((r) => {
            let done = false;
            const h = () => {
              if (done) return;
              done = true;
              v.removeEventListener("seeked", h);
              r();
            };
            v.addEventListener("seeked", h);
            setTimeout(() => {
              if (!done) {
                done = true;
                r();
              }
            }, 1200);
          });
        }, frac);
        const fp = resolve(opts.outDir, `watch-${stamp}-${i}.png`);
        await p.locator(selector).first().screenshot({ path: fp, timeout: 12000 });
        frames.push({ t: +(frac * dur).toFixed(2), path: fp });
      }
      return { duration_s: dur, frames };
    });
  }

  /** Record a video to COMPLETION (loop off, so even a looping GIF fires 'ended'), CAPPED at clipMaxMs. */
  async #clip(selector: string, outPath: string): Promise<ClipResult> {
    return this.#act("video.clip", [selector, outPath], "read", async () => {
      const p = await this.#page();
      mkdirSync(dirname(outPath), { recursive: true });
      const framesDir = `${outPath}.frames-${Date.now()}`;
      const meta = await p.evaluate(async (s: string) => {
        const root = document.querySelector(s);
        let v = root ? (root.tagName === "VIDEO" ? (root as HTMLVideoElement) : root.querySelector("video")) : null;
        if (!v) v = document.querySelector("video");
        if (!v) return { ok: false as const };
        v.muted = true;
        v.loop = false;
        try {
          v.currentTime = 0;
        } catch {
          /* ignore */
        }
        (window as any).__liEnded = false;
        v.onended = () => {
          (window as any).__liEnded = true;
        };
        (window as any).__liVid = v;
        try {
          await v.play();
        } catch {
          /* ignore autoplay refusal — the poll loop below re-nudges play() */
        }
        return { ok: true as const, duration: Number.isFinite(v.duration) ? v.duration : null };
      }, selector);
      if (!meta.ok) throw new Error("clip: no <video> found for " + selector);

      const cdp: CDPSession = await p.context().newCDPSession(p);
      const screencast = await startScreencastToFrames(cdp, framesDir);

      const t0 = Date.now();
      let completed = false;
      let truncated = false;
      while (true) {
        await sleep(1000);
        const st = await p
          .evaluate(() => {
            const v = (window as any).__liVid as HTMLVideoElement | undefined;
            return v ? { ct: v.currentTime, dur: v.duration, ended: !!(window as any).__liEnded, paused: v.paused } : null;
          })
          .catch(() => null);
        if (!st) break;
        if (st.ended || (Number.isFinite(st.dur) && st.dur > 0 && st.ct >= st.dur - 0.25)) {
          completed = true;
          break;
        }
        if (Date.now() - t0 > this.#clipMaxMs) {
          truncated = true;
          break;
        }
        if (st.paused && !st.ended) {
          await p
            .evaluate(() => {
              try {
                (window as any).__liVid?.play();
              } catch {
                /* ignore */
              }
            })
            .catch(() => {});
        }
      }

      const { frames } = await screencast.stop();
      await cdp.detach().catch(() => {});
      if (!frames) {
        cleanupFramesDir(framesDir);
        throw new Error("clip: no frames captured");
      }
      const secs = completed && Number.isFinite(meta.duration) && meta.duration ? meta.duration! : (Date.now() - t0) / 1000;
      const fps = Math.max(1, Math.round(frames / secs));
      const asm = assembleMp4FromFrames(framesDir, outPath, { fps });
      cleanupFramesDir(framesDir);
      if (!asm.ok) throw new Error(`clip: ffmpeg failed: ${asm.stderr}`);
      return {
        mp4: outPath,
        frames,
        duration_s: meta.duration ?? null,
        fps,
        watched_to_completion: completed,
        ...(truncated ? { truncated: true } : {}),
      };
    });
  }

  /** The SPEECH channel — read a video's caption transcript from DOM cues (browser.ts:394-401). */
  async #captions(selector: string): Promise<CaptionsResult> {
    return this.#act("video.captions", [selector], "read", async () => {
      const p = await this.#page();
      return p.evaluate(async (s: string) => {
        let v = document.querySelector(s) as HTMLVideoElement | null;
        if (v && v.tagName !== "VIDEO") v = v.querySelector("video");
        if (!v) v = document.querySelector("video");
        if (!v) return { ok: false as const, source: "none", transcript: "", err: "no <video>" };
        let track: TextTrack | null = null;
        for (const t of v.textTracks) {
          if (t.kind === "captions" || t.kind === "subtitles") {
            track = t;
            break;
          }
        }
        if (track) track.mode = "hidden";
        await new Promise((r) => setTimeout(r, 800));
        if (track && track.cues && track.cues.length) {
          return {
            ok: true as const,
            source: "textTrack",
            cues: track.cues.length,
            transcript: [...track.cues]
              .map((c: any) => String(c.text).replace(/<[^>]+>/g, "").replace(/\n/g, " "))
              .join(" "),
          };
        }
        for (const cs of [".ytp-caption-segment", '[data-testid="captions"]', ".captions-text", ".vjs-text-track-cue"]) {
          const el = document.querySelector(cs);
          if (el && el.textContent && el.textContent.trim()) {
            return { ok: true as const, source: "overlay:" + cs, transcript: el.textContent.trim() };
          }
        }
        return {
          ok: true as const,
          source: "none",
          transcript: "",
          note: "no caption cues — captions off, or a custom renderer",
        };
      }, selector);
    });
  }

  // Intentionally NO 'click' (synthetic mouse), NO 'goto'/'go' (deep-linking), NO 'eval' (arbitrary
  // code). Those are the bot-like actions (browser.ts:539-540) — they are not verbs here, so they
  // physically cannot be issued through this class.
}

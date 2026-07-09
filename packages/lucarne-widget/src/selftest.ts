// The RUNNER half of `WidgetHost.selftest` (see `host.ts`) — split out so the class body stays focused on the
// production mount/push/onIntent/every/remove surface. This module is the ONLY place `lucarne-widget` reaches
// for `playwright-core`, and it does so LAZILY (a dynamic `import()` behind a non-literal specifier, so
// TypeScript never resolves its types and a consumer who never calls `.selftest()` never needs it installed —
// `playwright-core` stays an OPTIONAL peer dependency the same way the package's other optional UI-framework
// adapter dependency stays optional behind its own dedicated subpath; here that's enforced by laziness instead
// of a separate subpath, because this must be a method ON `WidgetHost` itself, not a separate entry point).
//
// Generalized port of the prior single-app implementation's `widget.ts:333-458` selftest: it opens ONE
// throwaway `data:` tab (with a CHILD IFRAME, so the top-frame-only regression is actually exercised, not just
// assumed absent) on the session's live `cdpUrl`, and asserts the five properties that implementation regressed
// on — singleton, top-frame-only, size-stable, survives-reload-populated, responsive — each reported
// INDIVIDUALLY. It never inspects a fixture's own content beyond a caller-supplied marker string, and only ever
// interacts through this package's OWN generic shell chrome (`.pill`, from `shell-css.ts`) — so it drives ANY
// consumer's bundle built with `createWidget`, not just this package's own neutral test fixture (see
// `test/fixtures/widget-selftest-entry.ts` + `test/widget-selftest-acceptance.mjs`, and LS-20's note that a
// downstream consumer's own bundle runs through this same `WidgetHost.selftest`, just with its own
// `html`/`fixtures`).
import { hostElementId } from "./ns.js";

export interface SelftestFixtures {
  /** A short marker string expected to become visibly rendered TEXT somewhere inside the mounted iframe once
   * `patch` has been pushed and the panel opened — the one generic "did real content actually land" signal this
   * harness relies on. It never assumes anything about a consumer's DOM shape beyond that. */
  marker: string;
  /** The patch object actually pushed via `WidgetHost.push` — shaped so `marker` rides inside genuinely
   * rendered content, not a side channel. */
  patch: unknown;
}

export interface SelftestCheck {
  name: string;
  pass: boolean;
  detail?: string;
}

export interface SelftestResult {
  pass: boolean;
  checks: SelftestCheck[];
}

/** The minimal host surface this runner needs — satisfied by a real `WidgetHost`. Kept as an interface (not an
 * import of `host.ts`) so the dependency runs ONE way: `host.ts` imports this module, this module never imports
 * `host.ts` back. */
export interface SelftestHost {
  push(patch: unknown): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ── the minimal playwright-core surface this runner needs — a LOCAL interface (mirrors `cdp-lite.ts`'s own
// `WebSocketLike` pattern) so this package never needs `playwright-core`'s type declarations resolvable at
// build time, only at `.selftest()` CALL time. ──
interface PwRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
interface PwFrame {
  evaluate<T>(fn: (arg: string) => T, arg: string): Promise<T>;
}
interface PwPage extends PwFrame {
  goto(url: string, opts?: { waitUntil?: string }): Promise<unknown>;
  reload(opts?: { waitUntil?: string }): Promise<unknown>;
  frames(): PwFrame[];
  mainFrame(): PwFrame;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  viewportSize(): { width: number; height: number } | null;
  url(): string;
  close(opts?: { runBeforeUnload?: boolean }): Promise<void>;
}
interface PwContext {
  newPage(): Promise<PwPage>;
  pages(): PwPage[];
}
interface PwBrowser {
  contexts(): PwContext[];
  close(): Promise<void>;
}
interface PlaywrightCoreModule {
  chromium: { connectOverCDP(cdpUrl: string): Promise<PwBrowser> };
}

interface DomSnapshot {
  hosts: number;
  iframes: number;
  size: [number, number] | null;
  rect: PwRect | null;
}

/**
 * Run the five-assertion selftest against a session's live `cdpUrl`, driving `host` (already `attach`ed by the
 * caller — see `host.ts`). Returns individually-reported checks; never throws — a harness-level fault (no
 * `playwright-core`, no reachable browser context) is itself reported as a failed check, not an exception.
 */
export async function runWidgetSelftest(cdpUrl: string, ns: string, host: SelftestHost, fixtures: SelftestFixtures): Promise<SelftestResult> {
  const checks: SelftestCheck[] = [];
  const record = (name: string, pass: boolean, detail?: string): void => {
    checks.push({ name, pass: !!pass, detail });
  };
  const HOST = hostElementId(ns);

  let pw: PlaywrightCoreModule;
  try {
    // A NON-LITERAL specifier: TypeScript cannot statically resolve module types for a computed dynamic
    // `import()`, so this compiles with zero build-time dependency on playwright-core's type declarations —
    // see the module doc. Runtime resolution still needs the real package installed (an optional peer dep).
    const modName = "playwright-core";
    pw = (await import(modName)) as PlaywrightCoreModule;
  } catch (e) {
    record(
      "selftest harness: 'playwright-core' is installed",
      false,
      `install the optional peer dependency 'playwright-core' to run WidgetHost.selftest: ${(e as Error)?.message ?? String(e)}`,
    );
    return { pass: false, checks };
  }

  let browser: PwBrowser;
  try {
    browser = await pw.chromium.connectOverCDP(cdpUrl);
  } catch (e) {
    record("selftest harness: connects to the session's live cdpUrl", false, (e as Error)?.message ?? String(e));
    return { pass: false, checks };
  }

  try {
    const ctx = browser.contexts()[0];
    if (!ctx) {
      record("selftest harness: a browser context is reachable", false);
      return { pass: false, checks };
    }
    // clean up any leftover throwaway tab from a previous aborted run (mirrors the prior implementation's own selftest)
    for (const p of ctx.pages()) {
      try {
        if ((p.url() || "").startsWith("data:text/html")) await p.close({ runBeforeUnload: false });
      } catch {
        /* already gone */
      }
    }
    const page = await ctx.newPage();
    try {
      await runChecks(page, HOST, host, fixtures, record);
    } finally {
      try {
        await page.close({ runBeforeUnload: false });
      } catch {
        /* ignore */
      }
    }
  } finally {
    try {
      await browser.close(); // DETACHES only — connectOverCDP never owns/kills the real session's Chrome
    } catch {
      /* ignore */
    }
  }

  return { pass: checks.length > 0 && checks.every((c) => c.pass), checks };
}

async function domSnapshot(page: PwPage, host: string): Promise<DomSnapshot> {
  return page.evaluate((h) => {
    const hs = document.querySelectorAll("#" + h);
    const hEl = hs[0] as (Element & { shadowRoot?: ShadowRoot }) | undefined;
    const ifr = hEl?.shadowRoot ? hEl.shadowRoot.querySelectorAll("iframe") : [];
    const r = hEl ? hEl.getBoundingClientRect() : null;
    return {
      hosts: hs.length,
      iframes: ifr.length,
      size: r ? ([Math.round(r.width), Math.round(r.height)] as [number, number]) : null,
      rect: r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null,
    };
  }, host);
}

function clickPill(page: PwPage, host: string): Promise<boolean> {
  return page.evaluate((h) => {
    const hEl = document.getElementById(h) as (Element & { shadowRoot?: ShadowRoot }) | null;
    const doc = (hEl?.shadowRoot?.querySelector("iframe") as HTMLIFrameElement | null)?.contentWindow?.document;
    const btn = doc?.querySelector(".pill") as HTMLElement | null;
    if (btn) btn.click();
    return !!btn;
  }, host);
}

function iframeText(page: PwPage, host: string): Promise<string | null> {
  return page.evaluate((h) => {
    const hEl = document.getElementById(h) as (Element & { shadowRoot?: ShadowRoot }) | null;
    const doc = (hEl?.shadowRoot?.querySelector("iframe") as HTMLIFrameElement | null)?.contentWindow?.document;
    return doc?.body ? doc.body.innerText || doc.body.textContent || null : null;
  }, host);
}

async function runChecks(
  page: PwPage,
  HOST: string,
  host: SelftestHost,
  fixtures: SelftestFixtures,
  record: (name: string, pass: boolean, detail?: string) => void,
): Promise<void> {
  // A CHILD IFRAME is included — the injector runs in EVERY frame; only the TOP frame is allowed to mount. This
  // is what actually exercises the top-frame-only guard, not just its absence of complaint.
  const DATA =
    "data:text/html," +
    encodeURIComponent(
      `<!doctype html><html><head><meta charset=utf-8></head><body style="margin:0;background:#0b0d12;height:1400px">` +
        `<iframe style="width:320px;height:220px;border:0" srcdoc="<body style=background:#222></body>"></iframe></body></html>`,
    );
  await page.goto(DATA, { waitUntil: "domcontentloaded" });

  // ── MOUNT: the sticky injector's coverage of a brand-new tab is async (the engine's own target-discovery tap,
  // LS-02) — poll rather than assume it landed by the time goto() resolved. ──
  let snap = await domSnapshot(page, HOST);
  const mountDeadline = Date.now() + 8000;
  while (snap.hosts !== 1 && Date.now() < mountDeadline) {
    await sleep(250);
    snap = await domSnapshot(page, HOST);
  }

  // ── 1. SINGLETON — exactly one shell, and it STAYS one across several of the re-mount guard's own 800ms ticks
  // (the exact regression the guard exists to prevent: double-registering on a later tick). ──
  let singleton = snap.hosts === 1 && snap.iframes === 1;
  for (let i = 0; i < 3 && singleton; i++) {
    await sleep(350);
    const s2 = await domSnapshot(page, HOST);
    singleton = s2.hosts === 1 && s2.iframes === 1;
  }
  record("singleton: exactly one shell (host + iframe) mounts, and stays one across guard ticks", singleton, JSON.stringify(snap));

  // ── 2. TOP-FRAME-ONLY — zero shells anywhere in a subframe (the fixture's own child iframe AND the widget's
  // own sandboxed iframe are both subframes of the top page; neither may carry a host element of its own). ──
  let childHosts = 0;
  for (const fr of page.frames()) {
    if (fr === page.mainFrame()) continue;
    try {
      childHosts += await fr.evaluate((h) => document.querySelectorAll("#" + h).length, HOST);
    } catch {
      /* a cross-origin/torn-down frame mid-check — nothing to count there */
    }
  }
  record("top-frame-only: no shell mounted inside any subframe", childHosts === 0, `childHosts=${childHosts}`);

  // ── push the fixture + open the panel via the SHELL's own generic `.pill` control (this package's class, not
  // any consumer's) — the settle time here also doubles as the pre-reload state the next two checks build on. ──
  await host.push(fixtures.patch);
  await sleep(400);
  await clickPill(page, HOST);
  await sleep(400);

  // ── 3. SIZE-STABLE — sample the rect repeatedly once settled; each sample is also timed (feeds RESPONSIVE). ──
  const sizes: Array<[number, number]> = [];
  let maxMs = 0;
  for (let i = 0; i < 4; i++) {
    const t0 = Date.now();
    const s = await domSnapshot(page, HOST);
    maxMs = Math.max(maxMs, Date.now() - t0);
    if (s.size) sizes.push(s.size);
    await sleep(300);
  }
  const firstSize = sizes[0];
  const sizeStable = sizes.length > 0 && !!firstSize && sizes.every((s) => s[0] === firstSize[0] && s[1] === firstSize[1]);
  record("size-stable: the host's rect does not thrash across repeated samples", sizeStable, JSON.stringify(sizes));

  // ── 4. SURVIVES-RELOAD-POPULATED — a hard reload, then RESTORE-BY-PUSH (never a frozen page global): the
  // live host keeps re-pushing (it can't know exactly when the iframe re-mounted + re-attached its listener),
  // and the shell must come back as a single instance with the pushed marker actually rendered again. ──
  await page.reload({ waitUntil: "domcontentloaded" });
  for (let i = 0; i < 6; i++) {
    await sleep(400);
    await host.push(fixtures.patch);
  }
  let reloadSnap = await domSnapshot(page, HOST);
  const reloadDeadline = Date.now() + 6000;
  while (reloadSnap.hosts !== 1 && Date.now() < reloadDeadline) {
    await sleep(250);
    await host.push(fixtures.patch);
    reloadSnap = await domSnapshot(page, HOST);
  }
  await clickPill(page, HOST);
  let reloadText = await iframeText(page, HOST);
  const reloadPopDeadline = Date.now() + 4000;
  while (!(reloadText && reloadText.includes(fixtures.marker)) && Date.now() < reloadPopDeadline) {
    await sleep(250);
    await host.push(fixtures.patch);
    await clickPill(page, HOST);
    reloadText = await iframeText(page, HOST);
  }
  const survivesReloadPopulated = reloadSnap.hosts === 1 && reloadSnap.iframes === 1 && !!reloadText && reloadText.includes(fixtures.marker);
  record(
    "survives-reload-populated: the shell re-mounts after a hard reload and repopulates the pushed fixture content",
    survivesReloadPopulated,
    JSON.stringify({ reloadSnap, hasMarker: !!reloadText && reloadText.includes(fixtures.marker) }),
  );

  // ── 5. RESPONSIVE — the page never froze/flooded (every eval sampled above stayed fast), and the host adapts
  // to a genuinely-changed viewport (still fully on-screen at its own bottom-right anchor). ──
  const notFrozen = maxMs < 1500;
  let adaptsToViewport = false;
  let viewportDetail = "";
  try {
    const before = await page.viewportSize();
    const target = { width: Math.max(320, (before?.width ?? 1280) - 220), height: Math.max(320, (before?.height ?? 800) - 160) };
    await page.setViewportSize(target);
    await sleep(250);
    const afterSnap = await domSnapshot(page, HOST);
    adaptsToViewport = !!afterSnap.rect && afterSnap.rect.right <= target.width + 1 && afterSnap.rect.bottom <= target.height + 1;
    viewportDetail = `target=${JSON.stringify(target)} rect=${JSON.stringify(afterSnap.rect)}`;
  } catch (e) {
    viewportDetail = (e as Error)?.message ?? String(e);
  }
  record(
    "responsive: no layout-thrash flood (eval stayed fast) and the host adapts to a changed viewport",
    notFrozen && adaptsToViewport,
    `maxMs=${maxMs} notFrozen=${notFrozen} adaptsToViewport=${adaptsToViewport} ${viewportDetail}`,
  );
}

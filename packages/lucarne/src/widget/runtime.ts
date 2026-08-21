// The IFRAME runtime — bundled into a consumer's own srcdoc bundle (via `build.ts`). Ported from the prior
// single-app implementation's `main.tsx` shell mechanics
// (`:611-622,678-688,725-728,747-756,763-776,793-811,890-918`): the envelope reducer's pin/dispatch half
// (`reducer.ts`, extracted separately so it's Chrome-free testable), the ARIA tablist organ switcher with
// roving keyboard focus, the anti-jitter resize relay, the pill↔panel morph, and the drag-from-header relay.
// EXCLUDED (stays with the downstream consumer, LS-20): the per-key patch reducers (`main.tsx:689-723`), the
// fork effect, and app-specific option re-sync — this runtime never inspects what's INSIDE a patch, it only
// shallow-merges patches into a running `state` object and hands that to whichever panel/sheet is on screen.
//
// FRAMEWORK-FREE BY DESIGN (LS-15 dev/03's grep gate): plain DOM + `emitter.ts`'s tiny pub/sub. A panel's own
// `render(el, state)` may use ANY UI library (via the dedicated adapter subpath, or none) — the CORE never
// imports one.
import { Emitter } from "./emitter.js";
import { createEnvelopeReducer } from "./reducer.js";
import { createSizeHandshake } from "./size-handshake.js";
import { chromeKey } from "./ns.js";

export type Theme = "light" | "dark";
export type Tone = "live" | "warn" | "dead" | "off";

export interface PanelDef {
  id: string;
  title: string;
  /** A small inline HTML glyph (already-escaped by the caller) — rendered in the tab. Optional. */
  icon?: string;
  /** A live count (e.g. a queue depth) rendered as `.oi.badge` on the tab. `null`/`undefined`/`0` hides it. */
  badge?: () => number | null | undefined;
  /** A live status tone rendered as `.oi.dot.<tone>` on the tab. */
  indicator?: () => Tone | null | undefined;
  /** Renders (or re-renders) this panel's content into `el`. `state` is the runtime's shallow-merged accumulation of every patch seen so far (see the module doc) — the panel interprets whichever keys it cares about. */
  render: (el: HTMLElement, state: unknown) => void;
  /** The panel selected when the widget first opens (else the first registered panel). */
  default?: boolean;
}

export interface SheetDef {
  id: string;
  render: (el: HTMLElement, state: unknown) => void;
}

export interface PillState {
  tone?: Tone | string;
  label?: string;
  sub?: string;
}

export interface CreateWidgetOptions {
  /** This instance's namespace — must match the `ns` the host (`WidgetHost.attach`) and injector were built with. */
  ns: string;
  /** An app-defined content-schema version, for the CONSUMER's own patch reducers to key off — this package never reads it. */
  version?: number;
  /** Mount point; defaults to `document.getElementById("app")`, else `document.body`. */
  root?: HTMLElement;
}

export interface CreateWidgetTransportOptions {
  /** This instance's namespace — must match the `ns` used by `WidgetHost.attach`. */
  ns: string;
}

/**
 * The visual-shell-free half of a Lucarne widget. It owns only the versioned host→iframe envelope,
 * identity pinning, accumulated state, page-theme relay, and named iframe→host intents. This is the
 * integration point for apps whose launcher/window chrome is supplied by another shell.
 */
export interface WidgetTransport {
  /** The shallow-merged accumulation of every accepted patch. */
  readonly state: unknown;
  /** Fires once per accepted envelope, after `state` has been updated. */
  onPatch(cb: (patch: unknown) => void): () => void;
  /** Queue a named intent for `WidgetHost.onIntent(name, cb)` to drain. */
  sendIntent(name: string, payload: unknown): string;
  /** Update delivery-shell launcher metadata when the selected shell supports it. */
  setLauncher(state: {
    badge?: string | number | null;
    label?: string;
    icon?: string | null;
    hidden?: boolean;
  }): void;
  /** Ask the delivery shell to close without coupling the app to its visual implementation. */
  closeShell(): void;
  onTheme(cb: (theme: Theme) => void): () => void;
  /** Fires when an alternate delivery shell opens or closes this app's viewport. */
  onVisibility(cb: (visible: boolean) => void): () => void;
  destroy(): void;
}

export interface Widget {
  registerPanel(def: PanelDef): void;
  registerSheet(def: SheetDef): void;
  /** Fires once per ACCEPTED envelope (after identity-pin + version + `ns` checks — see `reducer.ts`) with just that envelope's patch. */
  onPatch(cb: (patch: unknown) => void): () => void;
  /** Queue a named intent for `WidgetHost.onIntent(name, cb)` to drain. Returns the generated intent id. */
  sendIntent(name: string, payload: unknown): string;
  setPill(state: PillState): void;
  /** Opens the sheet by id (overlays whichever panel is showing); `null` closes any open sheet. */
  openSheet(id: string | null): void;
  requestResize(): void;
  onTheme(cb: (theme: Theme) => void): () => void;
  open(): void;
  close(): void;
  destroy(): void;
}

function post(ns: string, msg: Record<string, unknown>): void {
  try {
    parent.postMessage({ [chromeKey(ns)]: msg }, "*");
  } catch {
    /* a detached/sandboxed parent — nothing to do */
  }
}

function genId(): string {
  return `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
}

/** Shallow-merge one incoming patch into the running state accumulator — the ONE opinion this package holds about patch shape: if both sides are plain objects, merge key-by-key (a later patch's key wins); otherwise the patch replaces the accumulator outright. This is deliberately naive (no deep merge, no array concat) — a consumer wanting richer semantics reduces further itself inside its own `onPatch` subscriber (that's exactly what stays with the downstream consumer, `main.tsx:689-723`). */
function mergePatch(prev: unknown, patch: unknown): unknown {
  const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (isPlain(prev) && isPlain(patch)) return { ...prev, ...patch };
  return patch;
}

/**
 * Connect an iframe app to Lucarne without rendering any launcher, panel, tab, drag handle, or resize
 * chrome. Consumers may render directly into their own root while a dedicated overlay runtime owns the
 * surrounding window.
 */
export function createWidgetTransport(opts: CreateWidgetTransportOptions): WidgetTransport {
  const ns = opts.ns;
  const patchEmitter = new Emitter<unknown>();
  const themeEmitter = new Emitter<Theme>();
  const visibilityEmitter = new Emitter<boolean>();
  let state: unknown = {};
  let destroyed = false;

  const reducer = createEnvelopeReducer({
    ns,
    onPatch: (patch) => {
      state = mergePatch(state, patch);
      patchEmitter.emit(patch);
    },
  });

  function onMessage(e: MessageEvent): void {
    const data = e.data as { theme?: Theme } | undefined;
    if (data && (data.theme === "light" || data.theme === "dark")) {
      document.documentElement.setAttribute("data-theme", data.theme);
      themeEmitter.emit(data.theme);
      return;
    }
    const shellMessage = (e.data as Record<string, unknown> | null)?.[chromeKey(ns)] as
      | Record<string, unknown>
      | undefined;
    if (shellMessage?.action === "visibility" && typeof shellMessage.visible === "boolean") {
      visibilityEmitter.emit(shellMessage.visible);
      return;
    }
    reducer.handleMessage(e.data);
  }

  window.addEventListener("message", onMessage);
  post(ns, { action: "ready" });

  return {
    get state() {
      return state;
    },
    onPatch(cb) {
      return patchEmitter.on(cb);
    },
    sendIntent(name, payload) {
      const id = genId();
      post(ns, { action: "intent", name, id, payload });
      return id;
    },
    setLauncher(state) {
      post(ns, { action: "launcher", ...state });
    },
    closeShell() {
      post(ns, { action: "close" });
    },
    onTheme(cb) {
      return themeEmitter.on(cb);
    },
    onVisibility(cb) {
      return visibilityEmitter.on(cb);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      window.removeEventListener("message", onMessage);
      patchEmitter.clear();
      themeEmitter.clear();
      visibilityEmitter.clear();
    },
  };
}

/**
 * Build one widget instance's iframe-side runtime: the envelope subscription, the shell chrome (pill/panel/
 * tablist/drag/resize/theme), and the panel/sheet registry. Call once per bundle entrypoint.
 */
export function createWidget(opts: CreateWidgetOptions): Widget {
  const ns = opts.ns;
  const root: HTMLElement = opts.root ?? document.getElementById("app") ?? document.body;

  const panels: PanelDef[] = [];
  const sheets = new Map<string, SheetDef>();
  const transport = createWidgetTransport({ ns });

  let isOpen = false;
  let activeTab: string | null = null;
  let openSheetId: string | null = null;
  let pillState: PillState = { tone: "off", label: "", sub: "" };
  const unsubscribeRender = transport.onPatch(() => renderActive());

  // ── DOM shell ──────────────────────────────────────────────────────────────────────────────
  const wrap = document.createElement("div");
  wrap.className = "wrap";
  root.appendChild(wrap);

  function clear(el: HTMLElement): void {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function renderPill(): void {
    clear(wrap);
    const btn = document.createElement("button");
    btn.className = `pill${pillState.tone ? " " + pillState.tone : ""}`;
    btn.title = [pillState.label, pillState.sub].filter(Boolean).join(" — ");
    const brand = document.createElement("span");
    brand.className = "brand";
    btn.appendChild(brand);
    const lead = document.createElement("span");
    lead.className = "lead";
    lead.textContent = pillState.label ?? "";
    btn.appendChild(lead);
    const triad = document.createElement("span");
    triad.className = "triad";
    triad.setAttribute("aria-hidden", "true");
    for (const p of panels) {
      const dot = document.createElement("span");
      const tone = p.indicator?.();
      dot.className = `oi dot${tone ? " " + tone : ""}`;
      triad.appendChild(dot);
      const n = p.badge?.();
      if (n) {
        const badge = document.createElement("span");
        badge.className = "oi badge";
        badge.textContent = String(n);
        triad.appendChild(badge);
      }
    }
    btn.appendChild(triad);
    btn.addEventListener("click", () => api.open());
    wrap.appendChild(btn);
  }

  const bodyContainers = new Map<string, HTMLElement>();

  function tabButtons(): HTMLButtonElement[] {
    return [...wrap.querySelectorAll<HTMLButtonElement>(".organ")];
  }

  // ARIA tablist roving focus — ported from `main.tsx`'s `onOrganKey`: arrow keys rove between organs when one
  // is focused; Home/End jump to the first/last. `stopPropagation` so this never doubles as content navigation.
  function onOrganKey(e: KeyboardEvent): void {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const ids = panels.map((p) => p.id);
    const i = Math.max(0, ids.indexOf(activeTab ?? ""));
    const n = e.key === "Home" ? 0 : e.key === "End" ? ids.length - 1 : e.key === "ArrowRight" ? Math.min(i + 1, ids.length - 1) : Math.max(i - 1, 0);
    const nextId = ids[n];
    if (nextId === undefined) return;
    selectTab(nextId);
    tabButtons()[n]?.focus();
  }

  function selectTab(id: string): void {
    if (activeTab === id) return;
    activeTab = id;
    renderPanel();
  }

  // drag from the header (not its buttons) — the gesture begins in THIS document, so the browser routes the
  // moves here; we relay frame-independent screen coords to the host, which repositions itself (`injector.ts`).
  function onHeaderDown(e: MouseEvent): void {
    const target = e.target as HTMLElement | null;
    if (e.button !== 0 || target?.closest?.("button")) return;
    e.preventDefault();
    post(ns, { action: "dragstart", sx: e.screenX, sy: e.screenY });
    const onMove = (ev: MouseEvent): void => {
      if (ev.buttons === 0) return onUp(); // released off-window → end cleanly, don't freeze
      post(ns, { action: "dragmove", x: ev.screenX, y: ev.screenY });
    };
    const onUp = (): void => {
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
      post(ns, { action: "dragend" });
    };
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
  }

  function renderPanel(): void {
    clear(wrap);
    bodyContainers.clear();
    const panelEl = document.createElement("div");
    panelEl.className = "panel";

    const header = document.createElement("header");
    header.addEventListener("mousedown", onHeaderDown);
    const grabber = document.createElement("span");
    grabber.className = "grabber";
    grabber.setAttribute("aria-hidden", "true");
    header.appendChild(grabber);

    const tablist = document.createElement("div");
    tablist.className = "organs";
    tablist.setAttribute("role", "tablist");
    tablist.addEventListener("keydown", onOrganKey);
    if (activeTab == null) activeTab = panels.find((p) => p.default)?.id ?? panels[0]?.id ?? null;
    panels.forEach((p, i) => {
      const btn = document.createElement("button");
      btn.className = `organ${p.id === activeTab ? " on" : ""}`;
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", String(p.id === activeTab));
      btn.tabIndex = p.id === activeTab ? 0 : -1;
      btn.title = p.title;
      btn.textContent = p.title;
      btn.addEventListener("click", () => selectTab(p.id));
      tablist.appendChild(btn);
      void i;
    });
    header.appendChild(tablist);

    const winctl = document.createElement("div");
    winctl.className = "winctl";
    const closeBtn = document.createElement("button");
    closeBtn.className = "ico";
    closeBtn.setAttribute("aria-label", "close");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => api.close());
    winctl.appendChild(closeBtn);
    header.appendChild(winctl);

    panelEl.appendChild(header);

    const body = document.createElement("div");
    body.className = "body";
    for (const p of panels) {
      const container = document.createElement("div");
      container.className = "organ-body";
      container.style.display = p.id === activeTab ? "" : "none";
      bodyContainers.set(p.id, container);
      body.appendChild(container);
    }
    panelEl.appendChild(body);

    if (openSheetId && sheets.has(openSheetId)) {
      const sheet = sheets.get(openSheetId)!;
      const overlay = document.createElement("div");
      overlay.className = "sheet";
      panelEl.appendChild(overlay);
      sheet.render(overlay, transport.state);
    }

    wrap.appendChild(panelEl);
    renderActive();
    scheduleResize();
  }

  function renderActive(): void {
    if (!isOpen) return;
    const container = activeTab ? bodyContainers.get(activeTab) : undefined;
    const def = panels.find((p) => p.id === activeTab);
    if (container && def) def.render(container, transport.state);
    if (openSheetId) {
      const sheetEl = wrap.querySelector<HTMLElement>(".sheet");
      const sheet = sheets.get(openSheetId);
      if (sheetEl && sheet) sheet.render(sheetEl, transport.state);
    }
  }

  function renderShell(): void {
    if (isOpen) renderPanel();
    else renderPill();
  }

  // anti-jitter resize: tell the host to size the iframe to exactly what we draw. Only post when the size
  // MEANINGFULLY changes — posting on every observer fire creates a resize→reflow→resize feedback loop. The
  // ACKNOWLEDGED half of that relay (re-post until the host answers, so a first post that lands before the host
  // page armed its listener can't be silently lost) lives in `size-handshake.ts` — pure and separately tested.
  const sizeHandshake = createSizeHandshake({ ns, post: (msg) => post(ns, msg) });
  let resizeObserver: ResizeObserver | null = null;
  function scheduleResize(): void {
    if (typeof ResizeObserver === "undefined") return;
    resizeObserver?.disconnect();
    resizeObserver = new ResizeObserver(() => sendResize());
    resizeObserver.observe(wrap);
    sendResize();
  }
  function sendResize(): void {
    const r = wrap.getBoundingClientRect();
    sizeHandshake.measured(Math.ceil(r.width), Math.ceil(r.height));
  }

  // Size acknowledgements belong to the legacy shell. Envelope/theme handling lives in the transport.
  function onMessage(e: MessageEvent): void {
    sizeHandshake.handleMessage(e.data);
  }
  window.addEventListener("message", onMessage);

  const api: Widget = {
    registerPanel(def: PanelDef): void {
      panels.push(def);
      if (def.default || activeTab == null) activeTab = def.id;
      renderShell();
    },
    registerSheet(def: SheetDef): void {
      sheets.set(def.id, def);
    },
    onPatch(cb: (patch: unknown) => void): () => void {
      return transport.onPatch(cb);
    },
    sendIntent(name: string, payload: unknown): string {
      return transport.sendIntent(name, payload);
    },
    setPill(next: PillState): void {
      pillState = { ...pillState, ...next };
      if (!isOpen) renderPill();
    },
    openSheet(id: string | null): void {
      openSheetId = id;
      if (isOpen) renderPanel();
    },
    requestResize(): void {
      sendResize();
    },
    onTheme(cb: (theme: Theme) => void): () => void {
      return transport.onTheme(cb);
    },
    open(): void {
      if (isOpen) return;
      isOpen = true;
      renderShell();
    },
    close(): void {
      if (!isOpen) return;
      isOpen = false;
      renderShell();
    },
    destroy(): void {
      window.removeEventListener("message", onMessage);
      unsubscribeRender();
      transport.destroy();
      sizeHandshake.dispose();
      resizeObserver?.disconnect();
      clear(wrap);
      wrap.remove();
    },
  };

  renderShell();
  return api;
}

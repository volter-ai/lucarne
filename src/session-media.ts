import { attachBrowser, attachPage, listPages, type CdpConn, type PageTarget } from "./cdp.js";
import { startRecorder, type Recorder } from "./recorder.js";
import { virtualKeyCode } from "./keymap.js";
import type { FrameSource, InputEvent } from "./porthole.js";

const MOUSE_BUTTON = ["left", "middle", "right"] as const;
const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

// editing accelerators (Cmd/Ctrl + key) → CDP edit command
const EDIT_COMMANDS: Record<string, string> = {
  KeyA: "selectAll", KeyC: "copy", KeyV: "paste", KeyX: "cut", KeyZ: "undo", KeyY: "redo", RedoZ: "redo",
};

/** A captured network / console / browser-log entry. */
export interface LogEntry {
  kind: "network" | "console" | "log";
  ts: number;
  level?: string;
  method?: string;
  url?: string;
  text?: string;
}

/** A semantic action in the session — what the human (or agent) did. */
export interface ActivityEvent {
  ts: number;
  actor: "human" | "agent";
  kind: "nav" | "click" | "type" | "download" | "submit";
  url?: string;
  x?: number;
  y?: number;
  /** focused field for `type` (name/id/aria). */
  field?: string;
  /** typed text for `type`, "‹redacted›" for password/sensitive fields. */
  value?: string;
  /** the clicked element (A2): a CSS-ish selector, its visible text, and role. */
  selector?: string;
  text?: string;
  role?: string;
}

/** Where the session is RIGHT NOW + how fresh the human's last action is. */
export interface ActivityNow {
  url?: string;
  title?: string;
  focusedField?: string;
  lastHumanActionMsAgo: number | null;
}

export interface SessionMedia {
  /** The shared CDP tap on the ACTIVE tab — reused by engine features (upload, screenshot…). */
  cdp: CdpConn;
  frames: FrameSource;
  /** `actor` attributes the event in the activity log: porthole = human, act() = agent. */
  onInput(ev: InputEvent, actor?: "human" | "agent"): void;
  /** Stream stats (frames + bytes served) for status / "pressure". */
  stats(): { frames: number; streamedBytes: number };
  /** Snapshot of captured logs (network/console/browser), oldest first. */
  logs(): LogEntry[];
  /** Subscribe to live log entries (for the SSE stream). */
  onLog(cb: (e: LogEntry) => void): () => void;
  /** Semantic activity events (what the human/agent did), oldest first. */
  activity(): ActivityEvent[];
  /** Subscribe to live activity events (for the SSE stream). */
  onActivity(cb: (e: ActivityEvent) => void): () => void;
  /** Current state: where the session is + how fresh the human's last action is. */
  activityNow(): Promise<ActivityNow>;
  /** List the session's open tabs. */
  tabs(): Promise<PageTarget[]>;
  /** Point the porthole/screencast + input at a different tab. */
  switchTab(targetId: string): Promise<void>;
  /** The active tab's target id. */
  activeTabId(): string | undefined;
  close(): void;
}

/**
 * The backend-agnostic media plane: attach to a session's CDP, run ONE screencast,
 * and fan the JPEG frames out to both the porthole (WebSocket) and the recorder.
 * Both `native` and `docker` expose CDP, so this is identical for both — the only
 * thing a backend decides is how the browser is isolated/spawned.
 */
export async function startSessionMedia(opts: {
  cdpUrl: string;
  recDir: string;
  downloadDir: string;
  viewport: { width: number; height: number };
  record: boolean;
  fps: number;
  retentionMin: number;
  segmentSeconds?: number;
  mobile?: boolean;
  quality?: number;
  geo?: { latitude: number; longitude: number; accuracy?: number };
  activity?: boolean;
}): Promise<SessionMedia> {
  // The active-tab page conn is MUTABLE: switchTab re-taps a different target so
  // the porthole/screencast + input follow it. `page` is the live reference all
  // closures read; engine features read it back via the `cdp` field (kept in sync).
  const firstPage = await listPages(opts.cdpUrl);
  let activeId: string | undefined = firstPage[0]?.id;
  let page = await attachPage(opts.cdpUrl);
  // Capture downloads to a retrievable per-session dir (list/get over the API).
  // MUST be browser-level + kept open: a page-session setting only scopes to that
  // session, so a download from any other page/driver would escape it.
  const browserConn = await attachBrowser(opts.cdpUrl);
  browserConn.call("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: opts.downloadDir, eventsEnabled: true }).catch(() => {});
  // Geolocation override needs the permission granted browser-wide + the override
  // re-applied per page (it's page-session-scoped, like mobile emulation).
  if (opts.geo) browserConn.call("Browser.grantPermissions", { permissions: ["geolocation"] }).catch(() => {});
  let latest: Buffer | null = null;
  let frameCount = 0, streamedBytes = 0;
  const subs = new Set<(f: Buffer) => void>();
  // Bounded ring of captured logs + live subscribers (SSE). Wired per page so it
  // follows tab switches; the buffer + subscribers are shared across tabs.
  const LOG_CAP = 2000;
  const logBuf: LogEntry[] = [];
  const logSubs = new Set<(e: LogEntry) => void>();
  const pushLog = (e: LogEntry): void => {
    logBuf.push(e);
    if (logBuf.length > LOG_CAP) logBuf.shift();
    for (const cb of logSubs) cb(e);
  };
  // ── Activity log: semantic, actor-tagged actions (Initiative II) ──
  // Opt-in (privacy: captures human input). nav from CDP; click/type from onInput;
  // typed text coalesced + redacted for secret fields. Wired per page (tab switch).
  const ACT_CAP = 1000;
  const actBuf: ActivityEvent[] = [];
  const actSubs = new Set<(e: ActivityEvent) => void>();
  let lastHumanMs = 0;
  let curUrl: string | undefined;
  const pushAct = (e: ActivityEvent): void => {
    if (!opts.activity) return;
    actBuf.push(e);
    if (actBuf.length > ACT_CAP) actBuf.shift();
    for (const cb of actSubs) cb(e);
  };
  // coalesce consecutive keystrokes into one `type` event, then check the focused
  // field's secrecy off the hot path and redact.
  let typeBuf: { actor: "human" | "agent"; text: string } | null = null;
  let typeTimer: ReturnType<typeof setTimeout> | undefined;
  const flushType = async (): Promise<void> => {
    const buf = typeBuf; typeBuf = null;
    if (!buf || !buf.text) return;
    let field: string | undefined, secret = false;
    try {
      const r = await page.call("Runtime.evaluate", { expression: "(()=>{const e=document.activeElement;if(!e)return '|';return (e.type||e.tagName.toLowerCase())+'|'+(e.name||e.id||e.getAttribute('aria-label')||'')})()", returnByValue: true });
      const [t, n] = String(r.result?.value ?? "|").split("|");
      secret = t === "password"; field = n || undefined;
    } catch { /* page gone */ }
    pushAct({ ts: Date.now(), actor: buf.actor, kind: "type", field, value: secret ? "‹redacted›" : buf.text });
  };
  const appendType = (actor: "human" | "agent", text: string): void => {
    if (!opts.activity) return;
    if (!typeBuf || typeBuf.actor !== actor) { void flushType(); typeBuf = { actor, text: "" }; }
    typeBuf.text += text;
    clearTimeout(typeTimer); typeTimer = setTimeout(() => void flushType(), 800);
  };
  // A2: resolve the clicked element off the hot path (the input already dispatched).
  const enrichClick = async (actor: "human" | "agent", x?: number, y?: number): Promise<void> => {
    const ts = Date.now();
    let selector: string | undefined, text: string | undefined, role: string | undefined;
    try {
      const expr = `(()=>{const e=document.elementFromPoint(${x ?? 0},${y ?? 0});if(!e)return null;const id=e.id?'#'+e.id:'';const cls=(!id&&typeof e.className==='string'&&e.className.trim())?'.'+e.className.trim().split(/\\s+/)[0]:'';return JSON.stringify({s:e.tagName.toLowerCase()+id+cls,t:((e.innerText||e.value||e.getAttribute('aria-label')||'').trim().slice(0,60)),r:e.getAttribute('role')||e.tagName.toLowerCase()})})()`;
      const r = await page.call("Runtime.evaluate", { expression: expr, returnByValue: true });
      if (r.result?.value) { const o = JSON.parse(String(r.result.value)); selector = o.s; text = o.t || undefined; role = o.r; }
    } catch { /* page gone */ }
    pushAct({ ts, actor, kind: "click", x, y, selector, text, role });
  };
  const wireActivity = (c: CdpConn): void => {
    c.on("Page.frameNavigated", (p: { frame?: { url?: string; parentId?: string } }) => {
      if (p.frame?.parentId) return; // main frame only
      void flushType();
      const url = p.frame?.url ?? "";
      curUrl = url;
      pushAct({ ts: Date.now(), actor: Date.now() - lastHumanMs < 1500 ? "human" : "agent", kind: "nav", url });
    });
  };
  const wireLogs = (c: CdpConn): void => {
    c.send("Network.enable");
    c.on("Network.requestWillBeSent", (p: { request: { method: string; url: string } }) =>
      pushLog({ kind: "network", method: p.request.method, url: p.request.url, ts: Date.now() }));
    c.send("Runtime.enable");
    c.on("Runtime.consoleAPICalled", (p: { type: string; args: { value?: unknown; description?: string }[] }) =>
      pushLog({ kind: "console", level: p.type, text: (p.args || []).map((a) => String(a.value ?? a.description ?? "")).join(" "), ts: Date.now() }));
    c.send("Log.enable");
    c.on("Log.entryAdded", (p: { entry: { level: string; text: string } }) =>
      pushLog({ kind: "log", level: p.entry.level, text: p.entry.text, ts: Date.now() }));
  };
  const wireScreencast = (c: CdpConn): void => {
    if (opts.mobile) {
      // Mobile emulation must be re-applied per page (it's session-scoped), so it
      // lives here — applied to the initial tap AND any tab we switch to.
      c.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
      c.send("Emulation.setUserAgentOverride", { userAgent: MOBILE_UA });
      c.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    }
    if (opts.geo) c.send("Emulation.setGeolocationOverride", { latitude: opts.geo.latitude, longitude: opts.geo.longitude, accuracy: opts.geo.accuracy ?? 50 });
    c.on("Page.screencastFrame", (p: { data: string; sessionId: number }) => {
      latest = Buffer.from(p.data, "base64");
      frameCount++; streamedBytes += latest.length;
      for (const cb of subs) cb(latest);
      c.send("Page.screencastFrameAck", { sessionId: p.sessionId });
    });
    c.send("Page.enable");
    c.send("Page.startScreencast", { format: "jpeg", quality: opts.quality ?? 60, maxWidth: opts.viewport.width, maxHeight: opts.viewport.height, everyNthFrame: 1 });
    wireLogs(c);
    wireActivity(c);
  };
  wireScreencast(page);

  const frames: FrameSource = {
    get: () => latest,
    subscribe: (cb) => { subs.add(cb); return () => subs.delete(cb); },
  };
  const onInput = (ev: InputEvent, actor: "human" | "agent" = "human"): void => {
    const modifiers = ev.mod ?? 0;
    if (actor === "human") lastHumanMs = Date.now();
    // activity log: a click (down) and typed text are the human/agent's semantic acts
    if (ev.t === "down") { void flushType(); void enrichClick(actor, ev.x, ev.y); }
    else if (ev.t === "paste" && typeof ev.text === "string") appendType(actor, ev.text);
    else if (ev.t === "ime" && ev.phase === "commit" && ev.text) appendType(actor, ev.text);
    else if (ev.t === "keydown" && ev.key && ev.key.length === 1 && (modifiers & 2) === 0 && (modifiers & 4) === 0) appendType(actor, ev.key);
    if (ev.t === "down" || ev.t === "up" || ev.t === "move") {
      page.send("Input.dispatchMouseEvent", {
        type: ev.t === "down" ? "mousePressed" : ev.t === "up" ? "mouseReleased" : "mouseMoved",
        x: ev.x, y: ev.y,
        button: ev.t === "move" ? "none" : (MOUSE_BUTTON[ev.button ?? 0] ?? "left"),
        buttons: ev.buttons ?? 0,           // held buttons → enables drags
        clickCount: ev.t === "move" ? 0 : (ev.clickCount || 1), // double/triple-click
        modifiers,
      });
    } else if (ev.t === "wheel") {
      page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: ev.x, y: ev.y, deltaX: ev.dx, deltaY: ev.dy, modifiers });
    } else if (ev.t === "touch") {
      const type = ev.phase === "start" ? "touchStart" : ev.phase === "end" ? "touchEnd" : "touchMove";
      page.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x: ev.x, y: ev.y }] });
    } else if (ev.t === "ime") {
      // IME/composition (CJK etc.) — plain keydowns can't produce composed text.
      const text = ev.text ?? "";
      if (ev.phase === "commit") page.send("Input.insertText", { text });
      else page.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
    } else if (ev.t === "nav") {
      if (ev.action === "go" && ev.url) page.send("Page.navigate", { url: ev.url });
      else if (ev.action === "back") page.send("Runtime.evaluate", { expression: "history.back()" });
      else if (ev.action === "forward") page.send("Runtime.evaluate", { expression: "history.forward()" });
      else if (ev.action === "reload") page.send("Page.reload", {});
    } else if (ev.t === "paste" && typeof ev.text === "string") {
      // Clipboard sync: deliver text the operator pasted into the porthole as if
      // pasted into the focused field (CDP inserts it like a real paste).
      page.send("Input.insertText", { text: ev.text });
    } else if ((ev.t === "keydown" || ev.t === "keyup") && ev.key) {
      const down = ev.t === "keydown";
      const cmdKey = (modifiers & 2) !== 0 || (modifiers & 4) !== 0; // ctrl or meta = "command" modifier
      // a printable char inserts text on keyDown — UNLESS a command modifier is held (that's a shortcut)
      const text = down && ev.key.length === 1 && !cmdKey ? ev.key : undefined;
      // editing accelerators must be sent as CDP `commands` — synthetic keydowns alone don't fire them
      const command = down && cmdKey && ev.code ? EDIT_COMMANDS[ev.code === "KeyZ" && modifiers & 8 ? "RedoZ" : ev.code] : undefined;
      page.send("Input.dispatchKeyEvent", {
        type: down ? (text !== undefined ? "keyDown" : "rawKeyDown") : "keyUp",
        key: ev.key,
        code: ev.code ?? "",
        windowsVirtualKeyCode: virtualKeyCode(ev.key, ev.code),
        ...(text !== undefined ? { text, unmodifiedText: text } : {}),
        ...(command ? { commands: [command] } : {}),
        modifiers,
        autoRepeat: !!ev.repeat,
        location: 0,
      });
    }
  };

  const recorder: Recorder | null = opts.record
    ? startRecorder({ recDir: opts.recDir, fps: opts.fps, retentionMin: opts.retentionMin, segmentSeconds: opts.segmentSeconds, frames })
    : null;

  const ret: SessionMedia = {
    cdp: page,
    frames,
    onInput,
    stats: () => ({ frames: frameCount, streamedBytes }),
    logs: () => [...logBuf],
    onLog: (cb) => { logSubs.add(cb); return () => logSubs.delete(cb); },
    activity: () => [...actBuf],
    onActivity: (cb) => { actSubs.add(cb); return () => actSubs.delete(cb); },
    async activityNow(): Promise<ActivityNow> {
      let title: string | undefined, focusedField: string | undefined;
      try {
        const r = await page.call("Runtime.evaluate", { expression: "JSON.stringify({t:document.title,f:document.activeElement&&document.activeElement!==document.body?(document.activeElement.name||document.activeElement.id||document.activeElement.getAttribute('aria-label')||document.activeElement.tagName.toLowerCase()):null})", returnByValue: true });
        const o = JSON.parse(String(r.result?.value ?? "{}")); title = o.t || undefined; focusedField = o.f || undefined;
      } catch { /* page gone */ }
      return { url: curUrl, title, focusedField, lastHumanActionMsAgo: lastHumanMs ? Date.now() - lastHumanMs : null };
    },
    tabs: () => listPages(opts.cdpUrl),
    activeTabId: () => activeId,
    async switchTab(targetId: string): Promise<void> {
      if (targetId === activeId) return;
      const next = await attachPage(opts.cdpUrl, targetId);
      wireScreencast(next);
      const old = page;
      page = next;            // input + engine features follow the new tab
      activeId = targetId;
      ret.cdp = next;
      try { old.send("Page.stopScreencast"); old.close(); } catch { /* ignore */ }
    },
    close(): void {
      try { recorder?.close(); } catch { /* ignore */ }
      try { page.close(); } catch { /* ignore */ }
      try { browserConn.close(); } catch { /* ignore */ }
    },
  };
  return ret;
}

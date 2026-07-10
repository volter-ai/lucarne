// Minimal raw CDP (page-level) client over the Node global WebSocket, so the
// porthole and recorder can share one screencast tap, and a separate
// `connectOverCDP` driver/agent can still attach independently.
const WS = (globalThis as unknown as { WebSocket: new (url: string) => any }).WebSocket;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface CdpConn {
  /** Fire-and-forget (no result needed) — used on the hot input/screencast path. */
  send(method: string, params?: Record<string, unknown>): void;
  /** Request/response — resolves with `result`, rejects on CDP `error`. */
  call(method: string, params?: Record<string, unknown>): Promise<any>;
  on(method: string, cb: (params: any) => void): void;
  /** Fires (at most once) when the socket closes — a drop (tab/Chrome gone) OR an
   *  explicit `close()`. Lets a long-lived consumer re-establish coverage after a
   *  blip; the callback runs immediately if the socket is already closed. */
  onClose(cb: () => void): void;
  close(): void;
}

export interface PageTarget { id: string; url: string; title: string; webSocketDebuggerUrl?: string }

/** List the session's page targets (tabs), newest Chrome ordering. */
export async function listPages(base: string): Promise<PageTarget[]> {
  const targets = (await (await fetch(base + "/json")).json()) as Array<PageTarget & { type: string }>;
  return targets.filter((t) => t.type === "page").map((t) => ({ id: t.id, url: t.url, title: t.title, webSocketDebuggerUrl: t.webSocketDebuggerUrl }));
}

/** Attach to a page target — the first page, or a specific tab by `targetId`. */
export async function attachPage(base: string, targetId?: string): Promise<CdpConn> {
  // Poll for a READY page target AND connect to it, RE-FETCHING the target list on each attempt.
  // Right after a session/tab is created — and especially under many-session CI load — the `/json`
  // list can momentarily be empty / list a page with no `webSocketDebuggerUrl` yet; and a just-listed
  // target's ws endpoint can briefly refuse, OR the tab can crash and RELAUNCH with a NEW ws url. By
  // re-listing each attempt (not caching the first url) a connect retry never keeps dialing a stale/
  // dead endpoint — it dials whatever the target list currently reports. Bounded to ~5s; a target
  // that never becomes connectable still throws, so a real regression (wrong id, dead session) is
  // still caught.
  const deadline = Date.now() + 5000;
  let lastErr: unknown;
  for (;;) {
    const pages = await listPages(base).catch((e) => { lastErr = e; return [] as PageTarget[]; });
    const page = targetId ? pages.find((t) => t.id === targetId) : pages[0];
    if (page?.webSocketDebuggerUrl) {
      const wsUrl = base.replace("http://", "ws://") + "/devtools/" + page.webSocketDebuggerUrl.split("/devtools/")[1];
      try {
        return await connectCdp(wsUrl);
      } catch (e) {
        lastErr = e; // ws failed on this (possibly stale) target — loop re-fetches a fresh one
      }
    }
    if (Date.now() >= deadline) {
      throw lastErr instanceof Error ? lastErr : new Error(`lucarne: no CDP page target to attach to${targetId ? ` (${targetId})` : ""}`);
    }
    await sleep(150);
  }
}

/**
 * Attach to the BROWSER-level endpoint (not a page). Browser-domain settings like
 * download behavior must be set here to apply globally across pages/sessions —
 * a page-session call only scopes to that one session.
 */
export async function attachBrowser(base: string): Promise<CdpConn> {
  const ver = (await (await fetch(base + "/json/version")).json()) as { webSocketDebuggerUrl?: string };
  if (!ver.webSocketDebuggerUrl) throw new Error("lucarne: no browser CDP endpoint");
  return connectCdp(ver.webSocketDebuggerUrl);
}

async function connectCdp(wsUrl: string): Promise<CdpConn> {
  // Open the debugger socket, retrying a TRANSIENT connect failure a couple of times with a
  // short backoff — a freshly-created target's ws endpoint can briefly refuse the connection
  // under CI load (the "CDP websocket failed" flake). A socket that never opens across all
  // attempts still rejects, so a genuinely-dead endpoint is still surfaced (not masked).
  let ws: any;
  for (let attempt = 0; ; attempt++) {
    ws = new WS(wsUrl);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.onopen = (): void => resolve();
        ws.onerror = (): void => reject(new Error("lucarne: CDP websocket failed"));
      });
      break; // opened
    } catch (e) {
      try { ws.close(); } catch { /* ignore */ }
      if (attempt >= 2) throw e; // ~3 attempts total, then surface the failure
      await sleep(200 * (attempt + 1));
    }
  }
  let id = 1;
  let closed = false;
  const handlers = new Map<string, Set<(p: any) => void>>();
  const closeCbs = new Set<() => void>();
  const pending = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  ws.onmessage = (m: { data: unknown }): void => {
    // A malformed frame or a throwing event handler must NOT crash the whole daemon —
    // the engine wraps its own callers but this raw socket reader does not. Guard both.
    let d: any;
    try { d = JSON.parse(String(m.data)); } catch { return; }   // ignore non-JSON frames
    if (d.id !== undefined && pending.has(d.id)) {
      const p = pending.get(d.id)!;
      pending.delete(d.id);
      clearTimeout(p.timer);
      if (d.error) p.reject(new Error(`lucarne CDP ${d.error.code}: ${d.error.message}`));
      else p.resolve(d.result);
      return;
    }
    if (d.method) {
      for (const cb of handlers.get(d.method) ?? []) {
        try { cb(d.params); } catch { /* a subscriber throwing must not kill the reader */ }
      }
    }
  };
  // A dropped page socket (tab crash, Chrome GC of an idle target) otherwise goes SILENT —
  // input/screencast die with no signal. Reject every in-flight call so callers fail fast
  // instead of waiting out the 15s timeout, and mark closed so further calls reject at once.
  const handleClose = (): void => {
    if (closed) return;
    closed = true;
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error("lucarne: CDP socket closed")); }
    pending.clear();
    for (const cb of closeCbs) { try { cb(); } catch { /* a close subscriber throwing must not cascade */ } }
    closeCbs.clear();
  };
  // The socket is already OPEN here (the retry loop above waited for it). Wire the close
  // handler now — a post-open error/drop surfaces as a close, which handleClose fields.
  ws.onclose = handleClose;
  ws.onerror = handleClose;

  return {
    send(method, params = {}): void {
      try { ws.send(JSON.stringify({ id: id++, method, params })); } catch { /* closed */ }
    },
    call(method, params = {}): Promise<any> {
      if (closed) return Promise.reject(new Error("lucarne: CDP socket closed"));
      const mid = id++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { if (pending.delete(mid)) reject(new Error(`lucarne CDP timeout: ${method}`)); }, 15_000);
        const done = (fn: (v: any) => void) => (v: any) => { clearTimeout(timer); fn(v); };
        pending.set(mid, { resolve: done(resolve), reject: done(reject), timer });
        try { ws.send(JSON.stringify({ id: mid, method, params })); }
        catch (e) { clearTimeout(timer); pending.delete(mid); reject(e as Error); }
      });
    },
    on(method, cb): void {
      if (!handlers.has(method)) handlers.set(method, new Set());
      handlers.get(method)!.add(cb);
    },
    onClose(cb): void { if (closed) { try { cb(); } catch { /* ignore */ } } else closeCbs.add(cb); },
    // Drain pending so a close() during an in-flight call doesn't leave it hanging on a
    // non-unref'd 15s timer (pinning the loop); idempotent with the onclose drain.
    close(): void { handleClose(); try { ws.close(); } catch { /* ignore */ } },
  };
}

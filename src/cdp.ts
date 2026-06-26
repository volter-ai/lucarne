// Minimal raw CDP (page-level) client over the Node global WebSocket, so the
// porthole and recorder can share one screencast tap, and a separate
// `connectOverCDP` driver/agent can still attach independently.
const WS = (globalThis as unknown as { WebSocket: new (url: string) => any }).WebSocket;

export interface CdpConn {
  /** Fire-and-forget (no result needed) — used on the hot input/screencast path. */
  send(method: string, params?: Record<string, unknown>): void;
  /** Request/response — resolves with `result`, rejects on CDP `error`. */
  call(method: string, params?: Record<string, unknown>): Promise<any>;
  on(method: string, cb: (params: any) => void): void;
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
  const pages = await listPages(base);
  const page = targetId ? pages.find((t) => t.id === targetId) : pages[0];
  if (!page?.webSocketDebuggerUrl) throw new Error(`lucarne: no CDP page target to attach to${targetId ? ` (${targetId})` : ""}`);
  const wsUrl = base.replace("http://", "ws://") + "/devtools/" + page.webSocketDebuggerUrl.split("/devtools/")[1];
  return connectCdp(wsUrl);
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
  const ws = new WS(wsUrl);
  let id = 1;
  const handlers = new Map<string, Set<(p: any) => void>>();
  const pending = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void }>();
  ws.onmessage = (m: { data: unknown }): void => {
    const d = JSON.parse(String(m.data));
    if (d.id !== undefined && pending.has(d.id)) {
      const p = pending.get(d.id)!;
      pending.delete(d.id);
      if (d.error) p.reject(new Error(`lucarne CDP ${d.error.code}: ${d.error.message}`));
      else p.resolve(d.result);
      return;
    }
    if (d.method) handlers.get(d.method)?.forEach((cb) => cb(d.params));
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = (): void => resolve();
    ws.onerror = (): void => reject(new Error("lucarne: CDP websocket failed"));
  });

  return {
    send(method, params = {}): void {
      try { ws.send(JSON.stringify({ id: id++, method, params })); } catch { /* closed */ }
    },
    call(method, params = {}): Promise<any> {
      const mid = id++;
      return new Promise((resolve, reject) => {
        pending.set(mid, { resolve, reject });
        const timer = setTimeout(() => { if (pending.delete(mid)) reject(new Error(`lucarne CDP timeout: ${method}`)); }, 15_000);
        const done = (fn: (v: any) => void) => (v: any) => { clearTimeout(timer); fn(v); };
        pending.set(mid, { resolve: done(resolve), reject: done(reject) });
        try { ws.send(JSON.stringify({ id: mid, method, params })); }
        catch (e) { clearTimeout(timer); pending.delete(mid); reject(e as Error); }
      });
    },
    on(method, cb): void {
      if (!handlers.has(method)) handlers.set(method, new Set());
      handlers.get(method)!.add(cb);
    },
    close(): void { try { ws.close(); } catch { /* ignore */ } },
  };
}

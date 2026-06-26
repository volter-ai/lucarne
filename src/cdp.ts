// Minimal raw CDP (page-level) client over the Node global WebSocket, so the
// porthole and recorder can share one screencast tap, and a separate
// `connectOverCDP` driver/agent can still attach independently.
const WS = (globalThis as unknown as { WebSocket: new (url: string) => any }).WebSocket;

export interface CdpConn {
  send(method: string, params?: Record<string, unknown>): void;
  on(method: string, cb: (params: any) => void): void;
  close(): void;
}

export async function attachPage(base: string): Promise<CdpConn> {
  const targets = (await (await fetch(base + "/json")).json()) as Array<{
    type: string;
    webSocketDebuggerUrl?: string;
  }>;
  const page = targets.find((t) => t.type === "page") ?? targets[0];
  if (!page?.webSocketDebuggerUrl) throw new Error("lucarne: no CDP page target to attach to");
  const wsUrl = base.replace("http://", "ws://") + "/devtools/" + page.webSocketDebuggerUrl.split("/devtools/")[1];

  const ws = new WS(wsUrl);
  let id = 1;
  const handlers = new Map<string, Set<(p: any) => void>>();
  ws.onmessage = (m: { data: unknown }): void => {
    const d = JSON.parse(String(m.data));
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
    on(method, cb): void {
      if (!handlers.has(method)) handlers.set(method, new Set());
      handlers.get(method)!.add(cb);
    },
    close(): void { try { ws.close(); } catch { /* ignore */ } },
  };
}

// A minimal, self-contained CDP client for the ONE thing `WidgetHost` needs beyond the engine's HTTP API: reach
// every open page on a session's `cdpUrl` and evaluate a small, FIXED set of expressions this package itself
// builds (postMessage the envelope in; read-and-clear a named intent queue out). This is deliberately NOT a
// general "eval" capability re-exposed over the network — the engine's own `/eval` REPL was retired, not
// generalized (CADENCE-SPLIT-TASKSPEC.md §1.5) — it is a private implementation detail of this package, mirroring
// the shape of `lucarne`'s own internal `src/cdp.ts` (not part of that package's public exports) closely enough
// that a future refactor could delegate to it, without adding a dependency today.
//
// Node 22 ships a global `WebSocket` — the same assumption `lucarne`'s own raw client makes (`cdp.ts`'s
// `globalThis.WebSocket`) — so this needs no extra runtime dependency.
const WS = (globalThis as unknown as { WebSocket: new (url: string) => WebSocketLike }).WebSocket;

interface WebSocketLike {
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: ((e: unknown) => void) | null;
  onmessage: ((m: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface CdpPage {
  evaluate(expression: string): Promise<unknown>;
  close(): void;
}

interface PageTarget {
  id: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/** List the session's open page targets (tabs). */
export async function listPages(cdpUrl: string): Promise<PageTarget[]> {
  const res = await fetch(cdpUrl.replace(/\/$/, "") + "/json");
  const targets = (await res.json()) as Array<PageTarget & { type: string }>;
  return targets.filter((t) => t.type === "page");
}

/** Attach to one page target and return a tiny `evaluate` handle. Rejects if the target has no debugger websocket. */
export async function attachPage(cdpUrl: string, target: PageTarget): Promise<CdpPage> {
  if (!target.webSocketDebuggerUrl) throw new Error(`lucarne-widget: page ${target.id} has no CDP debugger url`);
  const base = cdpUrl.replace(/^http/, "ws").replace(/\/$/, "");
  const wsUrl = target.webSocketDebuggerUrl.startsWith("ws") ? target.webSocketDebuggerUrl : base + "/devtools/" + target.webSocketDebuggerUrl.split("/devtools/")[1];
  const ws = new WS(wsUrl);
  let seq = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (e) => reject(e instanceof Error ? e : new Error(String(e)));
  });
  ws.onmessage = (m) => {
    let d: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      d = JSON.parse(String(m.data));
    } catch {
      return;
    }
    if (d.id === undefined || !pending.has(d.id)) return;
    const p = pending.get(d.id)!;
    pending.delete(d.id);
    if (d.error) p.reject(new Error(`lucarne-widget CDP error: ${d.error.message ?? "unknown"}`));
    else p.resolve(d.result);
  };
  ws.onclose = () => {
    for (const [, p] of pending) p.reject(new Error("lucarne-widget: CDP socket closed"));
    pending.clear();
  };
  function call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = seq++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  return {
    async evaluate(expression: string): Promise<unknown> {
      const r = (await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: false })) as {
        result?: { value?: unknown };
        exceptionDetails?: { text?: string };
      };
      if (r.exceptionDetails) throw new Error(`lucarne-widget: page eval threw: ${r.exceptionDetails.text ?? "unknown"}`);
      return r.result?.value;
    },
    close(): void {
      try {
        ws.close();
      } catch {
        /* already gone */
      }
    },
  };
}

/** Evaluate `expression` in every open, non-throwaway page of the session. Best-effort per page — one dead tab never blocks the rest. */
export async function evaluateOnAllPages(cdpUrl: string, expression: string, opts: { skipUrlPrefixes?: string[] } = {}): Promise<void> {
  await evaluateOnAllPagesCollecting(cdpUrl, expression, opts);
}

/** Same as `evaluateOnAllPages`, but collects each reachable page's result (skipping pages that errored). Used by the intent-queue drain, which needs the array each page's queue produced. */
export async function evaluateOnAllPagesCollecting(cdpUrl: string, expression: string, opts: { skipUrlPrefixes?: string[] } = {}): Promise<unknown[]> {
  const skip = opts.skipUrlPrefixes ?? ["data:", "about:", "chrome:"];
  const out: unknown[] = [];
  let pages: PageTarget[];
  try {
    pages = await listPages(cdpUrl);
  } catch {
    return out; // browser unreachable right now — best-effort, matches the engine's own inject-store posture
  }
  for (const target of pages) {
    if (skip.some((p) => (target.url || "").startsWith(p))) continue;
    let page: CdpPage | undefined;
    try {
      page = await attachPage(cdpUrl, target);
      out.push(await page.evaluate(expression));
    } catch {
      /* a page that closed mid-evaluate, or never had our shell mounted — never let one page's fault drop the rest */
    } finally {
      try {
        page?.close();
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

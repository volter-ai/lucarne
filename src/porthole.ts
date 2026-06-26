import http from "node:http";

// Node 22+ ships a global WebSocket (from undici); type it loosely.
const WS = (globalThis as unknown as { WebSocket: new (url: string) => any }).WebSocket;

export interface Porthole {
  close(): void;
}

interface InputEvent {
  t: "down" | "up" | "move" | "wheel" | "key";
  x?: number;
  y?: number;
  button?: number;
  dx?: number;
  dy?: number;
  key?: string;
}

/**
 * An interactive porthole over RAW CDP (page-level), so a separate
 * `connectOverCDP` driver/agent can attach at the same time. Serves:
 *   GET /        — an MJPEG <img> page (view)
 *   GET /stream  — multipart/x-mixed-replace JPEG frames (Page.startScreencast)
 *   POST /input  — {t,x,y,...} → CDP Input.dispatch* (control)
 */
export async function startPorthole(
  cdpBase: string,
  host: string,
  viewPort: number,
  viewport: { width: number; height: number },
): Promise<Porthole> {
  const targets = (await (await fetch(cdpBase + "/json")).json()) as Array<{
    type: string;
    webSocketDebuggerUrl: string;
  }>;
  const page = targets.find((t) => t.type === "page") ?? targets[0];
  if (!page?.webSocketDebuggerUrl) throw new Error("lucarne: no CDP page target to attach a porthole to");
  const wsUrl = cdpBase.replace("http://", "ws://") + "/devtools/" + page.webSocketDebuggerUrl.split("/devtools/")[1];

  const ws = new WS(wsUrl);
  let msgId = 1;
  const cdp = (method: string, params: Record<string, unknown> = {}): void => {
    try { ws.send(JSON.stringify({ id: msgId++, method, params })); } catch { /* socket closed */ }
  };

  let latest: Buffer | null = null;
  const streams = new Set<http.ServerResponse>();
  const writeFrame = (res: http.ServerResponse, buf: Buffer): void => {
    try {
      res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`);
      res.write(buf);
      res.write("\r\n");
    } catch { /* client gone */ }
  };

  ws.onopen = (): void => {
    cdp("Page.enable");
    cdp("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: viewport.width, maxHeight: viewport.height, everyNthFrame: 1 });
  };
  ws.onmessage = (m: { data: unknown }): void => {
    const d = JSON.parse(String(m.data));
    if (d.method === "Page.screencastFrame") {
      latest = Buffer.from(d.params.data, "base64");
      for (const res of streams) writeFrame(res, latest);
      cdp("Page.screencastFrameAck", { sessionId: d.params.sessionId });
    }
  };

  const dispatch = (ev: InputEvent): void => {
    const button = (["left", "middle", "right"] as const)[ev.button ?? 0] ?? "left";
    if (ev.t === "down") cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: ev.x, y: ev.y, button, clickCount: 1 });
    else if (ev.t === "up") cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: ev.x, y: ev.y, button, clickCount: 1 });
    else if (ev.t === "move") cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: ev.x, y: ev.y });
    else if (ev.t === "wheel") cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x: ev.x, y: ev.y, deltaX: ev.dx, deltaY: ev.dy });
    else if (ev.t === "key" && ev.key) {
      if (ev.key.length === 1) cdp("Input.insertText", { text: ev.key });
      else if (["Enter", "Backspace", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(ev.key)) {
        cdp("Input.dispatchKeyEvent", { type: "keyDown", key: ev.key, code: ev.key });
        cdp("Input.dispatchKeyEvent", { type: "keyUp", key: ev.key, code: ev.key });
      }
    }
  };

  const HTML = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<style>body{margin:0;background:#111;display:flex;justify-content:center}img{max-width:100vw;max-height:100vh;touch-action:none}</style>
<img id=v src="/stream"><script>
const img=document.getElementById('v');
const post=ev=>fetch('/input',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(ev)});
const c=e=>{const r=img.getBoundingClientRect();return{x:Math.round((e.clientX-r.left)/r.width*${viewport.width}),y:Math.round((e.clientY-r.top)/r.height*${viewport.height})}};
img.addEventListener('mousedown',e=>{e.preventDefault();post({t:'down',...c(e),button:e.button})});
img.addEventListener('mouseup',e=>{e.preventDefault();post({t:'up',...c(e),button:e.button})});
img.addEventListener('mousemove',e=>post({t:'move',...c(e)}));
img.addEventListener('wheel',e=>{e.preventDefault();post({t:'wheel',...c(e),dx:e.deltaX,dy:e.deltaY})},{passive:false});
img.addEventListener('contextmenu',e=>e.preventDefault());
window.addEventListener('keydown',e=>{e.preventDefault();post({t:'key',key:e.key})});
</script>`;

  const server = http.createServer(async (req, res) => {
    if (req.url === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end(HTML); return; }
    if (req.url === "/stream") {
      res.writeHead(200, { "Content-Type": "multipart/x-mixed-replace; boundary=frame", "Cache-Control": "no-cache", Connection: "close" });
      streams.add(res);
      if (latest) writeFrame(res, latest);
      req.on("close", () => streams.delete(res));
      return;
    }
    if (req.url === "/input" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try { dispatch(JSON.parse(body) as InputEvent); } catch { /* ignore */ }
      res.writeHead(204); res.end();
      return;
    }
    res.writeHead(404); res.end();
  });
  server.listen(viewPort, host);

  return {
    close(): void { try { server.close(); ws.close(); } catch { /* ignore */ } },
  };
}

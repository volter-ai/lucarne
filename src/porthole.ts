import http from "node:http";

export interface InputEvent {
  t: "down" | "up" | "move" | "wheel" | "key";
  x?: number;
  y?: number;
  button?: number;
  dx?: number;
  dy?: number;
  key?: string;
}

/** A source of JPEG frames the view server streams. Shared with the recorder. */
export interface FrameSource {
  get(): Buffer | null;
  subscribe(cb: (frame: Buffer) => void): () => void;
}

/**
 * A mountable porthole. The engine mounts it under `/sessions/:id/view` so every
 * session's porthole lives behind ONE origin (the daemon) + the daemon's token —
 * which makes it cleanly proxy-embeddable (e.g. through a tunnel/reverse proxy).
 * `subpath` is the part after `…/view/`: "" → HTML, "stream" → MJPEG, "input" → control.
 */
export interface ViewHandler {
  handle(req: http.IncomingMessage, res: http.ServerResponse, subpath: string): Promise<void>;
}

export function createViewHandler(opts: {
  viewport: { width: number; height: number };
  token?: string | undefined;
  frames: FrameSource;
  onInput: (ev: InputEvent) => void;
}): ViewHandler {
  const { viewport, token, frames, onInput } = opts;
  const qs = token ? `?token=${encodeURIComponent(token)}` : "";
  const writeFrame = (res: http.ServerResponse, buf: Buffer): void => {
    try {
      res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`);
      res.write(buf);
      res.write("\r\n");
    } catch { /* client gone */ }
  };

  // relative URLs (resolve against `…/view/`) so the mount path doesn't matter
  const HTML = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<style>body{margin:0;background:#111;display:flex;justify-content:center}img{max-width:100vw;max-height:100vh;touch-action:none}</style>
<img id=v src="stream${qs}"><script>
const img=document.getElementById('v'), qs=${JSON.stringify(qs)};
const post=ev=>fetch('input'+qs,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(ev)});
const c=e=>{const r=img.getBoundingClientRect();return{x:Math.round((e.clientX-r.left)/r.width*${viewport.width}),y:Math.round((e.clientY-r.top)/r.height*${viewport.height})}};
img.addEventListener('mousedown',e=>{e.preventDefault();post({t:'down',...c(e),button:e.button})});
img.addEventListener('mouseup',e=>{e.preventDefault();post({t:'up',...c(e),button:e.button})});
img.addEventListener('mousemove',e=>post({t:'move',...c(e)}));
img.addEventListener('wheel',e=>{e.preventDefault();post({t:'wheel',...c(e),dx:e.deltaX,dy:e.deltaY})},{passive:false});
img.addEventListener('contextmenu',e=>e.preventDefault());
window.addEventListener('keydown',e=>{e.preventDefault();post({t:'key',key:e.key})});
</script>`;

  return {
    async handle(req, res, subpath): Promise<void> {
      if (subpath === "" || subpath === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(HTML);
        return;
      }
      if (subpath === "stream") {
        res.writeHead(200, { "Content-Type": "multipart/x-mixed-replace; boundary=frame", "Cache-Control": "no-cache", Connection: "close" });
        const cur = frames.get();
        if (cur) writeFrame(res, cur);
        const unsub = frames.subscribe((f) => writeFrame(res, f));
        req.on("close", unsub);
        return;
      }
      if (subpath === "input" && req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        try { onInput(JSON.parse(body) as InputEvent); } catch { /* ignore */ }
        res.writeHead(204); res.end();
        return;
      }
      res.writeHead(404); res.end();
    },
  };
}

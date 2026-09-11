/**
 * The viewer page, mountable on someone else's HTTP server.
 *
 * The engine already serves this page for sessions it owns (`/sessions/:id/view`). A
 * supercode-teams node owns no lucarne engine: it has a CDP port from its port table and an
 * HTTP door of its own, and it wants the page under `browser:<pane>`. So the same porthole —
 * one screencast tap fanned out over a WebSocket, input dispatched back through CDP — is
 * offered here as a plain `(req, res)` handler plus its upgrade, with nothing engine-shaped
 * around it. A key-less bearer sees the page; the CDP socket never leaves this process.
 */
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";

import { WebSocketServer } from "ws";

import { cdpHttpBase } from "./browser/provider.js";
import { portholeHtml } from "./porthole.js";
import { startSessionMedia, type SessionMedia } from "./session-media.js";

export interface ViewerOptions {
  /** The attached browser's CDP endpoint — `ws://host:port/…`, `http://host:port`, `host:port`. */
  cdpUrl: string;
  /** Screencast size. Defaults to 1280×800. */
  viewport?: { width: number; height: number };
  /** JPEG quality for the screencast. Defaults to the engine's 60. */
  quality?: number;
  /** When false the viewer is watch-only: input arriving on the socket is dropped. */
  interactable?: boolean;
}

export interface ViewerHandler {
  (req: http.IncomingMessage, res: http.ServerResponse): void;
  /** Wire this to the host server's `upgrade` event for the live frame socket. */
  upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void;
  /** Drop the CDP tap. The attached browser is left running — lucarne never owns it. */
  close(): Promise<void>;
}

/**
 * Build a handler that serves the viewer for ONE attached browser. The CDP tap is opened on
 * the first request, so mounting the handler costs nothing until someone looks.
 */
export function createViewerHandler(options: ViewerOptions): ViewerHandler {
  const base = cdpHttpBase(options.cdpUrl);
  const viewport = options.viewport ?? { width: 1280, height: 800 };
  const interactable = options.interactable !== false;
  const wss = new WebSocketServer({ noServer: true });

  let media: Promise<SessionMedia> | null = null;
  const attach = (): Promise<SessionMedia> => {
    if (!media) {
      media = startSessionMedia({
        cdpUrl: base,
        recDir: path.join(os.tmpdir(), "lucarne-viewer-rec"),
        downloadDir: path.join(os.tmpdir(), "lucarne-viewer-dl"),
        viewport,
        record: false,
        fps: 0,
        retentionMin: 0,
        quality: options.quality ?? 60,
        activity: false,
        // The browser belongs to whoever launched it; take the screencast, change no policy.
        viewOnly: true,
      }).catch((error: Error) => { media = null; throw error; });
    }
    return media;
  };

  // The porthole's own markup, plus one addition that matters when it is hosted rather than
  // engine-served: paint `./frame.jpg` at once so the first sight of the page does not wait
  // for the socket (and a viewer behind a proxy that forbids upgrades still sees something).
  const html = portholeHtml(viewport) +
    "\n<script>fetch('./frame.jpg').then(r=>r.ok?r.blob():null).then(b=>b&&createImageBitmap(b))" +
    ".then(bm=>{if(bm){ctx.drawImage(bm,0,0,VW,VH);bm.close&&bm.close()}}).catch(()=>{});</script>\n";

  /**
   * The handler is mounted under a prefix it is never told ("/browser/<pane>/"), so routing
   * reads the TAIL of the path: a trailing slash is the page, a known filename is that asset,
   * and a prefix asked for without its slash is redirected onto one rather than 404'd.
   */
  const ASSETS = new Set(["index.html", "frame.jpg", "status.json", "ws"]);
  const route = (url: string): string => {
    const pathname = new URL(url, "http://viewer.invalid").pathname;
    if (pathname.endsWith("/")) return "index.html";
    const name = pathname.slice(pathname.lastIndexOf("/") + 1);
    if (ASSETS.has(name)) return name;
    return name.includes(".") ? "404" : "redirect";
  };

  /**
   * A JPEG of the page NOW. The screencast only emits on visual change, so a page that has
   * been static since the tap opened has no cached frame; capture one over the same CDP
   * socket rather than reporting an empty viewer.
   */
  const frame = async (m: SessionMedia): Promise<Buffer | null> => {
    const cached = m.frames.get();
    if (cached) return cached;
    try {
      const shot = await m.cdp.call("Page.captureScreenshot", { format: "jpeg", quality: options.quality ?? 60 }) as { data?: string };
      return shot?.data ? Buffer.from(shot.data, "base64") : null;
    } catch { return null; }
  };

  const handler = ((req: http.IncomingMessage, res: http.ServerResponse): void => {
    const url = req.url ?? "/";
    const name = route(url);
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
    if (name === "redirect") {
      const pathname = new URL(url, "http://viewer.invalid").pathname;
      res.writeHead(302, { location: pathname + "/" });
      res.end();
      return;
    }
    if (name === "index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : html);
      return;
    }
    if (name === "frame.jpg") {
      void attach().then(async (m) => {
        const jpeg = await frame(m);
        if (!jpeg) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "the attached page produced no frame" }));
          return;
        }
        res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store", "content-length": String(jpeg.length) });
        res.end(req.method === "HEAD" ? undefined : jpeg);
      }).catch((error: Error) => {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(error?.message ?? error) }));
      });
      return;
    }
    if (name === "status.json") {
      void attach().then(async (m) => {
        const now = await m.activityNow();
        // `activityNow().url` is only known once a navigation has been OBSERVED; a page that
        // was already loaded when the tap opened has none, so read the live one.
        const live = now.url ?? await m.cdp.call("Runtime.evaluate", { expression: "location.href", returnByValue: true })
          .then((out: { result?: { value?: unknown } }) => (typeof out.result?.value === "string" ? out.result.value : undefined))
          .catch(() => undefined);
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ endpoint: base, viewport, interactable, url: live, title: now.title, stats: m.stats() }));
      }).catch((error: Error) => {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(error?.message ?? error) }));
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  }) as ViewerHandler;

  handler.upgrade = (req: http.IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (route(req.url ?? "/") !== "ws") { socket.destroy(); return; }
    void attach().then((m) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        const current = m.frames.get();
        if (current) ws.send(current);
        // Latest-wins: drop a frame for a stalled client instead of growing its send buffer.
        const unsubscribe = m.frames.subscribe((frame) => {
          if (ws.readyState === ws.OPEN && ws.bufferedAmount < 1_000_000) ws.send(frame);
        });
        ws.on("message", (data) => {
          if (!interactable) return;
          try { m.onInput(JSON.parse(data.toString())); } catch { /* a malformed input frame is ignored */ }
        });
        ws.on("close", unsubscribe);
        ws.on("error", unsubscribe);
      });
    }).catch(() => socket.destroy());
  };

  handler.close = async (): Promise<void> => {
    const started = media;
    media = null;
    wss.close();
    if (started) { try { (await started).close(); } catch { /* already gone */ } }
  };

  return handler;
}

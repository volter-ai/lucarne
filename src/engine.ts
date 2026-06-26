import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import type { Backend } from "./backends/types.js";
import { dockerBackend } from "./backends/docker.js";
import { nativeBackend } from "./backends/native.js";
import { portholeHtml } from "./porthole.js";
import { profileExists, realChromeUserDataDir, seedProfile, sessionDirs } from "./profiles.js";
import { startSessionMedia, type SessionMedia } from "./session-media.js";
import type { CreateSessionOptions, EngineOptions, Session } from "./types.js";

interface Tracked extends Session {
  recDir: string;
  media: SessionMedia;
  stop(): Promise<void>;
}

const DEFAULT_CHROME: Record<string, string> = {
  darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  linux: "google-chrome",
  win32: "C:/Program Files/Google/Chrome/Application/chrome.exe",
};

const pub = (s: Session): Session => ({
  id: s.id, backend: s.backend, cdpUrl: s.cdpUrl, viewUrl: s.viewUrl, createdAt: s.createdAt,
});

/**
 * The browser-session engine. Owns isolated sessions; each exposes a `cdpUrl`
 * (drive with Playwright), a `viewUrl` (watch + control over a WebSocket porthole),
 * and recording. View/drive/record are shared CDP code for every backend — the
 * backend only decides isolation. Embed it or run its HTTP API (`listen()`).
 */
export class Lucarne {
  readonly host: string;
  readonly port: number;
  private readonly token: string | undefined;
  private readonly image: string;
  private readonly chromePath: string;
  private readonly viewport: { width: number; height: number };
  private readonly record: boolean;
  private readonly fps: number;
  private readonly retentionMin: number;
  private nextCdp: number;
  private readonly sessions = new Map<string, Tracked>();
  private readonly backends: Record<string, Backend> = { docker: dockerBackend, native: nativeBackend };
  private readonly wss = new WebSocketServer({ noServer: true });
  private server: http.Server | undefined;

  constructor(opts: EngineOptions = {}) {
    this.host = opts.host ?? "127.0.0.1";
    this.port = opts.port ?? 7800;
    this.token = opts.token ?? process.env.LUCARNE_TOKEN ?? undefined;
    this.image = opts.image ?? "lucarne-browser:latest";
    this.chromePath = opts.chromePath ?? DEFAULT_CHROME[process.platform] ?? "google-chrome";
    this.viewport = opts.viewport ?? { width: 1280, height: 720 };
    this.record = opts.record ?? process.env.LUCARNE_RECORD !== "0";
    this.fps = opts.fps ?? 4;
    this.retentionMin = opts.retentionMin ?? 60;
    this.nextCdp = opts.cdpPortBase ?? 9300;
  }

  async create(opts: CreateSessionOptions = {}): Promise<Session> {
    const id = (opts.profile ?? "s" + Date.now().toString(36)).replace(/[^a-z0-9_-]/gi, "");
    const existing = this.sessions.get(id);
    if (existing) return pub(existing);
    const backend = this.backends[opts.backend ?? "docker"];
    if (!backend) throw new Error(`lucarne: unknown backend '${opts.backend}'`);
    const persist = opts.persist ?? !!opts.profile;
    const dirs = sessionDirs(id, persist);
    // Seed an authenticated starting point — only on a profile's FIRST creation,
    // never overwriting an established profile.
    if (persist && !profileExists(dirs.profileDir)) {
      const source = opts.seedFromChrome ? realChromeUserDataDir() : opts.seedFrom;
      if (source) seedProfile(source, dirs.profileDir);
    }
    const cdp = this.nextCdp++;
    const cdpUrl = `http://${this.host}:${cdp}`;
    const handle = await backend.start(id, { cdp }, {
      host: this.host, image: this.image, chromePath: this.chromePath, viewport: this.viewport,
      profileDir: dirs.profileDir, recDir: dirs.recDir, persist,
    });
    const media = await startSessionMedia({
      cdpUrl, recDir: dirs.recDir, viewport: this.viewport,
      record: this.record, fps: this.fps, retentionMin: this.retentionMin,
    });
    const qs = this.token ? `?token=${encodeURIComponent(this.token)}` : "";
    const s: Tracked = {
      id, backend: backend.kind, cdpUrl,
      viewUrl: `http://${this.host}:${this.port}/sessions/${id}/view/${qs}`,
      createdAt: new Date().toISOString(),
      recDir: dirs.recDir, media, stop: handle.stop,
    };
    this.sessions.set(id, s);
    return pub(s);
  }

  list(): Session[] { return [...this.sessions.values()].map(pub); }
  get(id: string): Session | undefined { const s = this.sessions.get(id); return s ? pub(s) : undefined; }

  recordings(id: string): string[] {
    const s = this.sessions.get(id);
    if (!s) return [];
    try { return fs.readdirSync(s.recDir).filter((f) => f.startsWith("seg_") && f.endsWith(".mp4")).sort(); }
    catch { return []; }
  }

  async destroy(id: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) return false;
    try { s.media.close(); } catch { /* ignore */ }
    await s.stop().catch(() => {});
    this.sessions.delete(id);
    return true;
  }

  private tokenOk(url: string, headerAuth?: string): boolean {
    if (!this.token) return true;
    if (new URL(url, "http://x").searchParams.get("token") === this.token) return true;
    return headerAuth === `Bearer ${this.token}`;
  }

  listen(): Promise<void> {
    const send = (res: http.ServerResponse, code: number, body: unknown): void => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body, null, 2));
    };
    this.server = http.createServer(async (req, res) => {
      try {
        if (!this.tokenOk(req.url ?? "/", req.headers.authorization)) return send(res, 401, { error: "unauthorized" });
        const pathname = new URL(req.url ?? "/", "http://x").pathname;
        const viewM = pathname.match(/^\/sessions\/([^/]+)\/view(?:\/(.*))?$/);
        if (viewM) {
          const [, id, sub] = viewM;
          if (!this.sessions.has(id!)) return send(res, 404, { error: "no such session" });
          if (sub === undefined) { const qs = this.token ? `?token=${encodeURIComponent(this.token)}` : ""; res.writeHead(302, { location: `/sessions/${id}/view/${qs}` }); res.end(); return; }
          if (sub === "" || sub === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end(portholeHtml(this.viewport)); return; }
          // /ws is handled by the upgrade listener; any other subpath is 404
          res.writeHead(404); res.end(); return;
        }
        const rec = pathname.match(/^\/sessions\/([^/]+)\/recordings\/?(.*)$/);
        if (rec) {
          const [, id, file] = rec;
          if (req.method === "GET" && !file) return send(res, 200, this.recordings(id!));
          if (req.method === "GET" && file) {
            const s = this.sessions.get(id!);
            const fp = s && path.join(s.recDir, path.basename(file));
            if (!fp || !fs.existsSync(fp)) return send(res, 404, { error: "no such recording" });
            res.writeHead(200, { "content-type": "video/mp4" });
            fs.createReadStream(fp).pipe(res);
            return;
          }
          return send(res, 405, { error: "method not allowed" });
        }
        const m = pathname.match(/^\/sessions\/?(.*)$/);
        if (!m) return send(res, 404, { error: "not found" });
        const id = m[1];
        if (req.method === "POST" && !id) {
          let body = ""; for await (const c of req) body += c;
          return send(res, 200, await this.create(body ? (JSON.parse(body) as CreateSessionOptions) : {}));
        }
        if (req.method === "GET" && !id) return send(res, 200, this.list());
        if (req.method === "GET" && id) { const s = this.get(id); return s ? send(res, 200, s) : send(res, 404, { error: "no such session" }); }
        if (req.method === "DELETE" && id) return send(res, 200, { ok: await this.destroy(id) });
        return send(res, 405, { error: "method not allowed" });
      } catch (e) { return send(res, 500, { error: String((e as Error).message ?? e) }); }
    });

    // the porthole WebSocket: /sessions/:id/view/ws  (frames out, input in)
    this.server.on("upgrade", (req, socket, head) => {
      const url = req.url ?? "/";
      const wm = new URL(url, "http://x").pathname.match(/^\/sessions\/([^/]+)\/view\/ws$/);
      if (!wm || !this.tokenOk(url, req.headers.authorization)) { socket.destroy(); return; }
      const s = this.sessions.get(wm[1]!);
      if (!s) { socket.destroy(); return; }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        const cur = s.media.frames.get();
        if (cur) ws.send(cur);
        const unsub = s.media.frames.subscribe((f) => { if (ws.readyState === ws.OPEN) ws.send(f); });
        ws.on("message", (d) => { try { s.media.onInput(JSON.parse(d.toString())); } catch { /* ignore */ } });
        ws.on("close", unsub);
        ws.on("error", unsub);
      });
    });

    return new Promise((resolve) => this.server!.listen(this.port, this.host, () => resolve()));
  }

  async close(): Promise<void> {
    this.server?.close();
    await Promise.all([...this.sessions.keys()].map((id) => this.destroy(id)));
  }
}

export function createEngine(opts?: EngineOptions): Lucarne {
  return new Lucarne(opts);
}

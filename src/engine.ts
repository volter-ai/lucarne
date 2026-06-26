import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { Backend } from "./backends/types.js";
import { dockerBackend } from "./backends/docker.js";
import { nativeBackend } from "./backends/native.js";
import type { CreateSessionOptions, EngineOptions, Session } from "./types.js";

interface Tracked extends Session {
  recDir: string;
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
 * (drive with Playwright), a `viewUrl` (watch + control), and recording.
 * Embed it (`new Lucarne().create(...)`) or run its HTTP API (`listen()`).
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
  private nextView: number;
  private readonly sessions = new Map<string, Tracked>();
  private readonly backends: Record<string, Backend> = { docker: dockerBackend, native: nativeBackend };
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
    this.nextView = opts.viewPortBase ?? 8100;
  }

  async create(opts: CreateSessionOptions = {}): Promise<Session> {
    const id = (opts.profile ?? "s" + Date.now().toString(36)).replace(/[^a-z0-9_-]/gi, "");
    const existing = this.sessions.get(id);
    if (existing) return pub(existing);
    const backend = this.backends[opts.backend ?? "docker"];
    if (!backend) throw new Error(`lucarne: unknown backend '${opts.backend}'`);
    const ports = { cdp: this.nextCdp++, view: this.nextView++ };
    const handle = await backend.start(id, ports, {
      host: this.host, image: this.image, chromePath: this.chromePath, viewport: this.viewport,
      token: this.token, record: this.record, fps: this.fps, retentionMin: this.retentionMin,
    });
    const s: Tracked = {
      id, backend: backend.kind,
      cdpUrl: `http://${this.host}:${ports.cdp}`,
      viewUrl: handle.viewUrl,
      createdAt: new Date().toISOString(),
      recDir: handle.recDir,
      stop: handle.stop,
    };
    this.sessions.set(id, s);
    return pub(s);
  }

  list(): Session[] { return [...this.sessions.values()].map(pub); }
  get(id: string): Session | undefined { const s = this.sessions.get(id); return s ? pub(s) : undefined; }

  /** Recording segment filenames for a session, oldest first. */
  recordings(id: string): string[] {
    const s = this.sessions.get(id);
    if (!s) return [];
    try {
      return fs.readdirSync(s.recDir).filter((f) => f.startsWith("seg_") && f.endsWith(".mp4")).sort();
    } catch { return []; }
  }

  async destroy(id: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) return false;
    await s.stop().catch(() => {});
    this.sessions.delete(id);
    return true;
  }

  private authed(req: http.IncomingMessage): boolean {
    if (!this.token) return true;
    const u = new URL(req.url ?? "/", "http://x");
    if (u.searchParams.get("token") === this.token) return true;
    return req.headers["authorization"] === `Bearer ${this.token}`;
  }

  /** Start the HTTP control API: /sessions CRUD + /sessions/:id/recordings. */
  listen(): Promise<void> {
    const send = (res: http.ServerResponse, code: number, body: unknown): void => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body, null, 2));
    };
    this.server = http.createServer(async (req, res) => {
      try {
        if (!this.authed(req)) return send(res, 401, { error: "unauthorized" });
        const pathname = new URL(req.url ?? "/", "http://x").pathname;
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
          let body = "";
          for await (const c of req) body += c;
          const o = body ? (JSON.parse(body) as CreateSessionOptions) : {};
          return send(res, 200, await this.create(o));
        }
        if (req.method === "GET" && !id) return send(res, 200, this.list());
        if (req.method === "GET" && id) {
          const s = this.get(id);
          return s ? send(res, 200, s) : send(res, 404, { error: "no such session" });
        }
        if (req.method === "DELETE" && id) return send(res, 200, { ok: await this.destroy(id) });
        return send(res, 405, { error: "method not allowed" });
      } catch (e) {
        return send(res, 500, { error: String((e as Error).message ?? e) });
      }
    });
    return new Promise((resolve) => this.server!.listen(this.port, this.host, () => resolve()));
  }

  /** Stop the HTTP API and tear down every session. */
  async close(): Promise<void> {
    this.server?.close();
    await Promise.all([...this.sessions.keys()].map((id) => this.destroy(id)));
  }
}

export function createEngine(opts?: EngineOptions): Lucarne {
  return new Lucarne(opts);
}

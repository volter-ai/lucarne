import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import type { Backend } from "./backends/types.js";
import { dockerBackend } from "./backends/docker.js";
import { nativeBackend } from "./backends/native.js";
import { attachBrowser } from "./cdp.js";
import { portholeHtml } from "./porthole.js";
import { deleteProfileDir, listProfileNames, profileExists, realChromeUserDataDir, seedProfile, sessionDirs } from "./profiles.js";
import { startSessionMedia, type SessionMedia } from "./session-media.js";
import type { CreateSessionOptions, EngineOptions, Session, SessionStatus } from "./types.js";

interface Tracked extends Session {
  recDir: string;
  downloadDir: string;
  media: SessionMedia;
  createdAtMs: number;
  lastActivityMs: number;
  timeoutMs?: number;
  inactivityMs?: number;
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
  private reaper: ReturnType<typeof setInterval> | undefined;

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
    // The lifecycle reaper runs whether or not the HTTP API is listening (embedded
    // use too); unref'd so it never keeps the process alive on its own.
    this.reaper = setInterval(() => this.reap(), opts.reapIntervalMs ?? 500);
    this.reaper.unref?.();
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
    fs.mkdirSync(dirs.downloadDir, { recursive: true });
    const cdp = this.nextCdp++;
    const cdpUrl = `http://${this.host}:${cdp}`;
    const handle = await backend.start(id, { cdp }, {
      host: this.host, image: this.image, chromePath: this.chromePath, viewport: this.viewport,
      profileDir: dirs.profileDir, recDir: dirs.recDir, persist, extensions: opts.extensions,
    });
    const media = await startSessionMedia({
      cdpUrl, recDir: dirs.recDir, downloadDir: dirs.downloadDir, viewport: this.viewport,
      record: this.record, fps: this.fps, retentionMin: this.retentionMin,
    });
    // Load any custom unpacked extensions via CDP (the only path modern Chrome
    // allows); the launch flag was set by the backend.
    if (opts.extensions?.length) {
      const bconn = await attachBrowser(cdpUrl);
      for (const ext of opts.extensions) await bconn.call("Extensions.loadUnpacked", { path: ext }).catch(() => {});
      bconn.close();
    }
    const qs = this.token ? `?token=${encodeURIComponent(this.token)}` : "";
    const s: Tracked = {
      id, backend: backend.kind, cdpUrl,
      viewUrl: `http://${this.host}:${this.port}/sessions/${id}/view/${qs}`,
      createdAt: new Date().toISOString(),
      recDir: dirs.recDir, downloadDir: dirs.downloadDir, media, stop: handle.stop,
      createdAtMs: Date.now(), lastActivityMs: Date.now(),
      timeoutMs: opts.timeoutMs, inactivityMs: opts.inactivityMs,
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

  /**
   * Inject a host file into the session's `<input type=file>` (the human can't
   * use the native picker — CDP screencast doesn't show it — so this is the path).
   * `selector` defaults to the first file input.
   */
  async uploadFile(id: string, hostPath: string, selector = "input[type=file]"): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) throw new Error("no such session");
    if (!fs.existsSync(hostPath)) throw new Error(`no such file: ${hostPath}`);
    const cdp = s.media.cdp;
    await cdp.call("DOM.enable");
    const { root } = await cdp.call("DOM.getDocument", { depth: 0 });
    const { nodeId } = await cdp.call("DOM.querySelector", { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`no element matching '${selector}'`);
    await cdp.call("DOM.setFileInputFiles", { files: [hostPath], nodeId });
  }

  /** Files the session has downloaded (newest last), retrievable via the API. */
  downloads(id: string): string[] {
    const s = this.sessions.get(id);
    if (!s) return [];
    try {
      return fs.readdirSync(s.downloadDir)
        .filter((f) => !f.endsWith(".crdownload") && !f.startsWith("."))
        .sort((a, b) => fs.statSync(path.join(s.downloadDir, a)).mtimeMs - fs.statSync(path.join(s.downloadDir, b)).mtimeMs);
    } catch { return []; }
  }

  /** Absolute path of a named download (validated against traversal), or null. */
  downloadPath(id: string, file: string): string | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    const fp = path.join(s.downloadDir, path.basename(file));
    return fs.existsSync(fp) ? fp : null;
  }

  /** PNG screenshot of the session's current page (CDP `Page.captureScreenshot`). */
  async screenshot(id: string): Promise<Buffer> {
    const s = this.sessions.get(id);
    if (!s) throw new Error("no such session");
    const r = await s.media.cdp.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    return Buffer.from(r.data, "base64");
  }

  /** PDF render of the session's current page (CDP `Page.printToPDF`). */
  async pdf(id: string): Promise<Buffer> {
    const s = this.sessions.get(id);
    if (!s) throw new Error("no such session");
    const r = await s.media.cdp.call("Page.printToPDF", { printBackground: true });
    return Buffer.from(r.data, "base64");
  }

  /** List a session's open tabs (id, url, title) + which is active in the porthole. */
  async tabs(id: string): Promise<{ active: string | undefined; tabs: { id: string; url: string; title: string }[] }> {
    const s = this.sessions.get(id);
    if (!s) throw new Error("no such session");
    const tabs = (await s.media.tabs()).map((t) => ({ id: t.id, url: t.url, title: t.title }));
    return { active: s.media.activeTabId(), tabs };
  }

  /** Point the porthole (screencast + input) at a different tab. */
  async switchTab(id: string, targetId: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) throw new Error("no such session");
    await s.media.switchTab(targetId);
  }

  /** Durable profiles on disk, each flagged if a live session is using it. */
  profiles(): { name: string; active: boolean }[] {
    return listProfileNames().map((name) => ({ name, active: this.sessions.has(name) }));
  }

  /** Delete a durable profile (refused while a live session is using it). */
  deleteProfile(name: string): { ok: boolean; reason?: string } {
    if (this.sessions.has(name)) return { ok: false, reason: "session live" };
    return { ok: deleteProfileDir(name) };
  }

  /** Liveness + session count, for monitoring. */
  health(): { ok: boolean; sessions: number; ids: string[] } {
    return { ok: true, sessions: this.sessions.size, ids: [...this.sessions.keys()] };
  }

  /** Mark a session active (resets its inactivity clock). */
  touch(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.lastActivityMs = Date.now();
    return true;
  }

  /** Rich status: uptime, idle time, dims, configured lifecycle limits. */
  status(id: string): SessionStatus | undefined {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    const now = Date.now();
    return {
      ...pub(s),
      uptimeMs: now - s.createdAtMs,
      idleMs: now - s.lastActivityMs,
      viewport: this.viewport,
      ...(s.timeoutMs !== undefined ? { timeoutMs: s.timeoutMs } : {}),
      ...(s.inactivityMs !== undefined ? { inactivityMs: s.inactivityMs } : {}),
    };
  }

  /** Destroy any session that hit its max-duration or inactivity limit. */
  private reap(): void {
    const now = Date.now();
    for (const s of [...this.sessions.values()]) {
      const overDuration = s.timeoutMs !== undefined && now - s.createdAtMs >= s.timeoutMs;
      const overIdle = s.inactivityMs !== undefined && now - s.lastActivityMs >= s.inactivityMs;
      if (overDuration || overIdle) void this.destroy(s.id);
    }
  }

  async destroy(id: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) return false;
    try { s.media.close(); } catch { /* ignore */ }
    await s.stop().catch(() => {});
    try { fs.rmSync(s.downloadDir, { recursive: true, force: true }); } catch { /* ignore */ }
    this.sessions.delete(id);
    return true;
  }

  /** Destroy every live session; returns how many were released. */
  async releaseAll(): Promise<number> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.destroy(id)));
    return ids.length;
  }

  /**
   * Dump the session's auth/state context — cookies (all) plus the current page
   * origin's localStorage — for restoring into another session WITHOUT a restart.
   * (Profiles persist on disk; this is the live, cross-session transfer path.)
   */
  async exportContext(id: string): Promise<{ cookies: unknown[]; localStorage: Record<string, string>; origin: string }> {
    const s = this.sessions.get(id);
    if (!s) throw new Error("no such session");
    const { cookies } = await s.media.cdp.call("Network.getAllCookies");
    const r = await s.media.cdp.call("Runtime.evaluate", {
      expression: "JSON.stringify({o:location.origin,ls:Object.assign({},localStorage)})",
      returnByValue: true,
    });
    const { o, ls } = JSON.parse(r.result.value as string);
    return { cookies, localStorage: ls, origin: o };
  }

  /** Restore a context (from `exportContext`): set cookies + the current origin's localStorage. */
  async importContext(id: string, ctx: { cookies?: unknown[]; localStorage?: Record<string, string> }): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) throw new Error("no such session");
    if (ctx.cookies?.length) await s.media.cdp.call("Network.setCookies", { cookies: ctx.cookies });
    if (ctx.localStorage) {
      await s.media.cdp.call("Runtime.evaluate", {
        expression: `(()=>{const d=${JSON.stringify(ctx.localStorage)};for(const k in d)localStorage.setItem(k,d[k]);return true})()`,
      });
    }
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
        const pathname = new URL(req.url ?? "/", "http://x").pathname;
        if (pathname === "/health") {
          const h = this.health();
          // ids only to an authed caller; bare liveness needs no token (monitoring)
          return send(res, 200, this.tokenOk(req.url ?? "/", req.headers.authorization) ? h : { ok: h.ok, sessions: h.sessions });
        }
        if (!this.tokenOk(req.url ?? "/", req.headers.authorization)) return send(res, 401, { error: "unauthorized" });
        const prof = pathname.match(/^\/profiles\/?(.*)$/);
        if (prof) {
          const name = prof[1];
          if (req.method === "GET" && !name) return send(res, 200, this.profiles());
          if (req.method === "DELETE" && name) return send(res, 200, this.deleteProfile(decodeURIComponent(name)));
          return send(res, 405, { error: "method not allowed" });
        }
        const viewM = pathname.match(/^\/sessions\/([^/]+)\/view(?:\/(.*))?$/);
        if (viewM) {
          const [, id, sub] = viewM;
          if (!this.sessions.has(id!)) return send(res, 404, { error: "no such session" });
          if (sub === undefined) { const qs = this.token ? `?token=${encodeURIComponent(this.token)}` : ""; res.writeHead(302, { location: `/sessions/${id}/view/${qs}` }); res.end(); return; }
          if (sub === "" || sub === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end(portholeHtml(this.viewport)); return; }
          // /ws is handled by the upgrade listener; any other subpath is 404
          res.writeHead(404); res.end(); return;
        }
        const shot = pathname.match(/^\/sessions\/([^/]+)\/(screenshot|pdf)$/);
        if (shot) {
          const [, id, kind] = shot;
          if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
          if (!this.sessions.has(id!)) return send(res, 404, { error: "no such session" });
          const buf = kind === "pdf" ? await this.pdf(id!) : await this.screenshot(id!);
          res.writeHead(200, { "content-type": kind === "pdf" ? "application/pdf" : "image/png" });
          res.end(buf);
          return;
        }
        const tab = pathname.match(/^\/sessions\/([^/]+)\/tabs\/?(.*)$/);
        if (tab) {
          const [, id, target] = tab;
          if (!this.sessions.has(id!)) return send(res, 404, { error: "no such session" });
          if (req.method === "GET" && !target) return send(res, 200, await this.tabs(id!));
          if (req.method === "POST" && target) { await this.switchTab(id!, target); return send(res, 200, { ok: true }); }
          return send(res, 405, { error: "method not allowed" });
        }
        const st = pathname.match(/^\/sessions\/([^/]+)\/(status|touch)$/);
        if (st) {
          const [, id, kind] = st;
          if (kind === "status") { const s = this.status(id!); return s ? send(res, 200, s) : send(res, 404, { error: "no such session" }); }
          if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
          return send(res, 200, { ok: this.touch(id!) });
        }
        const ctx = pathname.match(/^\/sessions\/([^/]+)\/context$/);
        if (ctx) {
          const [, id] = ctx;
          if (!this.sessions.has(id!)) return send(res, 404, { error: "no such session" });
          if (req.method === "GET") return send(res, 200, await this.exportContext(id!));
          if (req.method === "POST") {
            let body = ""; for await (const c of req) body += c;
            await this.importContext(id!, body ? JSON.parse(body) : {});
            return send(res, 200, { ok: true });
          }
          return send(res, 405, { error: "method not allowed" });
        }
        const up = pathname.match(/^\/sessions\/([^/]+)\/upload$/);
        if (up) {
          const [, id] = up;
          if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
          let body = ""; for await (const c of req) body += c;
          const { path: hostPath, selector } = body ? (JSON.parse(body) as { path: string; selector?: string }) : { path: "" };
          await this.uploadFile(id!, hostPath, selector);
          return send(res, 200, { ok: true });
        }
        const dl = pathname.match(/^\/sessions\/([^/]+)\/downloads\/?(.*)$/);
        if (dl) {
          const [, id, file] = dl;
          if (req.method === "GET" && !file) return send(res, 200, this.downloads(id!));
          if (req.method === "GET" && file) {
            const fp = this.downloadPath(id!, file);
            if (!fp) return send(res, 404, { error: "no such download" });
            res.writeHead(200, { "content-type": "application/octet-stream" });
            fs.createReadStream(fp).pipe(res);
            return;
          }
          if (req.method === "DELETE" && file) {
            const fp = this.downloadPath(id!, file);
            if (fp) fs.rmSync(fp, { force: true });
            return send(res, 200, { ok: !!fp });
          }
          return send(res, 405, { error: "method not allowed" });
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
        if (req.method === "DELETE" && !id) return send(res, 200, { released: await this.releaseAll() });
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
      // View-only is enforced server-side (?interactable=0): input is dropped, not
      // merely hidden — a read-only viewer genuinely cannot drive the browser.
      const interactable = new URL(url, "http://x").searchParams.get("interactable") !== "0";
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        const cur = s.media.frames.get();
        if (cur) ws.send(cur);
        const unsub = s.media.frames.subscribe((f) => { if (ws.readyState === ws.OPEN) ws.send(f); });
        ws.on("message", (d) => { if (!interactable) return; s.lastActivityMs = Date.now(); try { s.media.onInput(JSON.parse(d.toString())); } catch { /* ignore */ } });
        ws.on("close", unsub);
        ws.on("error", unsub);
      });
    });

    return new Promise((resolve) => this.server!.listen(this.port, this.host, () => resolve()));
  }

  async close(): Promise<void> {
    if (this.reaper) clearInterval(this.reaper);
    this.server?.close();
    await Promise.all([...this.sessions.keys()].map((id) => this.destroy(id)));
  }
}

export function createEngine(opts?: EngineOptions): Lucarne {
  return new Lucarne(opts);
}

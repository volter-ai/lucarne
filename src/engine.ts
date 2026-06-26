import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import type { Backend } from "./backends/types.js";
import { dockerBackend } from "./backends/docker.js";
import { nativeBackend } from "./backends/native.js";
import { attachBrowser } from "./cdp.js";
import { blurCredential, deleteCredential, getCredential, listCredentials, putCredential, totpCode, type Credential } from "./credentials.js";
import { docsHtml, openApiSpec } from "./openapi.js";
import { portholeHtml } from "./porthole.js";
import { deleteProfileDir, globalFilesDir, listProfileNames, managedExtensionsDir, profileExists, realChromeUserDataDir, registryFilePath, seedProfile, sessionDirs } from "./profiles.js";
import { startSessionMedia, type LogEntry, type SessionMedia } from "./session-media.js";
import type { CreateSessionOptions, EngineOptions, Session, SessionStatus } from "./types.js";

interface Tracked extends Session {
  recDir: string;
  downloadDir: string;
  filesDir: string;
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
  ...(s.metadata ? { metadata: s.metadata } : {}),
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
  private readonly segmentSeconds: number;
  private nextCdp: number;
  private readonly sessions = new Map<string, Tracked>();
  private readonly backends: Record<string, Backend> = { docker: dockerBackend, native: nativeBackend };
  private readonly wss = new WebSocketServer({ noServer: true });
  private server: http.Server | undefined;
  private reaper: ReturnType<typeof setInterval> | undefined;
  private readonly registryFile: string;
  private readonly maxConcurrent: number;
  private readonly cors: boolean;
  private slotsUsed = 0;
  private readonly slotWaiters: (() => void)[] = [];

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
    this.segmentSeconds = opts.segmentSeconds ?? 60;
    this.nextCdp = opts.cdpPortBase ?? 9300;
    this.registryFile = opts.registryFile ?? registryFilePath();
    this.maxConcurrent = opts.maxConcurrent ?? Infinity;
    this.cors = opts.cors ?? false;
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
    fs.mkdirSync(dirs.filesDir, { recursive: true });
    const cdp = this.nextCdp++;
    const cdpUrl = `http://${this.host}:${cdp}`;
    await this.acquireSlot();
    let handle, media;
    try {
      handle = await backend.start(id, { cdp }, {
        host: this.host, image: this.image, chromePath: this.chromePath, viewport: this.viewport,
        profileDir: dirs.profileDir, recDir: dirs.recDir, persist, extensions: opts.extensions, proxy: opts.proxy,
      });
      media = await startSessionMedia({
        cdpUrl, recDir: dirs.recDir, downloadDir: dirs.downloadDir, viewport: this.viewport,
        record: this.record, fps: this.fps, retentionMin: this.retentionMin, segmentSeconds: this.segmentSeconds, mobile: opts.mobile, quality: opts.quality, geo: opts.geo,
      });
    } catch (e) {
      this.releaseSlot();
      throw e;
    }
    // Load any custom unpacked extensions via CDP (the only path modern Chrome
    // allows); the launch flag was set by the backend.
    if (opts.extensions?.length) {
      const bconn = await attachBrowser(cdpUrl);
      // a bare name resolves to a managed extension; an absolute path loads as-is
      for (const ext of opts.extensions) {
        const dir = path.isAbsolute(ext) ? ext : path.join(managedExtensionsDir(), ext);
        await bconn.call("Extensions.loadUnpacked", { path: dir }).catch(() => {});
      }
      bconn.close();
    }
    const qs = this.token ? `?token=${encodeURIComponent(this.token)}` : "";
    const s: Tracked = {
      id, backend: backend.kind, cdpUrl,
      viewUrl: `http://${this.host}:${this.port}/sessions/${id}/view/${qs}`,
      createdAt: new Date().toISOString(),
      recDir: dirs.recDir, downloadDir: dirs.downloadDir, filesDir: dirs.filesDir, media, stop: handle.stop,
      createdAtMs: Date.now(), lastActivityMs: Date.now(),
      timeoutMs: opts.timeoutMs, inactivityMs: opts.inactivityMs,
      metadata: opts.metadata,
    };
    this.sessions.set(id, s);
    if (persist) this.persistSpec(id, { ...opts, profile: id, persist: true });
    return pub(s);
  }

  // ── Persisted session registry (survive daemon restart) ──
  private readReg(): Record<string, CreateSessionOptions> {
    try { return JSON.parse(fs.readFileSync(this.registryFile, "utf8")); } catch { return {}; }
  }
  private writeReg(reg: Record<string, CreateSessionOptions>): void {
    try {
      fs.mkdirSync(path.dirname(this.registryFile), { recursive: true });
      fs.writeFileSync(this.registryFile, JSON.stringify(reg, null, 2));
    } catch { /* best-effort durability */ }
  }
  private persistSpec(id: string, spec: CreateSessionOptions): void {
    const reg = this.readReg(); reg[id] = spec; this.writeReg(reg);
  }
  private forgetSpec(id: string): void {
    const reg = this.readReg(); if (id in reg) { delete reg[id]; this.writeReg(reg); }
  }

  /**
   * Re-spawn durable sessions persisted by a previous daemon run. Their profiles
   * are on disk, so state (logins/cookies) is intact. Called by `listen()`.
   */
  async restore(): Promise<string[]> {
    const reg = this.readReg();
    const restored: string[] = [];
    for (const [id, spec] of Object.entries(reg)) {
      if (this.sessions.has(id)) continue;
      try { await this.create(spec); restored.push(id); } catch { /* skip a spec that won't boot */ }
    }
    return restored;
  }

  /** All sessions, optionally filtered to those whose metadata matches every key. */
  list(filter?: Record<string, string>): Session[] {
    let arr = [...this.sessions.values()];
    if (filter && Object.keys(filter).length) {
      arr = arr.filter((s) => Object.entries(filter).every(([k, v]) => s.metadata?.[k] === v));
    }
    return arr.map(pub);
  }
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

  // ── Files workspace (per-session scratch dir or the global durable dir) ──
  /** The directory backing a files scope: a session id, or `null` for global. */
  private filesDirFor(id: string | null): string | null {
    if (id === null) return globalFilesDir();
    const s = this.sessions.get(id);
    return s ? s.filesDir : null;
  }
  putWorkspaceFile(dir: string, name: string, data: Buffer): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, path.basename(name)), data);
  }
  listWorkspaceFiles(dir: string): string[] {
    try { return fs.readdirSync(dir).filter((f) => !f.startsWith(".")).sort(); } catch { return []; }
  }
  workspaceFilePath(dir: string, name: string): string | null {
    const fp = path.join(dir, path.basename(name));
    return fs.existsSync(fp) ? fp : null;
  }

  /** REST handler shared by the session and global files workspaces. */
  private async serveFiles(
    req: http.IncomingMessage, res: http.ServerResponse,
    send: (res: http.ServerResponse, code: number, body: unknown) => void,
    dir: string, name: string,
  ): Promise<void> {
    if (req.method === "GET" && !name) return send(res, 200, this.listWorkspaceFiles(dir));
    if (req.method === "GET" && name) {
      const fp = this.workspaceFilePath(dir, name);
      if (!fp) return send(res, 404, { error: "no such file" });
      res.writeHead(200, { "content-type": "application/octet-stream" });
      fs.createReadStream(fp).pipe(res);
      return;
    }
    if (req.method === "PUT" && name) {
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
      this.putWorkspaceFile(dir, name, Buffer.concat(chunks));
      return send(res, 200, { ok: true });
    }
    if (req.method === "DELETE" && name) {
      const fp = this.workspaceFilePath(dir, name);
      if (fp) fs.rmSync(fp, { force: true });
      return send(res, 200, { ok: !!fp });
    }
    return send(res, 405, { error: "method not allowed" });
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

  /** Captured network/console/browser logs for a session (filter by kind, tail by limit). */
  sessionLogs(id: string, opts: { kind?: string; limit?: number } = {}): LogEntry[] {
    const s = this.sessions.get(id);
    if (!s) return [];
    let l = s.media.logs();
    if (opts.kind) l = l.filter((e) => e.kind === opts.kind);
    if (opts.limit && opts.limit > 0) l = l.slice(-opts.limit);
    return l;
  }

  /** Current TOTP code for a stored credential (or null if it has no TOTP secret). */
  credentialTotp(name: string): string | null {
    const c = getCredential(name);
    return c?.totp ? totpCode(c.totp) : null;
  }

  /**
   * Auto-fill a login form from a stored credential — the secret stays
   * server-side (the caller never sees the password/TOTP). Fills by selector and
   * optionally clicks submit; returns which fields were filled.
   */
  async loginWithCredential(id: string, opts: { credential: string; userSelector?: string; passSelector?: string; totpSelector?: string; submitSelector?: string }): Promise<{ filled: string[] }> {
    const s = this.sessions.get(id);
    if (!s) throw new Error("no such session");
    const cred = getCredential(opts.credential);
    if (!cred) throw new Error("no such credential");
    const cdp = s.media.cdp;
    const filled: string[] = [];
    const fill = async (selector: string, value: string): Promise<boolean> => {
      const r = await cdp.call("Runtime.evaluate", {
        expression: `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;el.focus();el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true})()`,
        returnByValue: true,
      });
      return !!r.result?.value;
    };
    if (opts.userSelector && cred.username && await fill(opts.userSelector, cred.username)) filled.push("username");
    if (opts.passSelector && cred.password && await fill(opts.passSelector, cred.password)) filled.push("password");
    if (opts.totpSelector && cred.totp && await fill(opts.totpSelector, totpCode(cred.totp))) filled.push("totp");
    if (opts.submitSelector) await cdp.call("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(opts.submitSelector)})?.click()` });
    return { filled };
  }

  /** Names of uploaded/managed extensions. */
  listManagedExtensions(): string[] {
    try { return fs.readdirSync(managedExtensionsDir(), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); }
    catch { return []; }
  }
  deleteManagedExtension(name: string): boolean {
    const dir = path.join(managedExtensionsDir(), path.basename(name));
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  /** A self-contained HTML player that streams the session's recording segments. */
  replayHtml(id: string): string {
    const qs = this.token ? `?token=${encodeURIComponent(this.token)}` : "";
    return `<!doctype html><meta charset=utf-8><title>replay ${id}</title>
<style>html,body{margin:0;background:#111}video{width:100vw;height:100vh;object-fit:contain}</style>
<video id=v controls autoplay muted></video><script>
const base='/sessions/${id}/recordings';const qs=${JSON.stringify(qs)};
fetch(base+qs).then(r=>r.json()).then(segs=>{let i=0;const v=document.getElementById('v');
const play=()=>{if(!segs.length)return;v.src=base+'/'+segs[i%segs.length]+qs;v.play().catch(()=>{})};
v.addEventListener('ended',()=>{i++;play()});play();});
</script>`;
  }

  /**
   * Computer-use verb for non-CDP agents: a single high-level action over the
   * porthole input plane (click/move/type/key/scroll) or a screenshot. Same
   * transport the human porthole uses, so an agent and a watcher stay in sync.
   */
  async act(id: string, a: { action: string; x?: number; y?: number; button?: number; text?: string; key?: string; code?: string; mod?: number; dx?: number; dy?: number; clickCount?: number }): Promise<{ ok: true; screenshot?: string }> {
    const s = this.sessions.get(id);
    if (!s) throw new Error("no such session");
    const m = s.media;
    switch (a.action) {
      case "click":
        m.onInput({ t: "down", x: a.x, y: a.y, button: a.button ?? 0, buttons: 1, clickCount: a.clickCount ?? 1 });
        m.onInput({ t: "up", x: a.x, y: a.y, button: a.button ?? 0, buttons: 0, clickCount: a.clickCount ?? 1 });
        break;
      case "move": m.onInput({ t: "move", x: a.x, y: a.y, buttons: 0 }); break;
      case "type": m.onInput({ t: "paste", text: a.text ?? "" }); break;
      case "key": m.onInput({ t: "keydown", key: a.key, code: a.code, mod: a.mod }); m.onInput({ t: "keyup", key: a.key, code: a.code, mod: a.mod }); break;
      case "scroll": m.onInput({ t: "wheel", x: a.x ?? 0, y: a.y ?? 0, dx: a.dx ?? 0, dy: a.dy ?? 0 }); break;
      case "screenshot": return { ok: true, screenshot: (await this.screenshot(id)).toString("base64") };
      default: throw new Error(`unknown action: ${a.action}`);
    }
    return { ok: true };
  }

  /** The active page's rendered HTML (`document.documentElement.outerHTML`). */
  async content(id: string): Promise<string> {
    const s = this.sessions.get(id);
    if (!s) throw new Error("no such session");
    const r = await s.media.cdp.call("Runtime.evaluate", { expression: "document.documentElement.outerHTML", returnByValue: true });
    return String(r.result?.value ?? "");
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
    const { frames, streamedBytes } = s.media.stats();
    return {
      ...pub(s),
      uptimeMs: now - s.createdAtMs,
      idleMs: now - s.lastActivityMs,
      viewport: this.viewport,
      frames, streamedBytes,
      ...(s.timeoutMs !== undefined ? { timeoutMs: s.timeoutMs } : {}),
      ...(s.inactivityMs !== undefined ? { inactivityMs: s.inactivityMs } : {}),
    };
  }

  // ── Concurrency: a slot per live session; creates past the cap queue ──
  private acquireSlot(): Promise<void> {
    if (this.slotsUsed < this.maxConcurrent) { this.slotsUsed++; return Promise.resolve(); }
    return new Promise((resolve) => this.slotWaiters.push(() => { this.slotsUsed++; resolve(); }));
  }
  private releaseSlot(): void {
    this.slotsUsed = Math.max(0, this.slotsUsed - 1);
    const next = this.slotWaiters.shift();
    if (next) next();
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

  /**
   * Tear a session down. `forget` (default true) is an EXPLICIT end — it also
   * drops the persisted spec so a restart won't bring it back. `close()` passes
   * `forget=false` so durable sessions are restored after a daemon restart.
   */
  async destroy(id: string, forget = true): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) return false;
    try { s.media.close(); } catch { /* ignore */ }
    await s.stop().catch(() => {});
    try { fs.rmSync(s.downloadDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(s.filesDir, { recursive: true, force: true }); } catch { /* ignore */ }
    this.sessions.delete(id);
    this.releaseSlot();
    if (forget) this.forgetSpec(id);
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
  async exportContext(id: string): Promise<{ cookies: unknown[]; localStorage: Record<string, string>; sessionStorage: Record<string, string>; origin: string }> {
    const s = this.sessions.get(id);
    if (!s) throw new Error("no such session");
    const { cookies } = await s.media.cdp.call("Network.getAllCookies");
    const r = await s.media.cdp.call("Runtime.evaluate", {
      expression: "JSON.stringify({o:location.origin,ls:Object.assign({},localStorage),ss:Object.assign({},sessionStorage)})",
      returnByValue: true,
    });
    const { o, ls, ss } = JSON.parse(r.result.value as string);
    return { cookies, localStorage: ls, sessionStorage: ss, origin: o };
  }

  /** Restore a context (from `exportContext`): cookies + the origin's local/session storage. */
  async importContext(id: string, ctx: { cookies?: unknown[]; localStorage?: Record<string, string>; sessionStorage?: Record<string, string> }): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) throw new Error("no such session");
    if (ctx.cookies?.length) await s.media.cdp.call("Network.setCookies", { cookies: ctx.cookies });
    const restore = (store: string, data?: Record<string, string>): Promise<unknown> | undefined => data &&
      s.media.cdp.call("Runtime.evaluate", { expression: `(()=>{const d=${JSON.stringify(data)};for(const k in d)${store}.setItem(k,d[k]);return true})()` });
    await restore("localStorage", ctx.localStorage);
    await restore("sessionStorage", ctx.sessionStorage);
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
        if (this.cors) {
          res.setHeader("access-control-allow-origin", "*");
          res.setHeader("access-control-allow-headers", "authorization,content-type");
          res.setHeader("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
          if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
        }
        const pathname = new URL(req.url ?? "/", "http://x").pathname;
        if (pathname === "/openapi.json") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(openApiSpec)); return; }
        if (pathname === "/docs") { res.writeHead(200, { "content-type": "text/html" }); res.end(docsHtml()); return; }
        if (pathname === "/health") {
          const h = this.health();
          // ids only to an authed caller; bare liveness needs no token (monitoring)
          return send(res, 200, this.tokenOk(req.url ?? "/", req.headers.authorization) ? h : { ok: h.ok, sessions: h.sessions });
        }
        if (!this.tokenOk(req.url ?? "/", req.headers.authorization)) return send(res, 401, { error: "unauthorized" });
        const cred = pathname.match(/^\/credentials\/?([^/]*)\/?(totp)?$/);
        if (cred) {
          const name = cred[1] ? decodeURIComponent(cred[1]) : "";
          if (req.method === "GET" && !name) return send(res, 200, listCredentials());
          if (req.method === "GET" && name && cred[2] === "totp") {
            const code = this.credentialTotp(name);
            return code ? send(res, 200, { code }) : send(res, 404, { error: "no totp for credential" });
          }
          if (req.method === "GET" && name) { const b = blurCredential(name); return b ? send(res, 200, b) : send(res, 404, { error: "no such credential" }); }
          if (req.method === "PUT" && name) {
            let body = ""; for await (const c of req) body += c;
            putCredential(name, body ? (JSON.parse(body) as Credential) : {});
            return send(res, 200, { ok: true });
          }
          if (req.method === "DELETE" && name) return send(res, 200, { ok: deleteCredential(name) });
          return send(res, 405, { error: "method not allowed" });
        }
        const gf = pathname.match(/^\/files\/?(.*)$/);
        if (gf) { await this.serveFiles(req, res, send, globalFilesDir(), decodeURIComponent(gf[1]!)); return; }
        const ext = pathname.match(/^\/extensions\/?([^/]*)\/?(.*)$/);
        if (ext) {
          const name = ext[1] ? decodeURIComponent(ext[1]) : "";
          const file = ext[2] ? decodeURIComponent(ext[2]) : "";
          if (req.method === "GET" && !name) return send(res, 200, this.listManagedExtensions());
          if (req.method === "DELETE" && name && !file) return send(res, 200, { ok: this.deleteManagedExtension(name) });
          if (name && file) { await this.serveFiles(req, res, send, path.join(managedExtensionsDir(), path.basename(name)), file); return; }
          return send(res, 405, { error: "method not allowed" });
        }
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
        const rep = pathname.match(/^\/sessions\/([^/]+)\/replay$/);
        if (rep) {
          const [, id] = rep;
          if (!this.sessions.has(id!)) return send(res, 404, { error: "no such session" });
          res.writeHead(200, { "content-type": "text/html" });
          res.end(this.replayHtml(id!));
          return;
        }
        const act = pathname.match(/^\/sessions\/([^/]+)\/act$/);
        if (act) {
          const [, id] = act;
          if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
          if (!this.sessions.has(id!)) return send(res, 404, { error: "no such session" });
          let body = ""; for await (const c of req) body += c;
          return send(res, 200, await this.act(id!, body ? JSON.parse(body) : {}));
        }
        const cont = pathname.match(/^\/sessions\/([^/]+)\/content$/);
        if (cont) {
          const [, id] = cont;
          if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
          if (!this.sessions.has(id!)) return send(res, 404, { error: "no such session" });
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(await this.content(id!));
          return;
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
        const lg = pathname.match(/^\/sessions\/([^/]+)\/logs$/);
        if (lg) {
          const [, id] = lg;
          if (!this.sessions.has(id!)) return send(res, 404, { error: "no such session" });
          const u = new URL(req.url ?? "/", "http://x");
          if (u.searchParams.get("stream") === "1") {
            res.writeHead(200, { "cache-control": "no-cache", "content-type": "text/event-stream" });
            const write = (e: LogEntry): void => { res.write(`data: ${JSON.stringify(e)}\n\n`); };
            for (const e of this.sessions.get(id!)!.media.logs()) write(e); // backlog first
            const unsub = this.sessions.get(id!)!.media.onLog(write);
            req.on("close", unsub);
            return;
          }
          return send(res, 200, this.sessionLogs(id!, {
            kind: u.searchParams.get("kind") ?? undefined,
            limit: u.searchParams.get("limit") ? Number(u.searchParams.get("limit")) : undefined,
          }));
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
        const sf = pathname.match(/^\/sessions\/([^/]+)\/files\/?(.*)$/);
        if (sf) {
          const dir = this.filesDirFor(sf[1]!);
          if (!dir) return send(res, 404, { error: "no such session" });
          await this.serveFiles(req, res, send, dir, decodeURIComponent(sf[2]!));
          return;
        }
        const login = pathname.match(/^\/sessions\/([^/]+)\/login$/);
        if (login) {
          const [, id] = login;
          if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
          if (!this.sessions.has(id!)) return send(res, 404, { error: "no such session" });
          let body = ""; for await (const c of req) body += c;
          return send(res, 200, await this.loginWithCredential(id!, body ? JSON.parse(body) : {}));
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
        if (req.method === "GET" && !id) {
          const u = new URL(req.url ?? "/", "http://x");
          const filter: Record<string, string> = {};
          for (const [k, v] of u.searchParams) if (k.startsWith("meta.")) filter[k.slice(5)] = v;
          return send(res, 200, this.list(filter));
        }
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
    // Daemon stopping — kill the browsers but KEEP durable specs so `restore()`
    // brings them back on the next start. (`destroy(id)` is the explicit end.)
    await Promise.all([...this.sessions.keys()].map((id) => this.destroy(id, false)));
  }
}

export function createEngine(opts?: EngineOptions): Lucarne {
  return new Lucarne(opts);
}

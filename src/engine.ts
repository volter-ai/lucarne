import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import type { Backend, BackendHandle } from "./backends/types.js";
import { dockerBackend } from "./backends/docker.js";
import { nativeBackend } from "./backends/native.js";
import { attachBrowser } from "./cdp.js";
import { FileCredentialStore, totpCode, type CredentialProvider } from "./credentials.js";
import { readBodyCapped, serveWorkspace, type Send } from "./http.js";
import { docsHtml, openApiSpec } from "./openapi.js";
import { portholeHtml } from "./porthole.js";
import { deleteProfileDir, globalFilesDir, listProfileNames, managedExtensionsDir, profileExists, realChromeUserDataDir, registryFilePath, seedProfile, sessionDirs } from "./profiles.js";
import { CredentialsService } from "./services/credentials-service.js";
import { ExtensionsService } from "./services/extensions-service.js";
import { WorkspaceService } from "./services/workspace-service.js";
import { startSessionMedia, type ActivityEvent, type ActivityNow, type LogEntry, type SessionMedia } from "./session-media.js";
import type { ActAction, CreateSessionOptions, EngineOptions, Session, SessionStatus } from "./types.js";

interface Tracked extends Session {
  cdpPort: number;
  recDir: string;
  downloadDir: string;
  filesDir: string;
  media: SessionMedia;
  createdAtMs: number;
  lastActivityMs: number;
  maxLifetimeMs?: number;
  inactivityMs?: number;
  stop(): Promise<void>;
}

// Per-platform candidate paths, first existing one wins (a single hardcoded path
// misses Program Files (x86) / per-user installs on Windows and chromium on Linux).
const CHROME_CANDIDATES: Record<string, string[]> = {
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"],
  linux: ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"],
  win32: [
    `${process.env.PROGRAMFILES ?? "C:/Program Files"}/Google/Chrome/Application/chrome.exe`,
    `${process.env["PROGRAMFILES(X86)"] ?? "C:/Program Files (x86)"}/Google/Chrome/Application/chrome.exe`,
    `${process.env.LOCALAPPDATA ?? ""}/Google/Chrome/Application/chrome.exe`,
  ],
};
function resolveChrome(): string {
  const cands = CHROME_CANDIDATES[process.platform] ?? ["google-chrome"];
  // Absolute candidates are probed; a bare command name (linux) is left for PATH.
  return cands.find((c) => !path.isAbsolute(c) || fs.existsSync(c)) ?? cands[0]!;
}

// CDP is FULL unauthenticated control of the browser — it is ALWAYS bound to
// loopback and never the API bind host (which may be 0.0.0.0). Publish, connect,
// and the returned cdpUrl all use this; do not key CDP off `host`.
const CDP_HOST = "127.0.0.1";

// Cap a single request body so one large upload can't OOM the daemon. Workspace
// files (uploads, extensions) ride this; 128 MB is generous for that purpose.
const MAX_BODY_BYTES = 128 * 1024 * 1024;

/**
 * Is a request's Host/Origin a genuine loopback LITERAL? Used for the tokenless
 * CSRF/DNS-rebinding guard — this validates an ATTACKER-CONTROLLED header, so it
 * must be an exact literal match (NOT `startsWith("127.")`, which `127.x.evil.com`
 * defeats). Case-folded, trailing-dot tolerant, IPv4-127.0.0.0/8 exact.
 */
function isLoopbackHostLiteral(h: string): boolean {
  const x = h.toLowerCase().replace(/\.$/, "");
  return x === "localhost" || x === "::1" || /^127(?:\.\d{1,3}){3}$/.test(x);
}

/** Strip a trailing :port and surrounding brackets from a Host/authority header. */
function hostnameOf(authority: string): string {
  return authority.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
}

/**
 * The tokenless CSRF / DNS-rebinding gate, shared by the HTTP router AND the WS
 * upgrade (a malicious page can open a cross-origin WebSocket — the server must
 * enforce). Returns true if the request should be REFUSED. Fail-closed on a
 * missing Host. When a token is set, the token is the auth and this is skipped.
 */
function rebindForbidden(headers: http.IncomingHttpHeaders): boolean {
  const host = hostnameOf(headers.host ?? "");
  if (!host || !isLoopbackHostLiteral(host)) return true;       // absent/foreign Host → refuse
  const origin = headers.origin;
  if (origin) { try { if (!isLoopbackHostLiteral(new URL(origin).hostname)) return true; } catch { return true; } }
  return false;
}

/**
 * Reject a non-positive / NaN numeric config option AT CONSTRUCTION with a clear
 * message naming the offending option (lucarne's fail-closed ethos), rather than
 * silently using it and only surfacing it later as a broken capture/recording.
 */
function positiveOption(name: string, value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`lucarne: ${name} must be a positive number (got ${value})`);
  }
  return value;
}

/**
 * Reject a numeric option that is NaN/non-finite or outside [min, max] with a clear
 * message naming the field + its constraint (lucarne's fail-closed ethos), rather than
 * forwarding it straight to CDP where Chrome silently clamps/ignores it.
 */
function rangeOption(name: string, value: number, min: number, max: number): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`lucarne: ${name} must be between ${min} and ${max} (got ${value})`);
  }
}

/**
 * Validate per-session `create()` inputs BEFORE any session is spawned — `quality`
 * and `geo` are otherwise passed straight to CDP (Page.startScreencast /
 * Emulation.setGeolocationOverride) unchecked, so an out-of-range/NaN value is
 * silently sent to Chrome instead of failing closed. Omitted values are untouched
 * (defaults still apply downstream).
 */
function validateCreateOptions(opts: CreateSessionOptions): void {
  if (opts.quality !== undefined) rangeOption("quality", opts.quality, 1, 100);
  if (opts.geo !== undefined) {
    rangeOption("geo.latitude", opts.geo.latitude, -90, 90);
    rangeOption("geo.longitude", opts.geo.longitude, -180, 180);
  }
}

/** Constant-time string equality (length-independent) — for token comparison. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  // Hash to a fixed length so timingSafeEqual never throws on length mismatch and
  // length itself isn't a timing oracle.
  const ah = crypto.createHash("sha256").update(ab).digest();
  const bh = crypto.createHash("sha256").update(bb).digest();
  return crypto.timingSafeEqual(ah, bh) && ab.length === bb.length;
}

/** Render an activity event in a format the agent already reads fluently. */
function activityLine(e: ActivityEvent, format: "text" | "playwright"): string {
  if (format === "playwright") {
    const verb =
      e.kind === "nav" ? `await page.goto(${JSON.stringify(e.url ?? "")})`
        : e.kind === "click" ? (e.selector ? `await page.click(${JSON.stringify(e.selector)})${e.text ? `  // "${e.text}"` : ""}` : `await page.mouse.click(${e.x ?? 0}, ${e.y ?? 0})`)
          : e.kind === "type" ? `await page.keyboard.type(${JSON.stringify(e.value ?? "")})`
            : `// ${e.kind} ${e.url ?? e.field ?? ""}`.trimEnd();
    return `# ${e.actor}  ${verb}`;
  }
  const subject = e.url ?? e.selector ?? e.field ?? "";
  const extra = e.value ?? e.text ?? "";
  return `${new Date(e.ts).toISOString()}  ${e.actor}  ${e.kind}  ${subject}${extra ? "  " + extra : ""}`.trimEnd();
}

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
  private readonly headless: boolean;
  private readonly activityDefault: boolean;
  private readonly fps: number;
  private readonly retentionMin: number;
  private readonly segmentSeconds: number;
  private nextCdp: number;
  /** CDP ports reclaimed on destroy — reused before incrementing `nextCdp`, so a
   *  long-lived daemon with create/destroy churn never marches past 65535 (~56k
   *  creates) and starts spawning on invalid ports. */
  private readonly cdpFreeList: number[] = [];
  private readonly sessions = new Map<string, Tracked>();
  /** In-flight `create`s keyed by id, so concurrent same-id creates coalesce. */
  private readonly creating = new Map<string, Promise<Session>>();
  /** In-flight teardowns keyed by id — makes `destroy` idempotent under the reaper AND
   *  lets a same-id `create` wait for teardown to finish (else it spawns onto a profile
   *  dir still being wiped, and the old destroy's rmSync clobbers the new session). */
  private readonly destroying = new Map<string, Promise<void>>();
  private readonly backends: Record<string, Backend> = {};
  private readonly credentials: CredentialProvider;
  private readonly credentialsService: CredentialsService;
  // Global (NOT session-scoped) subsystems, kept out of the engine's core so they
  // stay peelable; the router delegates to each in turn.
  private readonly globalServices: { handle(req: http.IncomingMessage, res: http.ServerResponse, send: Send, pathname: string): Promise<boolean> | boolean }[];
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
    this.chromePath = opts.chromePath ?? process.env.LUCARNE_CHROME ?? resolveChrome();
    this.viewport = opts.viewport ?? { width: 1280, height: 720 };
    positiveOption("viewport.width", this.viewport.width);
    positiveOption("viewport.height", this.viewport.height);
    this.record = opts.record ?? process.env.LUCARNE_RECORD !== "0";
    this.headless = opts.headless ?? process.env.LUCARNE_HEADLESS === "1";
    this.activityDefault = opts.activity ?? process.env.LUCARNE_ACTIVITY === "1";
    this.fps = positiveOption("fps", opts.fps ?? 4);
    this.retentionMin = positiveOption("retentionMin", opts.retentionMin ?? 60);
    this.segmentSeconds = positiveOption("segmentSeconds", opts.segmentSeconds ?? 60);
    this.nextCdp = opts.cdpPortBase ?? 9300;
    this.registryFile = opts.registryFile ?? registryFilePath();
    this.maxConcurrent = opts.maxConcurrent ?? Infinity;
    this.cors = opts.cors ?? false;
    this.credentials = opts.credentials ?? new FileCredentialStore();
    this.credentialsService = new CredentialsService(this.credentials);
    this.globalServices = [this.credentialsService, new WorkspaceService(), new ExtensionsService()];
    // A backend is registered, not hard-coded — add one without editing the engine.
    for (const b of opts.backends ?? [dockerBackend, nativeBackend]) this.registerBackend(b);
    // The lifecycle reaper runs whether or not the HTTP API is listening (embedded
    // use too); unref'd so it never keeps the process alive on its own.
    this.reaper = setInterval(() => this.reap(), opts.reapIntervalMs ?? 500);
    this.reaper.unref?.();
  }

  /** Register an isolation backend (the seam for adding a kind without editing the engine). */
  registerBackend(backend: Backend): this {
    this.backends[backend.kind] = backend;
    return this;
  }

  async create(opts: CreateSessionOptions = {}): Promise<Session> {
    // Fail closed on invalid per-session inputs before spawning anything — an
    // out-of-range/NaN `quality` or `geo` would otherwise reach CDP unchecked.
    validateCreateOptions(opts);
    const id = (opts.profile ?? "s" + Date.now().toString(36)).replace(/[^a-z0-9_-]/gi, "");
    const live = this.sessions.get(id);
    if (live) return pub(live);
    // Coalesce concurrent same-id creates onto ONE in-flight promise — otherwise two
    // racing creates each spawn a browser on the same profile dir and orphan one
    // (leaking its slot + process).
    const pending = this.creating.get(id);
    if (pending) return pending;
    const p = this.spawnSession(id, opts).finally(() => this.creating.delete(id));
    this.creating.set(id, p);
    return p;
  }

  private async spawnSession(id: string, opts: CreateSessionOptions): Promise<Session> {
    // Wait for any in-flight teardown of this id to FINISH first — otherwise we spawn
    // onto a profile dir still being wiped, and the old destroy's rmSync clobbers the
    // new session's freshly-created workspace dirs (a confirmed race).
    const teardown = this.destroying.get(id);
    if (teardown) await teardown.catch(() => {});
    const backend = this.backends[opts.backend ?? "docker"];
    if (!backend) throw new Error(`lucarne: unknown backend '${opts.backend}'`);
    const persist = opts.persist ?? !!opts.profile;
    const dirs = sessionDirs(id, persist);
    // Seed an authenticated starting point — only on a profile's FIRST creation,
    // never overwriting an established profile.
    if (persist && !profileExists(dirs.profileDir)) {
      const source = opts.seedFromChrome ? realChromeUserDataDir() : opts.seedFrom;
      if (source) await seedProfile(source, dirs.profileDir);
    }
    fs.mkdirSync(dirs.downloadDir, { recursive: true });
    fs.mkdirSync(dirs.filesDir, { recursive: true });
    const cdp = this.cdpFreeList.pop() ?? this.nextCdp++;
    const cdpUrl = `http://${CDP_HOST}:${cdp}`;
    await this.acquireSlot();
    let handle: BackendHandle | undefined, media: SessionMedia | undefined;
    try {
      handle = await backend.start(id, { cdp }, {
        host: CDP_HOST, image: this.image, chromePath: this.chromePath, viewport: this.viewport,
        profileDir: dirs.profileDir, recDir: dirs.recDir, persist, extensions: opts.extensions, proxy: opts.proxy,
        headless: opts.headless ?? this.headless,
      });
      media = await startSessionMedia({
        cdpUrl, recDir: dirs.recDir, downloadDir: dirs.downloadDir, viewport: this.viewport,
        record: this.record, fps: this.fps, retentionMin: this.retentionMin, segmentSeconds: this.segmentSeconds, mobile: opts.mobile, quality: opts.quality, geo: opts.geo,
        activity: opts.activity ?? this.activityDefault,
      });
      // Load any custom unpacked extensions via CDP (the only path modern Chrome
      // allows). A bare name is confined to the managed dir (basename — no `..`
      // escape); an absolute path loads as-is (a documented opt-in).
      if (opts.extensions?.length) {
        const bconn = await attachBrowser(cdpUrl);
        for (const ext of opts.extensions) {
          const dir = path.isAbsolute(ext) ? ext : path.join(managedExtensionsDir(), path.basename(ext));
          await bconn.call("Extensions.loadUnpacked", { path: dir }).catch(() => {});
        }
        bconn.close();
      }
    } catch (e) {
      // Roll back EVERYTHING on any failure — otherwise the browser/container, the
      // media (ffmpeg + screencast tick + CDP sockets), and the slot all leak, and
      // (for the slot) eventually deadlock every future create.
      try { media?.close(); } catch { /* ignore */ }
      await handle?.stop().catch(() => {});
      try { fs.rmSync(dirs.downloadDir, { recursive: true, force: true }); } catch { /* ignore */ }
      try { fs.rmSync(dirs.filesDir, { recursive: true, force: true }); } catch { /* ignore */ }
      this.cdpFreeList.push(cdp);
      this.releaseSlot();
      throw e;
    }
    const qs = this.token ? `?token=${encodeURIComponent(this.token)}` : "";
    const s: Tracked = {
      id, backend: backend.kind, cdpUrl, cdpPort: cdp,
      viewUrl: `http://${this.host}:${this.port}/sessions/${id}/view/${qs}`,
      createdAt: new Date().toISOString(),
      recDir: dirs.recDir, downloadDir: dirs.downloadDir, filesDir: dirs.filesDir, media, stop: handle.stop,
      createdAtMs: Date.now(), lastActivityMs: Date.now(),
      maxLifetimeMs: opts.maxLifetimeMs, inactivityMs: opts.inactivityMs,
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
    // Confine uploads to the daemon-managed workspaces (per-session scratch, global
    // /files, or captured downloads) — an unconfined host path would let a caller
    // exfiltrate any file the daemon can read (~/.ssh, the cred key) via a file input.
    // Stage the file with PUT /files first if it isn't already there.
    // realpath BOTH sides so a SYMLINK inside the workspace can't point out (a plain
    // path.resolve only normalizes `..`, it doesn't dereference links).
    if (!fs.existsSync(hostPath)) throw new Error(`no such file: ${hostPath}`);
    const resolved = fs.realpathSync(hostPath);
    const allowed = [s.filesDir, globalFilesDir(), s.downloadDir].map((d) => { try { return fs.realpathSync(d) + path.sep; } catch { return path.resolve(d) + path.sep; } });
    if (!allowed.some((root) => resolved.startsWith(root))) {
      throw new Error("lucarne: upload path must be inside the session files workspace (/files) — stage it there first");
    }
    const cdp = s.media.cdp;
    await cdp.call("DOM.enable");
    const { root } = await cdp.call("DOM.getDocument", { depth: 0 });
    const { nodeId } = await cdp.call("DOM.querySelector", { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`no element matching '${selector}'`);
    await cdp.call("DOM.setFileInputFiles", { files: [resolved], nodeId });
  }

  /** Files the session has downloaded (newest last), retrievable via the API. */
  downloads(id: string): string[] {
    const s = this.sessions.get(id);
    if (!s) return [];
    try {
      // Decorate-once: stat each file a SINGLE time, not inside the comparator (which
      // re-stat'd 2·N·logN times per request — a synchronous loop stall at a few hundred
      // files, the same failure mode that once took down /health).
      return fs.readdirSync(s.downloadDir)
        .filter((f) => !f.endsWith(".crdownload") && !f.startsWith("."))
        .map((f) => ({ f, m: fs.statSync(path.join(s.downloadDir, f)).mtimeMs }))
        .sort((a, b) => a.m - b.m)
        .map((o) => o.f);
    } catch { return []; }
  }

  /** Absolute path of a named download (validated against traversal), or null. */
  downloadPath(id: string, file: string): string | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    const fp = path.join(s.downloadDir, path.basename(file));
    return fs.existsSync(fp) ? fp : null;
  }

  /** The per-session scratch workspace dir for a live session (or null). */
  private sessionFilesDir(id: string): string | null {
    const s = this.sessions.get(id);
    return s ? s.filesDir : null;
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

  /**
   * Auto-fill a login form from a stored credential — the secret stays
   * server-side (the caller never sees the password/TOTP). Fills by selector and
   * optionally clicks submit; returns which fields were filled.
   */
  async loginWithCredential(id: string, opts: { credential: string; userSelector?: string; passSelector?: string; totpSelector?: string; submitSelector?: string }): Promise<{ filled: string[] }> {
    const s = this.sessions.get(id);
    if (!s) throw new Error("no such session");
    const cred = this.credentials.get(opts.credential);
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
  async act(id: string, a: ActAction): Promise<{ ok: true; screenshot?: string }> {
    const s = this.sessions.get(id);
    if (!s) throw new Error("no such session");
    // Agent driving counts as activity — otherwise an `inactivityMs` session being
    // actively driven via `act` (no human porthole input) gets reaped mid-work.
    s.lastActivityMs = Date.now();
    const m = s.media;
    switch (a.action) {
      case "click":
        m.onInput({ t: "down", x: a.x, y: a.y, button: a.button ?? 0, buttons: 1, clickCount: a.clickCount ?? 1 }, "agent");
        m.onInput({ t: "up", x: a.x, y: a.y, button: a.button ?? 0, buttons: 0, clickCount: a.clickCount ?? 1 }, "agent");
        break;
      case "move": m.onInput({ t: "move", x: a.x, y: a.y, buttons: 0 }, "agent"); break;
      case "type": m.onInput({ t: "paste", text: a.text ?? "" }, "agent"); break;
      case "key": m.onInput({ t: "keydown", key: a.key, code: a.code, mod: a.mod }, "agent"); m.onInput({ t: "keyup", key: a.key, code: a.code, mod: a.mod }, "agent"); break;
      case "scroll": m.onInput({ t: "wheel", x: a.x ?? 0, y: a.y ?? 0, dx: a.dx ?? 0, dy: a.dy ?? 0 }, "agent"); break;
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

  /** Recent semantic activity events (what the human/agent did), oldest first. */
  sessionActivity(id: string, limit?: number): ActivityEvent[] {
    const s = this.sessions.get(id);
    if (!s) return [];
    const a = s.media.activity();
    return limit && limit > 0 ? a.slice(-limit) : a;
  }

  /** Where the session is right now + human-action freshness (the "don't fight" signal). */
  async activityNow(id: string): Promise<ActivityNow | undefined> {
    const s = this.sessions.get(id);
    return s ? s.media.activityNow() : undefined;
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

  /** Rich status: uptime, idle time, dims, active page (url/title), configured lifecycle limits. */
  async status(id: string): Promise<SessionStatus | undefined> {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    const now = Date.now();
    const { frames, streamedBytes } = s.media.stats();
    // Where the session actually is: the active tab's url + title. Degrade to ""
    // if the page/CDP is gone so status never crashes on a dead session.
    let url = "", title = "";
    try {
      const activeId = s.media.activeTabId();
      const tabs = (await s.media.tabs()).map((t) => ({ id: t.id, url: t.url, title: t.title }));
      const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
      if (active) { url = active.url; title = active.title; }
    } catch { /* page gone — leave url/title empty */ }
    return {
      ...pub(s),
      uptimeMs: now - s.createdAtMs,
      idleMs: now - s.lastActivityMs,
      url, title,
      viewport: this.viewport,
      frames, streamedBytes,
      ...(s.maxLifetimeMs !== undefined ? { maxLifetimeMs: s.maxLifetimeMs } : {}),
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
      const overDuration = s.maxLifetimeMs !== undefined && now - s.createdAtMs >= s.maxLifetimeMs;
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
    // Idempotent at the SYNCHRONOUS entry: `stop()` can take seconds (Chrome flush /
    // `docker rm -f`), and the 500ms reaper would otherwise re-enter destroy ~12× for
    // the same session and over-release the slot. Remove + flag BEFORE the first await.
    if (this.destroying.has(id)) return false;
    this.sessions.delete(id);
    this.releaseSlot();
    this.cdpFreeList.push(s.cdpPort);   // reclaim the port for reuse
    if (forget) this.forgetSpec(id);
    // Store the teardown promise so a same-id `create` can await it (no clobber race).
    const teardown = (async (): Promise<void> => {
      try { s.media.close(); } catch { /* ignore */ }
      // Bound stop(): a wedged `docker rm -f` (no timeout in the docker backend) would
      // otherwise hang teardown forever → `destroying` never drains → every future same-id
      // create awaits it forever. Cap it so teardown always settles; a truly-wedged
      // container is reclaimed by the next run's `docker rm -f` orphan sweep.
      await Promise.race([
        s.stop().catch(() => {}),
        new Promise<void>((r) => { const t = setTimeout(r, 12_000); t.unref?.(); }),
      ]);
      try { fs.rmSync(s.downloadDir, { recursive: true, force: true }); } catch { /* ignore */ }
      try { fs.rmSync(s.filesDir, { recursive: true, force: true }); } catch { /* ignore */ }
    })().finally(() => this.destroying.delete(id));
    this.destroying.set(id, teardown);
    await teardown;
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
    const q = new URL(url, "http://x").searchParams.get("token");
    if (q !== null && safeEqual(q, this.token)) return true;
    return headerAuth !== undefined && safeEqual(headerAuth, `Bearer ${this.token}`);
  }

  listen(): Promise<void> {
    const send: Send = (res, code, body) => {
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
        // Body-size cap (declared length) — a huge body would OOM the daemon.
        const clen = Number(req.headers["content-length"] ?? 0);
        if (clen > MAX_BODY_BYTES) return send(res, 413, { error: "payload too large" });
        // DNS-rebinding / CSRF guard for the no-token (loopback) mode: a malicious web
        // page can otherwise drive a localhost daemon. With a token the token IS the
        // auth (and the Host is the tunnel domain), so only guard when tokenless.
        if (!this.token && rebindForbidden(req.headers)) return send(res, 403, { error: "forbidden host/origin (set LUCARNE_TOKEN for non-loopback access)" });
        const pathname = new URL(req.url ?? "/", "http://x").pathname;
        if (pathname === "/openapi.json") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(openApiSpec)); return; }
        if (pathname === "/docs") { res.writeHead(200, { "content-type": "text/html" }); res.end(docsHtml()); return; }
        if (pathname === "/health") {
          const h = this.health();
          // ids only to an authed caller; bare liveness needs no token (monitoring)
          return send(res, 200, this.tokenOk(req.url ?? "/", req.headers.authorization) ? h : { ok: h.ok, sessions: h.sessions });
        }
        if (!this.tokenOk(req.url ?? "/", req.headers.authorization)) return send(res, 401, { error: "unauthorized" });
        // Global (non-session) subsystems own their own routes — credentials,
        // the /files workspace, managed /extensions. Each returns true if it answered.
        for (const svc of this.globalServices) { if (await svc.handle(req, res, send, pathname)) return; }
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
          const body = (await readBodyCapped(req)).toString();
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
        const actM = pathname.match(/^\/sessions\/([^/]+)\/activity$/);
        if (actM) {
          const [, id] = actM;
          if (!this.sessions.has(id!)) return send(res, 404, { error: "no such session" });
          const u = new URL(req.url ?? "/", "http://x");
          if (u.searchParams.get("stream") === "1") {
            res.writeHead(200, { "cache-control": "no-cache", "content-type": "text/event-stream" });
            const write = (e: ActivityEvent): void => { res.write(`data: ${JSON.stringify(e)}\n\n`); };
            for (const e of this.sessionActivity(id!)) write(e);
            const unsub = this.sessions.get(id!)!.media.onActivity(write);
            req.on("close", unsub);
            return;
          }
          const limit = u.searchParams.get("limit") ? Number(u.searchParams.get("limit")) : undefined;
          const recent = this.sessionActivity(id!, limit);
          const fmt = u.searchParams.get("format");
          if (fmt === "text" || fmt === "playwright") {
            res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
            res.end(recent.map((e) => activityLine(e, fmt)).join("\n") + (recent.length ? "\n" : ""));
            return;
          }
          return send(res, 200, { now: await this.activityNow(id!), recent });
        }
        const st = pathname.match(/^\/sessions\/([^/]+)\/(status|touch)$/);
        if (st) {
          const [, id, kind] = st;
          if (kind === "status") { const s = await this.status(id!); return s ? send(res, 200, s) : send(res, 404, { error: "no such session" }); }
          if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
          return send(res, 200, { ok: this.touch(id!) });
        }
        const ctx = pathname.match(/^\/sessions\/([^/]+)\/context$/);
        if (ctx) {
          const [, id] = ctx;
          if (!this.sessions.has(id!)) return send(res, 404, { error: "no such session" });
          if (req.method === "GET") return send(res, 200, await this.exportContext(id!));
          if (req.method === "POST") {
            const body = (await readBodyCapped(req)).toString();
            await this.importContext(id!, body ? JSON.parse(body) : {});
            return send(res, 200, { ok: true });
          }
          return send(res, 405, { error: "method not allowed" });
        }
        const sf = pathname.match(/^\/sessions\/([^/]+)\/files\/?(.*)$/);
        if (sf) {
          const dir = this.sessionFilesDir(sf[1]!);
          if (!dir) return send(res, 404, { error: "no such session" });
          await serveWorkspace(req, res, send, dir, decodeURIComponent(sf[2]!));
          return;
        }
        const login = pathname.match(/^\/sessions\/([^/]+)\/login$/);
        if (login) {
          const [, id] = login;
          if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
          if (!this.sessions.has(id!)) return send(res, 404, { error: "no such session" });
          const body = (await readBodyCapped(req)).toString();
          return send(res, 200, await this.loginWithCredential(id!, body ? JSON.parse(body) : {}));
        }
        const up = pathname.match(/^\/sessions\/([^/]+)\/upload$/);
        if (up) {
          const [, id] = up;
          if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
          const body = (await readBodyCapped(req)).toString();
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
          const body = (await readBodyCapped(req)).toString();
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
      } catch (e) {
        if ((e as { code?: string }).code === "LUCARNE_BODY_TOO_LARGE") return send(res, 413, { error: "payload too large" });
        return send(res, 500, { error: String((e as Error).message ?? e) });
      }
    });

    // the porthole WebSocket: /sessions/:id/view/ws  (frames out, input in)
    this.server.on("upgrade", (req, socket, head) => {
      const url = req.url ?? "/";
      // The SAME tokenless CSRF/rebinding gate as the HTTP plane — a browser lets JS
      // open a cross-origin WebSocket (Origin is advisory), so without this a malicious
      // page could drive + watch the porthole tokenless. (CRITICAL if omitted.)
      if (!this.token && rebindForbidden(req.headers)) { socket.destroy(); return; }
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
        // Backpressure: frames are latest-wins, so DROP a frame for a slow/stalled
        // client rather than letting the ws send buffer grow unbounded (a half-open
        // socket would otherwise accrete JPEGs forever).
        const unsub = s.media.frames.subscribe((f) => { if (ws.readyState === ws.OPEN && ws.bufferedAmount < 1_000_000) ws.send(f); });
        ws.on("message", (d) => { if (!interactable) return; s.lastActivityMs = Date.now(); try { s.media.onInput(JSON.parse(d.toString())); } catch { /* ignore */ } });
        ws.on("close", unsub);
        ws.on("error", unsub);
      });
    });

    return new Promise((resolve, reject) => {
      const onError = (e: NodeJS.ErrnoException): void => reject(new Error(
        e.code === "EADDRINUSE"
          ? `lucarne: port ${this.port} is already in use on ${this.host} — stop the other daemon or pass a different --port`
          : `lucarne: server error — ${e.message}`));
      this.server!.once("error", onError);
      this.server!.listen(this.port, this.host, () => { this.server!.removeListener("error", onError); resolve(); });
    });
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

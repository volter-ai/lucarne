import type { BlurredCredential, Credential } from "./credentials.js";
import type { ActAction, ActivityEvent, ActivityNow, CreateSessionOptions, LogEntry, Session, SessionContext, SessionStatus } from "./types.js";

/**
 * Typed Node client for the lucarne HTTP API. Thin wrapper over `fetch` — the
 * daemon is the source of truth; this is convenience sugar (the CDP `cdpUrl` it
 * returns is still driven with vanilla Playwright). Works against any reachable
 * daemon (local or tunneled).
 */
export class LucarneClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;

  constructor(opts: { baseUrl?: string; token?: string } = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://127.0.0.1:7800").replace(/\/$/, "");
    this.token = opts.token;
  }

  private async req(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`lucarne ${method} ${path} -> ${res.status}`);
    const ct = res.headers.get("content-type") ?? "";
    return ct.includes("application/json") ? res.json() : res.text();
  }

  /** Fetch a binary endpoint (screenshot/pdf/recording/download) as bytes. */
  private async reqBytes(method: string, path: string): Promise<Uint8Array> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
    });
    if (!res.ok) throw new Error(`lucarne ${method} ${path} -> ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** PUT a raw (binary or text) body — for the file workspaces, which store bytes. */
  private async putRaw(path: string, data: Uint8Array | string): Promise<{ ok: boolean }> {
    const res = await fetch(this.baseUrl + path, {
      method: "PUT",
      headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
      body: data,
    });
    if (!res.ok) throw new Error(`lucarne PUT ${path} -> ${res.status}`);
    return res.json() as Promise<{ ok: boolean }>;
  }

  health(): Promise<{ ok: boolean; sessions: number; ids?: string[] }> { return this.req("GET", "/health") as Promise<{ ok: boolean; sessions: number; ids?: string[] }>; }
  create(opts: CreateSessionOptions = {}): Promise<Session> { return this.req("POST", "/sessions", opts) as Promise<Session>; }
  list(filter?: Record<string, string>): Promise<Session[]> {
    const q = filter ? "?" + Object.entries(filter).map(([k, v]) => `meta.${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&") : "";
    return this.req("GET", "/sessions" + q) as Promise<Session[]>;
  }
  get(id: string): Promise<Session> { return this.req("GET", `/sessions/${id}`) as Promise<Session>; }
  status(id: string): Promise<SessionStatus> { return this.req("GET", `/sessions/${id}/status`) as Promise<SessionStatus>; }
  destroy(id: string): Promise<{ ok: boolean }> { return this.req("DELETE", `/sessions/${id}`) as Promise<{ ok: boolean }>; }
  releaseAll(): Promise<{ released: number }> { return this.req("DELETE", "/sessions") as Promise<{ released: number }>; }
  tabs(id: string): Promise<{ active?: string; tabs: { id: string; url: string; title: string }[] }> { return this.req("GET", `/sessions/${id}/tabs`) as Promise<{ active?: string; tabs: { id: string; url: string; title: string }[] }>; }
  switchTab(id: string, targetId: string): Promise<{ ok: boolean }> { return this.req("POST", `/sessions/${id}/tabs/${targetId}`) as Promise<{ ok: boolean }>; }
  logs(id: string, opts: { kind?: string; limit?: number } = {}): Promise<LogEntry[]> {
    const q = new URLSearchParams(); if (opts.kind) q.set("kind", opts.kind); if (opts.limit) q.set("limit", String(opts.limit));
    return this.req("GET", `/sessions/${id}/logs${q.toString() ? "?" + q : ""}`) as Promise<LogEntry[]>;
  }
  content(id: string): Promise<string> { return this.req("GET", `/sessions/${id}/content`) as Promise<string>; }
  act(id: string, action: ActAction): Promise<{ ok: true; screenshot?: string }> {
    return this.req("POST", `/sessions/${id}/act`, action) as Promise<{ ok: true; screenshot?: string }>;
  }
  login(id: string, opts: { credential: string; userSelector?: string; passSelector?: string; totpSelector?: string; submitSelector?: string }): Promise<{ filled: string[] }> {
    return this.req("POST", `/sessions/${id}/login`, opts) as Promise<{ filled: string[] }>;
  }
  profiles(): Promise<{ name: string; active: boolean }[]> { return this.req("GET", "/profiles") as Promise<{ name: string; active: boolean }[]>; }
  deleteProfile(name: string): Promise<{ ok: boolean; reason?: string }> { return this.req("DELETE", `/profiles/${encodeURIComponent(name)}`) as Promise<{ ok: boolean; reason?: string }>; }
  upload(id: string, opts: { path: string; selector?: string }): Promise<{ ok: boolean }> { return this.req("POST", `/sessions/${id}/upload`, opts) as Promise<{ ok: boolean }>; }
  touch(id: string): Promise<{ ok: boolean }> { return this.req("POST", `/sessions/${id}/touch`) as Promise<{ ok: boolean }>; }
  activity(id: string, opts: { limit?: number } = {}): Promise<{ now: ActivityNow | undefined; recent: ActivityEvent[] }> {
    const q = opts.limit ? `?limit=${opts.limit}` : "";
    return this.req("GET", `/sessions/${id}/activity${q}`) as Promise<{ now: ActivityNow | undefined; recent: ActivityEvent[] }>;
  }
  exportContext(id: string): Promise<SessionContext> { return this.req("GET", `/sessions/${id}/context`) as Promise<SessionContext>; }
  importContext(id: string, ctx: Partial<SessionContext>): Promise<{ ok: boolean }> { return this.req("POST", `/sessions/${id}/context`, ctx) as Promise<{ ok: boolean }>; }
  recordings(id: string): Promise<string[]> { return this.req("GET", `/sessions/${id}/recordings`) as Promise<string[]>; }
  recording(id: string, file: string): Promise<Uint8Array> { return this.reqBytes("GET", `/sessions/${id}/recordings/${encodeURIComponent(file)}`); }
  downloads(id: string): Promise<string[]> { return this.req("GET", `/sessions/${id}/downloads`) as Promise<string[]>; }
  download(id: string, file: string): Promise<Uint8Array> { return this.reqBytes("GET", `/sessions/${id}/downloads/${encodeURIComponent(file)}`); }
  screenshot(id: string): Promise<Uint8Array> { return this.reqBytes("GET", `/sessions/${id}/screenshot`); }
  pdf(id: string): Promise<Uint8Array> { return this.reqBytes("GET", `/sessions/${id}/pdf`); }

  // ── credentials (encrypted at rest; reads are blurred — never returns secrets) ──
  putCredential(name: string, cred: Credential): Promise<{ ok: boolean }> { return this.req("PUT", `/credentials/${encodeURIComponent(name)}`, cred) as Promise<{ ok: boolean }>; }
  credentials(): Promise<BlurredCredential[]> { return this.req("GET", "/credentials") as Promise<BlurredCredential[]>; }
  credential(name: string): Promise<BlurredCredential> { return this.req("GET", `/credentials/${encodeURIComponent(name)}`) as Promise<BlurredCredential>; }
  deleteCredential(name: string): Promise<{ ok: boolean }> { return this.req("DELETE", `/credentials/${encodeURIComponent(name)}`) as Promise<{ ok: boolean }>; }
  credentialTotp(name: string): Promise<{ code: string }> { return this.req("GET", `/credentials/${encodeURIComponent(name)}/totp`) as Promise<{ code: string }>; }

  // ── managed extensions ──
  extensions(): Promise<string[]> { return this.req("GET", "/extensions") as Promise<string[]>; }
  deleteExtension(name: string): Promise<{ ok: boolean }> { return this.req("DELETE", `/extensions/${encodeURIComponent(name)}`) as Promise<{ ok: boolean }>; }

  // ── durable global files workspace ──
  files(): Promise<string[]> { return this.req("GET", "/files") as Promise<string[]>; }
  file(name: string): Promise<Uint8Array> { return this.reqBytes("GET", `/files/${encodeURIComponent(name)}`); }
  putFile(name: string, data: Uint8Array | string): Promise<{ ok: boolean }> { return this.putRaw(`/files/${encodeURIComponent(name)}`, data); }
  deleteFile(name: string): Promise<{ ok: boolean }> { return this.req("DELETE", `/files/${encodeURIComponent(name)}`) as Promise<{ ok: boolean }>; }

  // ── per-session scratch files workspace ──
  sessionFiles(id: string): Promise<string[]> { return this.req("GET", `/sessions/${id}/files`) as Promise<string[]>; }
  sessionFile(id: string, name: string): Promise<Uint8Array> { return this.reqBytes("GET", `/sessions/${id}/files/${encodeURIComponent(name)}`); }
  putSessionFile(id: string, name: string, data: Uint8Array | string): Promise<{ ok: boolean }> { return this.putRaw(`/sessions/${id}/files/${encodeURIComponent(name)}`, data); }
  deleteSessionFile(id: string, name: string): Promise<{ ok: boolean }> { return this.req("DELETE", `/sessions/${id}/files/${encodeURIComponent(name)}`) as Promise<{ ok: boolean }>; }
}

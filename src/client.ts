import type { CreateSessionOptions, Session, SessionStatus } from "./types.js";

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

  health(): Promise<{ ok: boolean; sessions: number }> { return this.req("GET", "/health") as Promise<{ ok: boolean; sessions: number }>; }
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
  logs(id: string, opts: { kind?: string; limit?: number } = {}): Promise<unknown[]> {
    const q = new URLSearchParams(); if (opts.kind) q.set("kind", opts.kind); if (opts.limit) q.set("limit", String(opts.limit));
    return this.req("GET", `/sessions/${id}/logs${q.toString() ? "?" + q : ""}`) as Promise<unknown[]>;
  }
  content(id: string): Promise<string> { return this.req("GET", `/sessions/${id}/content`) as Promise<string>; }
  act(id: string, action: { action: string; x?: number; y?: number; text?: string; key?: string; dx?: number; dy?: number }): Promise<{ ok: true; screenshot?: string }> {
    return this.req("POST", `/sessions/${id}/act`, action) as Promise<{ ok: true; screenshot?: string }>;
  }
  login(id: string, opts: { credential: string; userSelector?: string; passSelector?: string; totpSelector?: string; submitSelector?: string }): Promise<{ filled: string[] }> {
    return this.req("POST", `/sessions/${id}/login`, opts) as Promise<{ filled: string[] }>;
  }
  profiles(): Promise<{ name: string; active: boolean }[]> { return this.req("GET", "/profiles") as Promise<{ name: string; active: boolean }[]>; }
}

/** Which engine spawns the browser behind a session. */
export type BackendKind = "docker" | "native";

/**
 * A browser session. The three surfaces:
 *  - `cdpUrl`  — drive it: `chromium.connectOverCDP(session.cdpUrl)`
 *  - `viewUrl` — watch + control it: open or `<iframe>` this URL
 *  - recording — ambient (file-based, in the session's data dir)
 */
export interface Session {
  id: string;
  backend: BackendKind;
  cdpUrl: string;
  viewUrl: string;
  createdAt: string;
}

export interface CreateSessionOptions {
  /** Stable id / profile name. Same name === same persisted profile. */
  profile?: string;
  /** "native" (real local Chrome, real fingerprint) or "docker" (isolated container). */
  backend?: BackendKind;
}

export interface EngineOptions {
  /** Bind address for the daemon + per-session portholes. Default "127.0.0.1". */
  host?: string;
  /** Daemon HTTP port. Default 7800. */
  port?: number;
  /**
   * Optional bearer token. When set, the control API and native portholes
   * require it (`Authorization: Bearer <t>` or `?token=<t>`). Set this whenever
   * you bind to a non-loopback host. Default: `LUCARNE_TOKEN` env, else none.
   */
  token?: string;
  /** Docker image for the docker backend. Default "lucarne-browser:latest". */
  image?: string;
  /** Path to the Chrome/Chromium binary for the native backend. */
  chromePath?: string;
  /** Viewport (and capture) size. Default 1280x720. */
  viewport?: { width: number; height: number };
  /** Record sessions to a rolling buffer. Default true (`LUCARNE_RECORD=0` disables). */
  record?: boolean;
  /** Recording frame-rate / segment cadence. Default 4. */
  fps?: number;
  /** Minutes of recording to retain. Default 60. */
  retentionMin?: number;
  /** First CDP port to allocate. Default 9300. */
  cdpPortBase?: number;
  /** First porthole (view) port to allocate. Default 8100. */
  viewPortBase?: number;
}

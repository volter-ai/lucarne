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
  /** User tags supplied at create (for list filtering). */
  metadata?: Record<string, string>;
}

export interface CreateSessionOptions {
  /** Stable id / profile name. Same name === same persisted profile. */
  profile?: string;
  /** "native" (real local Chrome, real fingerprint) or "docker" (isolated container). */
  backend?: BackendKind;
  /**
   * Keep the profile across sessions (cookies, logins, storage). Defaults to
   * true when `profile` is named, false for an anonymous one-off session.
   */
  persist?: boolean;
  /**
   * On FIRST creation of this profile, seed it from an existing Chrome
   * user-data-dir at this path (copies cookies/logins/storage). Ignored once the
   * profile exists. Mutually informs `seedFromChrome`.
   */
  seedFrom?: string;
  /** On first creation, seed from your real local Chrome profile. */
  seedFromChrome?: boolean;
  /** Unpacked extension dirs to load (native backend). Your profile's own extensions load anyway. */
  extensions?: string[];
  /** Emulate a mobile device (viewport, DPR, touch, mobile UA) for the porthole. */
  mobile?: boolean;
  /** Arbitrary user tags stored on the session (filter `list`/`sessions` by them). */
  metadata?: Record<string, string>;
  /** Auto-release this session after this many ms of wall-clock, regardless of use. */
  timeoutMs?: number;
  /**
   * Auto-release after this many ms with no porthole interaction or `touch`.
   * Off by default (a CDP-driven session with no porthole input is not "idle").
   */
  inactivityMs?: number;
}

/** Rich, live view of a session (uptime / idle / dims / stream stats) for status + monitoring. */
export interface SessionStatus extends Session {
  uptimeMs: number;
  idleMs: number;
  viewport: { width: number; height: number };
  /** screencast frames served so far (porthole "pressure" signal). */
  frames: number;
  /** bytes of JPEG frame data served so far. */
  streamedBytes: number;
  timeoutMs?: number;
  inactivityMs?: number;
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
  /** How often the lifecycle reaper checks timeout/inactivity. Default 500ms. */
  reapIntervalMs?: number;
  /**
   * Where durable session specs are persisted so they survive a daemon restart.
   * Default `LUCARNE_HOME/sessions.json`. `listen()` restores them on startup.
   */
  registryFile?: string;
  /** First porthole (view) port to allocate. Default 8100. */
  viewPortBase?: number;
}

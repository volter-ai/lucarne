import type { Backend } from "./backends/types.js";
import type { CredentialProvider } from "./credentials.js";

/** Which engine spawns the browser behind a session. `attach` spawns nothing — it mirrors a foreign browser. */
export type BackendKind = "attach" | "docker" | "native";

/** A single computer-use action (one shared shape across the engine, SDK, and MCP). */
export interface ActAction {
  action: "click" | "move" | "type" | "key" | "scroll" | "screenshot";
  x?: number;
  y?: number;
  button?: number;
  text?: string;
  key?: string;
  code?: string;
  mod?: number;
  dx?: number;
  dy?: number;
  clickCount?: number;
}

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
   * Attach to an EXTERNAL, already-running CDP endpoint (e.g. `http://127.0.0.1:9222`)
   * instead of spawning a browser. The session VIEWS + (via the porthole) drives that
   * foreign browser; destroying the session DETACHES — it never kills the foreign
   * browser. Loopback only (a CDP endpoint is full unauthenticated browser control;
   * a remote one would be an SSRF footgun, and lucarne uses the endpoint's reflected
   * 127.0.0.1 ws verbatim). Implies `backend:"attach"`, `persist:false`, and a
   * view-only media plane (no auto download-behavior / emulation mutation on attach).
   */
  attach?: string;
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
  /** Run this session's Chrome headless (no window, no focus steal). Overrides the engine default. */
  headless?: boolean;
  /** Unpacked extension dirs to load (native backend). Your profile's own extensions load anyway. */
  extensions?: string[];
  /** Emulate a mobile device (viewport, DPR, touch, mobile UA) for the porthole. */
  mobile?: boolean;
  /** Porthole/recording JPEG quality 1–100 (default 60). Lower = smaller frames. */
  quality?: number;
  /** BYO passthrough proxy for this session, e.g. "http://127.0.0.1:8888" (native backend). */
  proxy?: string;
  /** Geolocation override (e.g. when you travel); grants the geolocation permission. */
  geo?: { latitude: number; longitude: number; accuracy?: number };
  /** Capture the semantic activity log (nav/click/type…) so an agent knows what you're doing. */
  activity?: boolean;
  /** Arbitrary user tags stored on the session (filter `list`/`sessions` by them). */
  metadata?: Record<string, string>;
  /** Auto-release this session after this many ms of wall-clock lifetime, regardless of use. */
  maxLifetimeMs?: number;
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
  /** The active tab's current URL ("" when no active page). */
  url: string;
  /** The active tab's document title ("" when unavailable). */
  title: string;
  viewport: { width: number; height: number };
  /** screencast frames served so far (porthole "pressure" signal). */
  frames: number;
  /** bytes of JPEG frame data served so far. */
  streamedBytes: number;
  maxLifetimeMs?: number;
  inactivityMs?: number;
}

/** One semantic activity event (what the human or agent did), as served over HTTP. */
export interface ActivityEvent {
  ts: number;
  actor: "human" | "agent";
  kind: string;
  url?: string;
  selector?: string;
  text?: string;
  field?: string;
  value?: string;
  role?: string;
  x?: number;
  y?: number;
}

/** Where a session is right now + how fresh the human's last action is (the "don't fight" signal). */
export interface ActivityNow {
  url?: string;
  title?: string;
  /** The focused field's name/id/aria (absent when nothing is focused). */
  focusedField?: string;
  /** ms since the human's last porthole action, or null if they never acted. */
  lastHumanActionMsAgo: number | null;
}

/** A captured network / console / browser-log entry. */
export interface LogEntry {
  kind: "network" | "console" | "log";
  ts: number;
  level?: string;
  method?: string;
  url?: string;
  text?: string;
}

/** Exportable auth/state of a session (cookies + the current origin's storage). */
export interface SessionContext {
  cookies: unknown[];
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  origin: string;
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
  /**
   * Default to headless Chrome for the native backend (no window, no focus steal).
   * Default false — the authentic lane is headful; opt in via `LUCARNE_HEADLESS=1`
   * or per session with `create({ headless })`. Use for servers / tests.
   */
  headless?: boolean;
  /** Capture the semantic activity log by default (`LUCARNE_ACTIVITY=1`). Default off. */
  activity?: boolean;
  /** Recording frame-rate / segment cadence. Default 4. */
  fps?: number;
  // NOTE: these two carry their unit in the NAME by design (`Min`/`Seconds`) — a
  // human-scale recording knob reads better as `60` minutes than `3_600_000` ms.
  /** Minutes of recording to retain. Default 60. */
  retentionMin?: number;
  /** Seconds per recording segment. Default 60. */
  segmentSeconds?: number;
  /** First CDP port to allocate. Default 9300. */
  cdpPortBase?: number;
  /** How often the lifecycle reaper checks timeout/inactivity. Default 500ms. */
  reapIntervalMs?: number;
  /** Max concurrent live sessions; further creates queue until a slot frees. Default unlimited. */
  maxConcurrent?: number;
  /** Send permissive CORS headers (for browser clients on another origin). Default false. */
  cors?: boolean;
  /**
   * Where durable session specs are persisted so they survive a daemon restart.
   * Default `LUCARNE_HOME/sessions.json`. `listen()` restores them on startup.
   */
  registryFile?: string;
  /** Override the credential store. Default: the encrypted-file `FileCredentialStore`. */
  credentials?: CredentialProvider;
  /** Isolation backends to register. Default: docker + native. */
  backends?: Backend[];
}

import type { BackendKind } from "../types.js";

export interface BackendContext {
  host: string;
  image: string;
  chromePath: string;
  viewport: { width: number; height: number };
  /** Optional bearer token gating the daemon API + native portholes. */
  token?: string | undefined;
  /** Record sessions (default true). */
  record: boolean;
  /** Recording frame-rate floor / segment cadence. */
  fps: number;
  /** Minutes of recording to retain (ring buffer). */
  retentionMin: number;
}

export interface BackendHandle {
  /** Absolute URL of the porthole (view + control). */
  viewUrl: string;
  /** Directory where this session's recording segments land. */
  recDir: string;
  /** Tear down the browser + its porthole/recorder and reclaim resources. */
  stop(): Promise<void>;
}

/** A way to spawn + serve a single browser session. */
export interface Backend {
  readonly kind: BackendKind;
  start(id: string, ports: { cdp: number; view: number }, ctx: BackendContext): Promise<BackendHandle>;
}

export async function waitForCdp(host: string, port: number, ms = 25_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://${host}:${port}/json/version`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`lucarne: CDP never came up on ${host}:${port}`);
}

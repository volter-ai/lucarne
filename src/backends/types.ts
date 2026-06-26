import type { BackendKind } from "../types.js";

/**
 * A backend is ONLY an isolation strategy: spawn a browser so its CDP is reachable
 * at `http://${ctx.host}:${ports.cdp}`, and tear it down. Everything else — view,
 * drive, record — is shared engine code over CDP, identical for every backend.
 */
export interface BackendContext {
  host: string;
  image: string;
  chromePath: string;
  viewport: { width: number; height: number };
  /** Chrome `--user-data-dir` (engine-owned policy; see `profiles.ts`). */
  profileDir: string;
  /** Directory (on the engine host) where this session's recordings land. */
  recDir: string;
  /** Preserve `profileDir` on stop (durable named profile). */
  persist: boolean;
  /** Unpacked extension dirs to load (native backend honours these). */
  extensions?: string[];
  /** BYO passthrough proxy (native backend `--proxy-server`). */
  proxy?: string;
}

export interface BackendHandle {
  /** Tear down the browser and reclaim resources. */
  stop(): Promise<void>;
}

export interface Backend {
  readonly kind: BackendKind;
  /** Must return only once CDP is reachable at `http://${ctx.host}:${ports.cdp}`. */
  start(id: string, ports: { cdp: number }, ctx: BackendContext): Promise<BackendHandle>;
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

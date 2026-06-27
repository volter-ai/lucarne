import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";

/**
 * Expose a local daemon through a tunnel you already have — `ngrok`/`cloudflared`
 * presets, or any `--tunnel-cmd` (tailscale, `ssh -R`, a relay client, …). lucarne
 * stays vendor-neutral: it SHELLS OUT to a binary you installed (no bundled tunnel,
 * no npm dep), parses the public URL it prints, and hands it back. The daemon must
 * be token-gated before it's reachable off-loopback (see `ensureTunnelToken`).
 */
export type TunnelPreset = "ngrok" | "cloudflared";

export interface TunnelOptions {
  preset?: TunnelPreset;
  /** Generic escape hatch: a shell command that prints a public https URL on stdout/stderr. */
  cmd?: string;
  host: string;
  port: number;
  timeoutMs?: number;
}

export interface TunnelHandle {
  /** The public URL the tunnel exposes (the daemon origin). */
  url: string;
  /** Tear the tunnel process down. */
  stop(): void;
}

/** When tunneling, the daemon MUST require a token — auto-provision one if absent. */
export function ensureTunnelToken(token: string | undefined): { token: string; generated: boolean } {
  if (token) return { token, generated: false };
  return { token: crypto.randomBytes(24).toString("hex"), generated: true };
}

/**
 * Each preset prints its public URL on a recognizable host — match THAT, not just
 * "the first https URL", because real clients also print banner/doc links (cloudflared
 * prints a cloudflare.com terms link; ngrok prints its dashboard + a localhost inspector)
 * that would otherwise be grabbed first.
 */
const PRESET_PATTERN: Record<TunnelPreset, RegExp> = {
  // allow multi-label hosts (regional/reserved ngrok like name.eu.ngrok.io, or a
  // branded *.trycloudflare.com) — the `(?:label\.)+` is still linear (no ReDoS).
  ngrok: /https:\/\/(?:[a-z0-9-]+\.)+ngrok(?:-free)?\.(?:app|dev|io)[^\s"'`]*/i,
  cloudflared: /https:\/\/(?:[a-z0-9-]+\.)*trycloudflare\.com[^\s"'`]*/i,
};

// Obvious non-tunnel URLs a client may print in its banner (only used for the generic
// --tunnel-cmd heuristic, where the command ideally prints just its own URL).
const NOISE_HOST = /(localhost|127\.0\.0\.1|0\.0\.0\.0|cloudflare\.com|developers\.cloudflare|ngrok\.com\b|dashboard\.ngrok|github\.com|cloudflarestatus)/i;

/**
 * Extract the public URL from a tunnel client's output. For a known preset, match its
 * URL host precisely; for a generic command, take the first non-loopback, non-noise
 * `https?://` URL. Pure + testable — no spawning.
 */
export function pickPublicUrl(text: string, preset?: TunnelPreset): string | null {
  const clean = (u: string): string => u.replace(/[).,]+$/, "");
  if (preset) {
    const m = text.match(PRESET_PATTERN[preset]);
    if (m) return clean(m[0]);
    // preset host didn't match (an unusual/custom domain) — fall through to the
    // generic non-noise heuristic rather than timing out on a tunnel that IS up.
  }
  const urls = text.match(/https?:\/\/[^\s"'`]+/g);
  if (!urls) return null;
  return urls.map(clean).find((u) => !NOISE_HOST.test(u)) ?? null;
}

/** Build the spawn spec for a preset or a raw command. */
export function tunnelSpawnSpec(opts: TunnelOptions): { file: string; args: string[]; shell: boolean } {
  if (opts.cmd) return { file: opts.cmd, args: [], shell: true };
  const target = `http://${opts.host}:${opts.port}`;
  if (opts.preset === "ngrok") return { file: "ngrok", args: ["http", `${opts.host}:${opts.port}`, "--log", "stdout"], shell: false };
  if (opts.preset === "cloudflared") return { file: "cloudflared", args: ["tunnel", "--url", target], shell: false };
  throw new Error("lucarne: --tunnel needs a preset (ngrok|cloudflared) or a --tunnel-cmd");
}

/** Spawn the tunnel, wait for its public URL, and keep it alive until `stop()`. */
export function startTunnel(opts: TunnelOptions): Promise<TunnelHandle> {
  const spec = tunnelSpawnSpec(opts);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  // A `--tunnel-cmd` runs under a shell; spawn it DETACHED so it leads its own
  // process group, and tear down the whole group on stop — otherwise SIGTERM to
  // the shell can orphan the real tunnel (a wrapper script that doesn't `exec`),
  // leaving the public ingress open after the daemon stops.
  const child: ChildProcess = spec.shell
    ? spawn(spec.file, { shell: true, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LUCARNE_LOCAL_URL: `http://${opts.host}:${opts.port}`, LUCARNE_PORT: String(opts.port) } })
    : spawn(spec.file, spec.args, { stdio: ["ignore", "pipe", "pipe"] });

  // Kill the child (and its group, for the detached shell case), SIGKILL backstop.
  const teardown = (): void => {
    const pid = child.pid;
    const sig = (s: NodeJS.Signals): void => {
      try { if (spec.shell && pid) process.kill(-pid, s); else child.kill(s); } catch { /* already gone */ }
    };
    sig("SIGTERM");
    const t = setTimeout(() => sig("SIGKILL"), 3000);
    t.unref?.();
    child.once("exit", () => clearTimeout(t));
  };

  return new Promise<TunnelHandle>((resolve, reject) => {
    let buf = "", settled = false;
    const done = (fn: () => void): void => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
    const scan = (chunk: Buffer): void => {
      buf += chunk.toString();
      const url = pickPublicUrl(buf, opts.preset);
      if (url) done(() => resolve({ url, stop: teardown }));
    };
    child.stdout?.on("data", scan);
    child.stderr?.on("data", scan);
    child.on("error", (err: NodeJS.ErrnoException) => done(() => reject(new Error(
      err.code === "ENOENT" ? `lucarne: tunnel binary not found ('${spec.file}') — install it first` : `lucarne: tunnel failed — ${err.message}`))));
    child.on("exit", (code) => done(() => reject(new Error(`lucarne: tunnel exited (${code}) before a public URL appeared`))));
    const timer = setTimeout(() => done(() => { teardown(); reject(new Error("lucarne: tunnel timed out waiting for a public URL")); }), timeoutMs);
  });
}

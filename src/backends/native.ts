import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { attachBrowser } from "../cdp.js";
import type { Backend, BackendContext, BackendHandle } from "./types.js";
import { waitForCdp } from "./types.js";

const exec = promisify(execFile);

/** Resolve once the child has exited, or after `ms` (caller then SIGKILLs). */
function waitExit(child: ChildProcess, ms: number): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    child.once("exit", () => { clearTimeout(t); resolve(); });
  });
}

/**
 * Isolation = a local Chrome process with its own profile, launched off-screen.
 * Real fingerprint + your residential IP. The engine drives view/record over CDP.
 */
export const nativeBackend: Backend = {
  kind: "native",
  async start(id, ports, ctx: BackendContext): Promise<BackendHandle> {
    const { profileDir, recDir, persist } = ctx;
    if (!persist) await exec("rm", ["-rf", profileDir]).catch(() => {}); // anonymous = fresh
    await exec("mkdir", ["-p", profileDir, recDir]);
    // A durable profile carries singleton locks from its last run; clear them so
    // Chrome relaunches into the same data dir instead of refusing/forking a copy.
    await Promise.all(["SingletonLock", "SingletonCookie", "SingletonSocket"].map(
      (l) => exec("rm", ["-f", `${profileDir}/${l}`]).catch(() => {})));
    const chrome: ChildProcess = spawn(ctx.chromePath, [
      `--remote-debugging-port=${ports.cdp}`,
      `--user-data-dir=${profileDir}`,
      "--remote-allow-origins=*",
      "--no-first-run", "--no-default-browser-check",
      "--force-device-scale-factor=1",
      `--window-size=${ctx.viewport.width},${ctx.viewport.height}`,
      // headless = no window at all (no focus steal); headful = off-screen window
      ...(ctx.headless ? ["--headless=new"] : ["--window-position=-4000,-4000"]),
      "--disable-backgrounding-occluded-windows",       // keep rendering while hidden
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      // On Linux without a desktop keyring (headless servers / CI), Chrome can't
      // re-derive its cookie-encryption key across restarts, so persisted cookies
      // don't survive — use the basic store (stable key) there. macOS keeps the
      // OS keychain (so seed-from-real-Chrome decrypts).
      ...(process.platform === "linux" ? ["--password-store=basic"] : []),
      // Modern Chrome blocks --load-extension; extensions load at runtime via CDP
      // Extensions.loadUnpacked, which needs this launch flag.
      ...(ctx.extensions?.length
        ? ["--enable-unsafe-extension-debugging", "--disable-features=DisableLoadExtensionCommandLineSwitch"]
        : []),
      ...(ctx.proxy ? [`--proxy-server=${ctx.proxy}`] : []),
      "about:blank",
    ], { stdio: "ignore" });
    // Fail fast + clearly on a bad/missing binary instead of waiting out the
    // full CDP timeout. The catch keeps a late error (after CDP is up) from
    // becoming an unhandled rejection.
    const launchFailed = new Promise<never>((_, reject) => {
      chrome.once("error", (err: NodeJS.ErrnoException) => reject(new Error(
        err.code === "ENOENT"
          ? `lucarne: Chrome not found at '${ctx.chromePath}' — install Google Chrome or set chromePath (env LUCARNE_CHROME)`
          : `lucarne: failed to launch Chrome — ${err.message}`)));
    });
    launchFailed.catch(() => { /* handled below or moot once CDP is up */ });

    await Promise.race([waitForCdp(ctx.host, ports.cdp), launchFailed]);
    return {
      async stop(): Promise<void> {
        // A durable profile must be FLUSHED to disk (cookies, localStorage). A
        // process SIGTERM doesn't reliably flush on headless Linux, so ask Chrome
        // to close itself over CDP (`Browser.close` — a clean shutdown that
        // flushes the profile), fall back to SIGTERM, then SIGKILL as a backstop.
        if (persist) {
          try {
            const b = await attachBrowser(`http://${ctx.host}:${ports.cdp}`);
            b.send("Browser.close");
            b.close();
          } catch { try { chrome.kill("SIGTERM"); } catch { /* ignore */ } }
          await waitExit(chrome, 6000);
        }
        try { chrome.kill("SIGKILL"); } catch { /* ignore */ }
        await exec("rm", ["-rf", recDir]).catch(() => {});
        if (!persist) await exec("rm", ["-rf", profileDir]).catch(() => {}); // keep durable profiles
      },
    };
  },
};

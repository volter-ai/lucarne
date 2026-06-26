import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { Backend, BackendContext, BackendHandle } from "./types.js";
import { waitForCdp } from "./types.js";

const exec = promisify(execFile);

/**
 * Isolation = a local Chrome process with its own profile, launched off-screen.
 * Real fingerprint + your residential IP. The engine drives view/record over CDP.
 */
export const nativeBackend: Backend = {
  kind: "native",
  async start(id, ports, ctx: BackendContext): Promise<BackendHandle> {
    const dir = `/tmp/lucarne/native-${id}`;
    const recDir = `${dir}/recordings`;
    await exec("rm", ["-rf", dir]).catch(() => {});
    await exec("mkdir", ["-p", recDir]);
    const chrome: ChildProcess = spawn(ctx.chromePath, [
      `--remote-debugging-port=${ports.cdp}`,
      `--user-data-dir=${dir}`,
      "--remote-allow-origins=*",
      "--no-first-run", "--no-default-browser-check",
      "--force-device-scale-factor=1",
      `--window-size=${ctx.viewport.width},${ctx.viewport.height}`,
      "--window-position=-4000,-4000",                 // off your visible screen
      "--disable-backgrounding-occluded-windows",       // keep rendering while hidden
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "about:blank",
    ], { stdio: "ignore" });
    chrome.on("error", () => { /* surfaced via waitForCdp timeout */ });

    await waitForCdp(ctx.host, ports.cdp);
    return {
      recDir,
      async stop(): Promise<void> {
        try { chrome.kill("SIGKILL"); } catch { /* ignore */ }
        await exec("rm", ["-rf", dir]).catch(() => {});
      },
    };
  },
};

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { Backend, BackendContext, BackendHandle } from "./types.js";
import { waitForCdp } from "./types.js";
import { startPorthole } from "../porthole.js";

const exec = promisify(execFile);

/**
 * Real local Chrome launched off-screen + a raw-CDP screencast porthole.
 * Real fingerprint + your residential IP; remotely viewable/controllable
 * without a virtual display or OS screen-recording permission. The raw-CDP
 * porthole leaves `connectOverCDP` free for a driver/agent to attach.
 */
export const nativeBackend: Backend = {
  kind: "native",
  async start(id, ports, ctx: BackendContext): Promise<BackendHandle> {
    const dir = `/tmp/lucarne/native-${id}`;
    await exec("rm", ["-rf", dir]).catch(() => {});
    await exec("mkdir", ["-p", dir]);
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
    const porthole = await startPorthole(`http://${ctx.host}:${ports.cdp}`, ctx.host, ports.view, ctx.viewport);
    return {
      viewUrl: `http://${ctx.host}:${ports.view}/`,
      async stop(): Promise<void> {
        try { porthole.close(); } catch { /* ignore */ }
        try { chrome.kill("SIGKILL"); } catch { /* ignore */ }
        await exec("rm", ["-rf", dir]).catch(() => {});
      },
    };
  },
};

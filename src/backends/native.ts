import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { Backend, BackendContext, BackendHandle } from "./types.js";
import { waitForCdp } from "./types.js";
import { attachPage } from "../cdp.js";
import { startViewServer, type FrameSource, type InputEvent } from "../porthole.js";
import { startRecorder } from "../recorder.js";

const exec = promisify(execFile);

/**
 * Real local Chrome launched off-screen, with ONE raw-CDP screencast tap fanned
 * out to both the porthole (view + control) and the recorder. Real fingerprint +
 * your residential IP; remotely viewable without a virtual display or OS
 * screen-recording permission. `connectOverCDP` stays free for a driver/agent.
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

    // one screencast tap, shared by porthole + recorder
    const conn = await attachPage(`http://${ctx.host}:${ports.cdp}`);
    let latest: Buffer | null = null;
    const subs = new Set<(f: Buffer) => void>();
    conn.on("Page.screencastFrame", (p: { data: string; sessionId: number }) => {
      latest = Buffer.from(p.data, "base64");
      for (const cb of subs) cb(latest);
      conn.send("Page.screencastFrameAck", { sessionId: p.sessionId });
    });
    conn.send("Page.enable");
    conn.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: ctx.viewport.width, maxHeight: ctx.viewport.height, everyNthFrame: 1 });

    const frames: FrameSource = {
      get: () => latest,
      subscribe: (cb) => { subs.add(cb); return () => subs.delete(cb); },
    };
    const onInput = (ev: InputEvent): void => {
      const button = (["left", "middle", "right"] as const)[ev.button ?? 0] ?? "left";
      if (ev.t === "down") conn.send("Input.dispatchMouseEvent", { type: "mousePressed", x: ev.x, y: ev.y, button, clickCount: 1 });
      else if (ev.t === "up") conn.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: ev.x, y: ev.y, button, clickCount: 1 });
      else if (ev.t === "move") conn.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: ev.x, y: ev.y });
      else if (ev.t === "wheel") conn.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: ev.x, y: ev.y, deltaX: ev.dx, deltaY: ev.dy });
      else if (ev.t === "key" && ev.key) {
        if (ev.key.length === 1) conn.send("Input.insertText", { text: ev.key });
        else if (["Enter", "Backspace", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(ev.key)) {
          conn.send("Input.dispatchKeyEvent", { type: "keyDown", key: ev.key, code: ev.key });
          conn.send("Input.dispatchKeyEvent", { type: "keyUp", key: ev.key, code: ev.key });
        }
      }
    };

    const view = startViewServer({ host: ctx.host, port: ports.view, viewport: ctx.viewport, token: ctx.token, frames, onInput });
    const recorder = ctx.record ? startRecorder({ recDir, fps: ctx.fps, retentionMin: ctx.retentionMin, frames }) : null;

    const tokenQs = ctx.token ? `?token=${encodeURIComponent(ctx.token)}` : "";
    return {
      viewUrl: `http://${ctx.host}:${ports.view}/${tokenQs}`,
      recDir,
      async stop(): Promise<void> {
        try { view.close(); } catch { /* ignore */ }
        try { recorder?.close(); } catch { /* ignore */ }
        try { conn.close(); } catch { /* ignore */ }
        try { chrome.kill("SIGKILL"); } catch { /* ignore */ }
        await exec("rm", ["-rf", dir]).catch(() => {});
      },
    };
  },
};

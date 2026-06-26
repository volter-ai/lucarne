import { attachPage } from "./cdp.js";
import { startRecorder, type Recorder } from "./recorder.js";
import type { FrameSource, InputEvent } from "./porthole.js";

export interface SessionMedia {
  frames: FrameSource;
  onInput(ev: InputEvent): void;
  close(): void;
}

/**
 * The backend-agnostic media plane: attach to a session's CDP, run ONE screencast,
 * and fan the JPEG frames out to both the porthole (WebSocket) and the recorder.
 * Both `native` and `docker` expose CDP, so this is identical for both — the only
 * thing a backend decides is how the browser is isolated/spawned.
 */
export async function startSessionMedia(opts: {
  cdpUrl: string;
  recDir: string;
  viewport: { width: number; height: number };
  record: boolean;
  fps: number;
  retentionMin: number;
}): Promise<SessionMedia> {
  const conn = await attachPage(opts.cdpUrl);
  let latest: Buffer | null = null;
  const subs = new Set<(f: Buffer) => void>();
  conn.on("Page.screencastFrame", (p: { data: string; sessionId: number }) => {
    latest = Buffer.from(p.data, "base64");
    for (const cb of subs) cb(latest);
    conn.send("Page.screencastFrameAck", { sessionId: p.sessionId });
  });
  conn.send("Page.enable");
  conn.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: opts.viewport.width, maxHeight: opts.viewport.height, everyNthFrame: 1 });

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

  const recorder: Recorder | null = opts.record
    ? startRecorder({ recDir: opts.recDir, fps: opts.fps, retentionMin: opts.retentionMin, frames })
    : null;

  return {
    frames,
    onInput,
    close(): void {
      try { recorder?.close(); } catch { /* ignore */ }
      try { conn.close(); } catch { /* ignore */ }
    },
  };
}

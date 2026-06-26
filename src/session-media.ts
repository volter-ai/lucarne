import { attachBrowser, attachPage, type CdpConn } from "./cdp.js";
import { startRecorder, type Recorder } from "./recorder.js";
import { virtualKeyCode } from "./keymap.js";
import type { FrameSource, InputEvent } from "./porthole.js";

const MOUSE_BUTTON = ["left", "middle", "right"] as const;

// editing accelerators (Cmd/Ctrl + key) → CDP edit command
const EDIT_COMMANDS: Record<string, string> = {
  KeyA: "selectAll", KeyC: "copy", KeyV: "paste", KeyX: "cut", KeyZ: "undo", KeyY: "redo", RedoZ: "redo",
};

export interface SessionMedia {
  /** The shared CDP tap — reused by engine-level features (upload, screenshot…). */
  cdp: CdpConn;
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
  downloadDir: string;
  viewport: { width: number; height: number };
  record: boolean;
  fps: number;
  retentionMin: number;
}): Promise<SessionMedia> {
  const conn = await attachPage(opts.cdpUrl);
  // Capture downloads to a retrievable per-session dir (list/get over the API).
  // MUST be browser-level + kept open: a page-session setting only scopes to that
  // session, so a download from any other page/driver would escape it.
  const browserConn = await attachBrowser(opts.cdpUrl);
  browserConn.call("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: opts.downloadDir, eventsEnabled: true }).catch(() => {});
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
    const modifiers = ev.mod ?? 0;
    if (ev.t === "down" || ev.t === "up" || ev.t === "move") {
      conn.send("Input.dispatchMouseEvent", {
        type: ev.t === "down" ? "mousePressed" : ev.t === "up" ? "mouseReleased" : "mouseMoved",
        x: ev.x, y: ev.y,
        button: ev.t === "move" ? "none" : (MOUSE_BUTTON[ev.button ?? 0] ?? "left"),
        buttons: ev.buttons ?? 0,           // held buttons → enables drags
        clickCount: ev.t === "move" ? 0 : (ev.clickCount || 1), // double/triple-click
        modifiers,
      });
    } else if (ev.t === "wheel") {
      conn.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: ev.x, y: ev.y, deltaX: ev.dx, deltaY: ev.dy, modifiers });
    } else if (ev.t === "paste" && typeof ev.text === "string") {
      // Clipboard sync: deliver text the operator pasted into the porthole as if
      // pasted into the focused field (CDP inserts it like a real paste).
      conn.send("Input.insertText", { text: ev.text });
    } else if ((ev.t === "keydown" || ev.t === "keyup") && ev.key) {
      const down = ev.t === "keydown";
      const cmdKey = (modifiers & 2) !== 0 || (modifiers & 4) !== 0; // ctrl or meta = "command" modifier
      // a printable char inserts text on keyDown — UNLESS a command modifier is held (that's a shortcut)
      const text = down && ev.key.length === 1 && !cmdKey ? ev.key : undefined;
      // editing accelerators must be sent as CDP `commands` — synthetic keydowns alone don't fire them
      const command = down && cmdKey && ev.code ? EDIT_COMMANDS[ev.code === "KeyZ" && modifiers & 8 ? "RedoZ" : ev.code] : undefined;
      conn.send("Input.dispatchKeyEvent", {
        type: down ? (text !== undefined ? "keyDown" : "rawKeyDown") : "keyUp",
        key: ev.key,
        code: ev.code ?? "",
        windowsVirtualKeyCode: virtualKeyCode(ev.key, ev.code),
        ...(text !== undefined ? { text, unmodifiedText: text } : {}),
        ...(command ? { commands: [command] } : {}),
        modifiers,
        autoRepeat: !!ev.repeat,
        location: 0,
      });
    }
  };

  const recorder: Recorder | null = opts.record
    ? startRecorder({ recDir: opts.recDir, fps: opts.fps, retentionMin: opts.retentionMin, frames })
    : null;

  return {
    cdp: conn,
    frames,
    onInput,
    close(): void {
      try { recorder?.close(); } catch { /* ignore */ }
      try { conn.close(); } catch { /* ignore */ }
      try { browserConn.close(); } catch { /* ignore */ }
    },
  };
}

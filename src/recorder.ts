import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import type { FrameSource } from "./porthole.js";

export interface Recorder {
  close(): void;
}

/**
 * CCTV ring recorder for the native backend: feeds the shared screencast frames
 * into ffmpeg at a constant cadence (so segments cut on time even when the page
 * is static), hardware-encoded on macOS. Best-effort — returns null and logs if
 * ffmpeg isn't installed; drive + watch still work.
 */
export function startRecorder(opts: {
  recDir: string;
  fps: number;
  retentionMin: number;
  frames: FrameSource;
}): Recorder | null {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  } catch {
    process.stderr.write("lucarne: ffmpeg not found — native recording disabled (drive + watch still work)\n");
    return null;
  }

  const enc = process.platform === "darwin"
    ? ["-c:v", "h264_videotoolbox", "-b:v", "2000k"]   // hardware encode (~0% CPU)
    : ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "28"];

  const ff: ChildProcess = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "image2pipe", "-framerate", String(opts.fps), "-i", "-",
    ...enc, "-pix_fmt", "yuv420p",
    "-f", "segment", "-segment_time", "60", "-reset_timestamps", "1",
    `${opts.recDir}/seg_%05d.mp4`,
  ], { stdio: ["pipe", "ignore", "ignore"] });
  ff.on("error", () => { /* surfaced via the version check above */ });

  // constant-fps tick: write whatever the latest frame is, so a static page
  // still produces regular, clippable minute-segments.
  const tick = setInterval(() => {
    const f = opts.frames.get();
    if (f && ff.stdin?.writable) ff.stdin.write(f);
  }, Math.max(1, Math.round(1000 / opts.fps)));

  // ring buffer: drop segments older than retention
  const prune = setInterval(() => {
    try {
      const now = Date.now();
      for (const name of fs.readdirSync(opts.recDir)) {
        if (!name.startsWith("seg_") || !name.endsWith(".mp4")) continue;
        const fp = path.join(opts.recDir, name);
        if (now - fs.statSync(fp).mtimeMs > opts.retentionMin * 60_000) fs.unlinkSync(fp);
      }
    } catch { /* ignore */ }
  }, 30_000);

  return {
    close(): void {
      clearInterval(tick);
      clearInterval(prune);
      try { ff.stdin?.end(); } catch { /* ignore */ }
      try { ff.kill("SIGKILL"); } catch { /* ignore */ }
    },
  };
}

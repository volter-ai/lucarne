import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Backend, BackendContext, BackendHandle } from "./types.js";
import { waitForCdp } from "./types.js";

const exec = promisify(execFile);

/**
 * Linux Chrome in a container: strong isolation, noVNC porthole, in-container
 * GStreamer CCTV recording. The porthole + CDP are bound to 127.0.0.1 (the noVNC
 * porthole is served by the container, so it is NOT gated by lucarne's token —
 * keep it on loopback, or front it with your own proxy for remote access).
 */
export const dockerBackend: Backend = {
  kind: "docker",
  async start(id, ports, ctx: BackendContext): Promise<BackendHandle> {
    const name = "lucarne-" + id;
    const dir = `/tmp/lucarne/${id}`;
    const recDir = `${dir}/recordings`;
    await exec("mkdir", ["-p", `${dir}/profile`, recDir]);
    await exec("docker", [
      "run", "-d", "--name", name, "--shm-size=1g", "--security-opt", "seccomp=unconfined",
      "-p", `${ctx.host}:${ports.view}:8080`,
      "-p", `${ctx.host}:${ports.cdp}:9222`,
      "-v", `${dir}/profile:/profile`,
      "-v", `${recDir}:/rec`,
      "-e", `RES=${ctx.viewport.width}x${ctx.viewport.height}`,
      "-e", `FLOOR_FPS=${ctx.fps}`,
      "-e", `REC_RETENTION_MIN=${ctx.retentionMin}`,
      "-e", `RECORDER=${ctx.record ? "gst" : "off"}`,
      ctx.image,
    ]).catch((e: Error) => {
      throw new Error(`lucarne: docker run failed — is the image '${ctx.image}' built? Run \`npm run build:image\` (or \`lucarne build-image\`). ${e.message}`);
    });
    await waitForCdp(ctx.host, ports.cdp);
    return {
      viewUrl: `http://${ctx.host}:${ports.view}/vnc.html?autoconnect=true&resize=scale`,
      recDir,
      async stop(): Promise<void> { await exec("docker", ["rm", "-f", name]).catch(() => {}); },
    };
  },
};

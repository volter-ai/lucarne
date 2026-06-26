import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Backend, BackendContext, BackendHandle } from "./types.js";
import { waitForCdp } from "./types.js";

const exec = promisify(execFile);

/**
 * Isolation = a container (process + fs + net). The container only needs to run
 * an isolated Chrome with CDP reachable; the engine drives view/record over that
 * CDP exactly as it does for native. (Recording lands on the engine host.)
 */
export const dockerBackend: Backend = {
  kind: "docker",
  async start(id, ports, ctx: BackendContext): Promise<BackendHandle> {
    const { profileDir, recDir, persist } = ctx;
    const name = "lucarne-" + id;
    if (!persist) await exec("rm", ["-rf", profileDir]).catch(() => {}); // anonymous = fresh
    await exec("mkdir", ["-p", profileDir, recDir]);
    await exec("docker", [
      "run", "-d", "--name", name, "--shm-size=1g", "--security-opt", "seccomp=unconfined",
      "-p", `${ctx.host}:${ports.cdp}:9222`,            // only CDP is exposed
      "-v", `${profileDir}:/profile`,
      "-e", `RES=${ctx.viewport.width}x${ctx.viewport.height}`,
      ctx.image,
    ]).catch((e: Error) => {
      throw new Error(`lucarne: docker run failed — is the image '${ctx.image}' built? Run \`npm run build:image\` (or \`lucarne build-image\`). ${e.message}`);
    });
    await waitForCdp(ctx.host, ports.cdp);
    return {
      async stop(): Promise<void> {
        await exec("docker", ["rm", "-f", name]).catch(() => {});
        await exec("rm", ["-rf", recDir]).catch(() => {});
        if (!persist) await exec("rm", ["-rf", profileDir]).catch(() => {}); // keep durable profiles
      },
    };
  },
};

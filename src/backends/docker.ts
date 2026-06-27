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
    // Be honest, not silent: these only take effect on `native` today. Reject
    // rather than ignore them, so a caller never thinks they applied.
    if (ctx.extensions?.length) throw new Error("lucarne: the docker backend does not support custom `extensions` yet — use backend: 'native'");
    if (ctx.proxy) throw new Error("lucarne: the docker backend does not support `proxy` yet — use backend: 'native'");
    const name = "lucarne-" + id;
    // Reclaim an orphan container of the same name (a previous daemon crash left it
    // holding the name + CDP port), else `docker run --name` would fail on restore.
    await exec("docker", ["rm", "-f", name]).catch(() => {});
    if (!persist) await exec("rm", ["-rf", profileDir]).catch(() => {}); // anonymous = fresh
    await exec("mkdir", ["-p", profileDir, recDir]);
    await exec("docker", [
      "run", "-d", "--name", name, "--shm-size=1g", "--security-opt", "seccomp=unconfined",
      // CDP is full unauthenticated browser control — publish it to LOOPBACK ONLY,
      // never the engine's bind host (ctx.host is already 127.0.0.1, but pin it
      // explicitly so this can never expose CDP to the LAN).
      "-p", `127.0.0.1:${ports.cdp}:9222`,
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

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Backend, BackendContext, BackendHandle } from "./types.js";
import { waitForCdp } from "./types.js";

const exec = promisify(execFile);

/** Linux Chrome in a container: strong isolation, noVNC porthole, CCTV recording. */
export const dockerBackend: Backend = {
  kind: "docker",
  async start(id, ports, ctx: BackendContext): Promise<BackendHandle> {
    const name = "lucarne-" + id;
    const dir = `/tmp/lucarne/${id}`;
    await exec("mkdir", ["-p", `${dir}/profile`, `${dir}/recordings`]);
    await exec("docker", [
      "run", "-d", "--name", name, "--shm-size=1g", "--security-opt", "seccomp=unconfined",
      "-p", `${ctx.host}:${ports.view}:8080`,
      "-p", `${ctx.host}:${ports.cdp}:9222`,
      "-v", `${dir}/profile:/profile`,
      "-v", `${dir}/recordings:/rec`,
      "-e", `RES=${ctx.viewport.width}x${ctx.viewport.height}`,
      ctx.image,
    ]).catch((e: Error) => {
      throw new Error(`lucarne: docker run failed — is the image '${ctx.image}' built? Run \`npm run build:image\` (or \`lucarne build-image\`). ${e.message}`);
    });
    await waitForCdp(ctx.host, ports.cdp);
    return {
      viewUrl: `http://${ctx.host}:${ports.view}/vnc.html?autoconnect=true&resize=scale`,
      async stop(): Promise<void> { await exec("docker", ["rm", "-f", name]).catch(() => {}); },
    };
  },
};

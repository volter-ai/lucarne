import type { Backend, BackendContext, BackendHandle } from "./types.js";
import { waitForCdp } from "./types.js";

/**
 * Isolation = NONE. The "attach" backend connects to a browser someone ELSE
 * already launched (a foreign Chrome on `--remote-debugging-port`), instead of
 * spawning one. It is the discover-and-mirror peer of `native`/`docker`: the
 * engine drives view/record over the foreign CDP exactly as it does for an owned
 * browser — the only difference is lifecycle.
 *
 * It MIRRORS, never OWNS:
 *  - start() launches nothing; it only verifies the endpoint is reachable.
 *  - stop() DETACHES — it never kills the foreign browser (we hold no process
 *    handle; whoever launched it owns its life). The engine closes its own CDP
 *    sockets in `SessionMedia.close()`; there is nothing to tear down here.
 */
export const attachBackend: Backend = {
  kind: "attach",
  async start(_id, ports, ctx: BackendContext): Promise<BackendHandle> {
    // The foreign browser is ALREADY listening at http://${ctx.host}:${ports.cdp}
    // (the engine set ports.cdp to the discovered endpoint's port). Just confirm
    // CDP answers — a shorter window than a launch wait, since it should be up now.
    await waitForCdp(ctx.host, ports.cdp, 8_000);
    return {
      async stop(): Promise<void> {
        // Detach only. Killing the foreign browser would be a violation of the
        // mirror contract — it is not ours to end.
      },
    };
  },
};

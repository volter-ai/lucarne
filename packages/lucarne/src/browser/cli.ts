#!/usr/bin/env node
/**
 * `lucarne-browser-provider` — run lucarne as supercode's `browser.*` provider for one
 * attached Chromium, and keep serving until it is stopped.
 *
 * Endpoint sources, in order of precedence:
 *   --cdp-url ws://127.0.0.1:PORT/…   one endpoint, named outright
 *   --announce-dir DIR                a node's port table; every `{port,pid,pane,label}`
 *                                     file in it is probed and the first CDP endpoint wins
 *                                     (`--pane` narrows it to one pane).
 */
import { cdpEndpointsFromAnnounceDir, startBrowserProvider, type BrowserProvider } from "./provider.js";

const USAGE = `lucarne-browser-provider — supercode browser.* provider over an attached Chromium

  --cdp-url <url>        CDP endpoint (ws://host:port/…, http://host:port, or host:port)
  --announce-dir <dir>   directory of {port,pid,pane,label} announce files to probe
  --pane <pane>          restrict --announce-dir to one pane
  --workspace <dir>      workspace the discovery record is scoped to (default: cwd)
  --port <n>             loopback port for the provider socket (default: an unused one)
  --provider-dir <dir>   where the discovery record is written (default: $SUPERCODE_HOME/providers/browser)
  --quiet                do not log served operations
  --help                 this text
`;

export async function runBrowserProviderCli(argv: string[]): Promise<number> {
  const args = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags.add(name);
    else { args.set(name, next); i += 1; }
  }
  if (flags.has("help") || args.has("help")) { process.stdout.write(USAGE); return 0; }

  const quiet = flags.has("quiet");
  let cdpUrl = args.get("cdp-url");
  if (!cdpUrl) {
    const dir = args.get("announce-dir");
    if (!dir) { process.stderr.write("lucarne: one of --cdp-url or --announce-dir is required\n" + USAGE); return 2; }
    const found = await cdpEndpointsFromAnnounceDir(dir, args.get("pane"));
    if (found.length === 0) {
      process.stderr.write("lucarne: no announced port in " + dir + " answered as a CDP endpoint\n");
      return 3;
    }
    cdpUrl = found[0]!.base;
    if (!quiet) process.stderr.write("lucarne: attaching to " + cdpUrl + (found[0]!.pane ? " (pane " + found[0]!.pane + ")" : "") + "\n");
  }

  let provider: BrowserProvider;
  try {
    provider = await startBrowserProvider({
      cdpUrl,
      workspace: args.get("workspace"),
      providerDirectory: args.get("provider-dir"),
      port: args.has("port") ? Number(args.get("port")) : undefined,
      log: quiet ? undefined : (line) => process.stderr.write("lucarne: " + line + "\n"),
    });
  } catch (error) {
    process.stderr.write("lucarne: the browser provider did not start — " + ((error as Error)?.message ?? String(error)) + "\n");
    return 1;
  }

  process.stdout.write(JSON.stringify({
    provider: "lucarne.cdp",
    port: provider.port,
    record: provider.recordPath,
    endpoint: provider.cdpBase,
  }) + "\n");

  await new Promise<void>((resolve) => {
    const stop = (): void => { void provider.close().then(resolve); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    process.once("SIGHUP", stop);
  });
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined &&
  (process.argv[1].endsWith("browser/cli.js") || process.argv[1].endsWith("lucarne-browser-provider"));
if (invokedDirectly) {
  runBrowserProviderCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

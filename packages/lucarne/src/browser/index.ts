/** lucarne's supercode `browser.*` provider — the adapter, its discovery, its CLI. */
export {
  startBrowserProvider,
  cdpEndpointsFromAnnounceDir,
  cdpHttpBase,
  browserProviderDirectory,
  supercodeHome,
  BROWSER_PROVIDER_PROTOCOL,
  BROWSER_OPERATION_PROTOCOL,
  PROVIDER_ID,
  PROVIDER_NAME,
  PROVIDER_FIDELITY,
} from "./provider.js";
export type { BrowserProvider, BrowserProviderOptions } from "./provider.js";
export { runBrowserProviderCli } from "./cli.js";
export { PAGE_AGENT_SOURCE } from "./page-agent.js";

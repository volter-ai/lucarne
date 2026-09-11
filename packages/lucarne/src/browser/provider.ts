/**
 * Lucarne's `supercode/browser-provider-v1` adapter.
 *
 * Supercode owns the browser operation vocabulary and its schemas; a provider only
 * implements the wire and the page. Lucarne's claim to be a provider is exactly what it
 * already is everywhere else in this package: a driver ATTACHED over CDP to a browser it
 * does not own. So every operation lands as real `Input.*` / `Page.*` traffic, and page
 * code is genuinely available — `browser.script` is served, never refused.
 *
 * The wire, as supercode's CLI dials it:
 *   - a discovery record in `$SUPERCODE_HOME/providers/browser/*.json`, owner-only (0600),
 *     naming a loopback host, a port, a random token and this workspace;
 *   - a TCP listener on 127.0.0.1 that reads ONE newline-terminated JSON request per
 *     connection, answers with one envelope and closes (the caller reads to EOF).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { attachPage, listPages, type CdpConn } from "../cdp.js";
import { virtualKeyCode } from "../keymap.js";
import { PAGE_AGENT_SOURCE } from "./page-agent.js";

export const BROWSER_PROVIDER_PROTOCOL = "supercode/browser-provider-v1";
export const BROWSER_OPERATION_PROTOCOL = "supercode/browser-operation-v1";
export const PROVIDER_ID = "lucarne.cdp";
export const PROVIDER_NAME = "Lucarne (CDP attach)";

/** Supercode's request bound; a longer line is refused before it is parsed. */
const MAX_REQUEST_BYTES = 256 * 1024;
/** Supercode gives a provider 12s end to end; answer inside that or report TIMED_OUT. */
const OPERATION_BUDGET_MS = 11_000;
const HOST_BINDING = "__lucarneHost";

/** Operations lucarne answers in the node process rather than in the page. */
const NODE_OPERATIONS = new Set(["browser.status", "browser.back", "browser.forward", "browser.reload"]);

const PAGE_OPERATIONS = new Set([
  "browser.snapshot", "browser.query", "browser.wait", "browser.click", "browser.fill",
  "browser.press", "browser.hover", "browser.focus", "browser.check", "browser.uncheck",
  "browser.select", "browser.scroll", "browser.box", "browser.mouse", "browser.drag",
  "browser.wheel", "browser.script",
]);

/**
 * What lucarne honestly is, attached to a foreign browser. Supercode stamps this onto every
 * outcome, so it must describe the mechanism rather than flatter it.
 */
export const PROVIDER_FIDELITY = {
  transport: "cdp",
  attached: true,
  ownsBrowser: false,
  accessibility: "dom-derived aria snapshot with page-local refs",
  trustedInput: true,
  input: "CDP Input domain for pointer, wheel, drag and keyboard; DOM value assignment for <select>",
  evaluation: "page code runs through CDP Runtime.evaluate",
  script: "supported — `page` is lucarne's in-page Playwright-shaped shim, whose acts take the same trusted-input path",
  screenshots: false,
  refusals: "none beyond the operation's own failure; lucarne applies no content policy of its own",
} as const;

export interface BrowserProviderOptions {
  /** `ws://host:port/…`, `http://host:port` or `host:port` — any form of one CDP endpoint. */
  cdpUrl: string;
  /** Canonical workspace the record is scoped to. Defaults to the process cwd. */
  workspace?: string;
  /** Directory the discovery record is written into. Defaults to supercode's provider dir. */
  providerDirectory?: string;
  /** Loopback port to bind. 0 (the default) takes a free one. */
  port?: number;
  /** Called with one line per served operation; defaults to silence. */
  log?: (line: string) => void;
}

export interface BrowserProvider {
  readonly port: number;
  readonly token: string;
  readonly recordPath: string;
  readonly cdpBase: string;
  /** Serve one operation directly — the same path the socket takes. */
  call(operation: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

/** Supercode's configuration root, resolved exactly as its CLI resolves it. */
export function supercodeHome(): string {
  const explicit = process.env.SUPERCODE_HOME;
  if (explicit) return explicit;
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, "supercode");
  const home = os.homedir();
  return home ? path.join(home, ".config", "supercode") : path.join(os.tmpdir(), "supercode");
}

export function browserProviderDirectory(): string {
  return path.join(supercodeHome(), "providers", "browser");
}

/** Accept every spelling of a CDP endpoint and return the `http://host:port` base cdp.ts wants. */
export function cdpHttpBase(raw: string): string {
  const value = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : "http://" + value;
  const url = new URL(withScheme);
  const scheme = url.protocol === "wss:" || url.protocol === "https:" ? "https" : "http";
  if (!url.port) throw new Error("lucarne: the CDP endpoint must carry a port — " + raw);
  return scheme + "://" + url.hostname + ":" + url.port;
}

/**
 * Read a directory of announce files — the port table a node keeps from its preload hook,
 * one `{port,pid,pane,label}` record per file — and return the CDP endpoints among them.
 * Which port is a browser is not declared in the file, so each candidate is PROBED:
 * a port that answers `/json/version` with a Chrome debugger endpoint is one.
 */
export async function cdpEndpointsFromAnnounceDir(dir: string, pane?: string): Promise<Array<{ base: string; pane?: string; label?: string; pid?: number }>> {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const found: Array<{ base: string; pane?: string; label?: string; pid?: number }> = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    let record: { port?: unknown; pid?: unknown; pane?: unknown; label?: unknown };
    try { record = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as typeof record; } catch { continue; }
    const port = typeof record.port === "number" ? record.port : Number(record.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
    if (pane !== undefined && String(record.pane ?? "") !== pane) continue;
    const base = "http://127.0.0.1:" + port;
    if (!(await isCdpEndpoint(base))) continue;
    found.push({
      base,
      pane: record.pane === undefined ? undefined : String(record.pane),
      label: record.label === undefined ? undefined : String(record.label),
      pid: typeof record.pid === "number" ? record.pid : undefined,
    });
  }
  return found;
}

async function isCdpEndpoint(base: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const response = await fetch(base + "/json/version", { signal: controller.signal });
      if (!response.ok) return false;
      const body = (await response.json()) as { webSocketDebuggerUrl?: string; Browser?: string };
      return typeof body.webSocketDebuggerUrl === "string" || typeof body.Browser === "string";
    } finally { clearTimeout(timer); }
  } catch { return false; }
}

interface HostRequest { id?: number; kind?: string; payload?: Record<string, unknown> }

/** Start the provider: attach to the page, install the agent, bind the socket, publish the record. */
export async function startBrowserProvider(options: BrowserProviderOptions): Promise<BrowserProvider> {
  const log = options.log ?? ((): void => {});
  const cdpBase = cdpHttpBase(options.cdpUrl);
  const workspace = fs.realpathSync(options.workspace ?? process.cwd());

  let cdp = await attachPage(cdpBase);
  let pointer = { x: 0, y: 0 };

  // ── the trusted-input side of the agent: page code asks, CDP acts ──
  const settle = async (contextId: number | undefined, id: number, error: string | null, value: unknown): Promise<void> => {
    const expression = "window.__lucarneBrowser && window.__lucarneBrowser._settle(" +
      JSON.stringify(id) + "," + JSON.stringify(error) + "," + JSON.stringify(value ?? null) + ")";
    try { await cdp.call("Runtime.evaluate", { expression, ...(contextId === undefined ? {} : { contextId }) }); }
    catch { /* the context died with the page; the agent goes with it */ }
  };

  const mouse = (type: string, extra: Record<string, unknown> = {}): void => {
    cdp.send("Input.dispatchMouseEvent", { type, x: pointer.x, y: pointer.y, ...extra });
  };
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  const NAMED_CODE: Record<string, string> = {
    Enter: "Enter", Tab: "Tab", Escape: "Escape", Backspace: "Backspace", Delete: "Delete",
    ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", ArrowUp: "ArrowUp", ArrowDown: "ArrowDown",
    Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", " ": "Space", Space: "Space",
  };
  const MODIFIER_BIT: Record<string, number> = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Command: 4, Shift: 8 };

  const pressKey = async (spec: string, only?: string): Promise<void> => {
    const parts = spec.split("+");
    const base = parts.length > 1 ? parts[parts.length - 1]! : spec;
    let modifiers = 0;
    for (const part of parts.slice(0, -1)) modifiers |= MODIFIER_BIT[part] ?? 0;
    const key = base === "Space" ? " " : base;
    const code = NAMED_CODE[base] ?? (/^[a-zA-Z]$/.test(key) ? "Key" + key.toUpperCase() : /^[0-9]$/.test(key) ? "Digit" + key : "");
    const printable = key.length === 1 && (modifiers & 2) === 0 && (modifiers & 4) === 0;
    const common = {
      key, code, windowsVirtualKeyCode: virtualKeyCode(key, code || undefined), modifiers, location: 0,
    };
    if (only !== "up") {
      cdp.send("Input.dispatchKeyEvent", {
        type: printable ? "keyDown" : "rawKeyDown",
        ...common,
        ...(printable ? { text: key, unmodifiedText: key } : {}),
      });
    }
    if (only !== "down") cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
    await sleep(10);
  };

  const perform = async (kind: string, payload: Record<string, unknown>): Promise<unknown> => {
    const num = (value: unknown, fallback = 0): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
    switch (kind) {
      case "click": {
        pointer = { x: num(payload.x), y: num(payload.y) };
        const clickCount = num(payload.clickCount, 1);
        mouse("mouseMoved", { button: "none", buttons: 0 });
        mouse("mousePressed", { button: "left", buttons: 1, clickCount });
        mouse("mouseReleased", { button: "left", buttons: 0, clickCount });
        await sleep(20);
        return null;
      }
      case "hover": {
        pointer = { x: num(payload.x), y: num(payload.y) };
        mouse("mouseMoved", { button: "none", buttons: 0 });
        await sleep(10);
        return null;
      }
      case "mouse": {
        const action = String(payload.action ?? "move");
        if (payload.x !== undefined) pointer = { x: num(payload.x), y: num(payload.y) };
        if (action === "move") mouse("mouseMoved", { button: "none", buttons: 0 });
        else if (action === "down") mouse("mousePressed", { button: "left", buttons: 1, clickCount: 1 });
        else if (action === "up") mouse("mouseReleased", { button: "left", buttons: 0, clickCount: 1 });
        else return perform("click", payload);
        await sleep(10);
        return null;
      }
      case "wheel": {
        if (payload.x !== undefined) pointer = { x: num(payload.x), y: num(payload.y) };
        mouse("mouseWheel", { deltaX: num(payload.deltaX), deltaY: num(payload.deltaY), button: "none", buttons: 0 });
        await sleep(20);
        return null;
      }
      case "drag": {
        const from = (payload.from ?? {}) as Record<string, unknown>;
        const to = (payload.to ?? {}) as Record<string, unknown>;
        const steps = Math.min(Math.max(num(payload.steps, 12), 1), 100);
        pointer = { x: num(from.x), y: num(from.y) };
        mouse("mouseMoved", { button: "none", buttons: 0 });
        mouse("mousePressed", { button: "left", buttons: 1, clickCount: 1 });
        for (let step = 1; step <= steps; step++) {
          pointer = {
            x: num(from.x) + ((num(to.x) - num(from.x)) * step) / steps,
            y: num(from.y) + ((num(to.y) - num(from.y)) * step) / steps,
          };
          mouse("mouseMoved", { button: "left", buttons: 1 });
          await sleep(8);
        }
        mouse("mouseReleased", { button: "left", buttons: 0, clickCount: 1 });
        await sleep(20);
        return null;
      }
      case "key": return pressKey(String(payload.key ?? ""), payload.only === undefined ? undefined : String(payload.only)).then(() => null);
      case "type": {
        cdp.send("Input.insertText", { text: String(payload.text ?? "") });
        await sleep(20);
        return null;
      }
      case "selectAll": {
        // A synthetic Cmd/Ctrl+A does nothing on its own — the editing accelerator has to
        // ride as a CDP `command`, the same way lucarne's porthole delivers one.
        const meta = process.platform === "darwin";
        const common = { key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: meta ? 4 : 2, location: 0 };
        cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...common, commands: ["selectAll"] });
        cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
        await sleep(15);
        return null;
      }
      case "history": {
        const history = await cdp.call("Page.getNavigationHistory", {}) as { currentIndex: number; entries: Array<{ id: number }> };
        const index = history.currentIndex + num(payload.delta);
        const entry = history.entries[index];
        if (!entry) throw new Error("lucarne: no history entry in that direction");
        await cdp.call("Page.navigateToHistoryEntry", { entryId: entry.id });
        return null;
      }
      case "reload": {
        await cdp.call("Page.reload", {});
        return null;
      }
      default: throw new Error("lucarne: unknown host request " + kind);
    }
  };

  const wire = (conn: CdpConn): void => {
    conn.send("Page.enable");
    conn.send("Runtime.enable");
    conn.call("Runtime.addBinding", { name: HOST_BINDING }).catch(() => {});
    conn.call("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_AGENT_SOURCE }).catch(() => {});
    conn.on("Runtime.bindingCalled", (params: { name?: string; payload?: string; executionContextId?: number }) => {
      if (params.name !== HOST_BINDING) return;
      let message: HostRequest;
      try { message = JSON.parse(String(params.payload)) as HostRequest; } catch { return; }
      if (typeof message.id !== "number") return;
      const id = message.id;
      void (async (): Promise<void> => {
        try {
          const value = await perform(String(message.kind), message.payload ?? {});
          await settle(params.executionContextId, id, null, value);
        } catch (error) {
          await settle(params.executionContextId, id, (error as Error)?.message ?? String(error), null);
        }
      })();
    });
  };
  wire(cdp);

  /** Reattach if the page socket died (tab crash, target GC) — the agent reinstalls with it. */
  const ensureLive = async (): Promise<void> => {
    try { await cdp.call("Runtime.evaluate", { expression: "1", returnByValue: true }); return; }
    catch { /* fall through to a reattach */ }
    try { cdp.close(); } catch { /* already gone */ }
    cdp = await attachPage(cdpBase);
    wire(cdp);
  };

  const ensureAgent = async (): Promise<void> => {
    const probe = await cdp.call("Runtime.evaluate", { expression: "typeof window.__lucarneBrowser", returnByValue: true }) as { result?: { value?: unknown } };
    if (probe.result?.value === "object") return;
    await cdp.call("Runtime.evaluate", { expression: PAGE_AGENT_SOURCE });
  };

  const pageTarget = async (): Promise<Record<string, unknown>> => {
    try {
      const out = await cdp.call("Runtime.evaluate", { expression: "window.__lucarneBrowser.target()", returnByValue: true }) as { result?: { value?: Record<string, unknown> } };
      return out.result?.value ?? { url: "", title: "", revision: 0 };
    } catch { return { url: "", title: "", revision: 0 }; }
  };

  const failure = (operation: string, code: string, message: string): Record<string, unknown> =>
    ({ ok: false, operation, error: { code, message } });

  const callOperation = async (operation: string, input: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (!NODE_OPERATIONS.has(operation) && !PAGE_OPERATIONS.has(operation)) {
      return failure(operation, "UNSUPPORTED", "lucarne does not implement " + operation + ".");
    }
    await ensureLive();
    await ensureAgent();
    if (operation === "browser.status") {
      const pages = await listPages(cdpBase).catch(() => []);
      return {
        ok: true,
        operation,
        target: await pageTarget(),
        value: {
          available: true,
          provider: PROVIDER_ID,
          endpoint: cdpBase,
          syntheticEvents: false,
          trustedInput: true,
          pages: pages.map((p) => ({ id: p.id, url: p.url, title: p.title })),
          operations: [...NODE_OPERATIONS, ...PAGE_OPERATIONS].sort(),
          fidelity: PROVIDER_FIDELITY,
        },
      };
    }
    if (operation === "browser.back" || operation === "browser.forward" || operation === "browser.reload") {
      try {
        if (operation === "browser.reload") await perform("reload", {});
        else await perform("history", { delta: operation === "browser.back" ? -1 : 1 });
      } catch (error) {
        return { ...failure(operation, "FAILED", (error as Error)?.message ?? String(error)), target: await pageTarget() };
      }
      await sleep(120);
      await ensureAgent();
      return { ok: true, operation, target: await pageTarget(), value: { requested: true } };
    }
    const call = { protocol: BROWSER_OPERATION_PROTOCOL, operation, input };
    const expression = "window.__lucarneBrowser.execute(" + JSON.stringify(call) + ")";
    const out = await cdp.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }) as
      { result?: { value?: Record<string, unknown> }; exceptionDetails?: { text?: string } };
    if (out.exceptionDetails) return failure(operation, "FAILED", out.exceptionDetails.text ?? "the page agent threw");
    const value = out.result?.value;
    if (!value || typeof value.ok !== "boolean") return failure(operation, "FAILED", "the page agent returned no result");
    return value;
  };

  const serve = async (operation: string, input: Record<string, unknown>): Promise<Record<string, unknown>> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        callOperation(operation, input),
        new Promise<Record<string, unknown>>((resolve) => {
          timer = setTimeout(() => resolve(failure(operation, "TIMED_OUT", "lucarne did not finish " + operation + " within " + OPERATION_BUDGET_MS + "ms.")), OPERATION_BUDGET_MS);
        }),
      ]);
    } catch (error) {
      return failure(operation, "FAILED", (error as Error)?.message ?? String(error));
    } finally { clearTimeout(timer); }
  };

  // ── the socket ──
  const token = crypto.randomBytes(32).toString("hex");
  const tokenBuffer = Buffer.from(token);
  const server = net.createServer((socket) => {
    socket.setTimeout(30_000, () => socket.destroy());
    let buffer = "";
    let answered = false;
    const answer = (body: unknown): void => {
      if (answered) return;
      answered = true;
      socket.end(JSON.stringify(body));
    };
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk) => {
      if (answered) return;
      buffer += chunk.toString("utf8");
      if (buffer.length > MAX_REQUEST_BYTES) { socket.destroy(); return; }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      let request: { protocol?: string; id?: string; token?: string; call?: { protocol?: string; operation?: string; input?: Record<string, unknown> } };
      try { request = JSON.parse(line) as typeof request; } catch { socket.destroy(); return; }
      const offered = Buffer.from(String(request.token ?? ""));
      if (offered.length !== tokenBuffer.length || !crypto.timingSafeEqual(offered, tokenBuffer)) { socket.destroy(); return; }
      if (request.protocol !== BROWSER_PROVIDER_PROTOCOL || request.call?.protocol !== BROWSER_OPERATION_PROTOCOL) { socket.destroy(); return; }
      const operation = String(request.call?.operation ?? "");
      const input = request.call?.input ?? {};
      void serve(operation, input).then((result) => {
        log(operation + " -> " + (result.ok === true ? "ok" : "refused"));
        answer({ protocol: BROWSER_PROVIDER_PROTOCOL, id: request.id, result });
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  // ── the discovery record: owner-only, workspace-scoped, loopback ──
  const directory = options.providerDirectory ?? browserProviderDirectory();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch { /* a shared config root may refuse; the file mode still holds */ }
  const recordPath = path.join(directory, "lucarne-cdp-" + process.pid + ".json");
  const record = {
    protocol: BROWSER_PROVIDER_PROTOCOL,
    workspace,
    host: "127.0.0.1",
    port,
    token,
    pid: process.pid,
    endpoint: cdpBase,
    provider: { id: PROVIDER_ID, name: PROVIDER_NAME, fidelity: PROVIDER_FIDELITY },
  };
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2), { mode: 0o600 });
  fs.chmodSync(recordPath, 0o600);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try { fs.rmSync(recordPath, { force: true }); } catch { /* already gone */ }
    try { cdp.close(); } catch { /* already closed */ }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return {
    port, token, recordPath, cdpBase,
    call: (operation, input) => serve(operation, input),
    close,
  };
}

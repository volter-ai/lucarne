import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import type { RouteService, Send } from "../http.js";
import { serveWorkspace } from "../http.js";
import { managedExtensionsDir } from "../profiles.js";

/**
 * The `/extensions` managed-extension registry — upload/list/delete unpacked
 * extensions a session can later load by name. Global, not session-scoped, so it
 * lives outside the engine (the engine only consumes them at session create).
 */
export class ExtensionsService implements RouteService {
  list(): string[] {
    try { return fs.readdirSync(managedExtensionsDir(), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); }
    catch { return []; }
  }
  delete(name: string): boolean {
    const dir = path.join(managedExtensionsDir(), path.basename(name));
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse, send: Send, pathname: string): Promise<boolean> {
    const m = pathname.match(/^\/extensions\/?([^/]*)\/?(.*)$/);
    if (!m) return false;
    const name = m[1] ? decodeURIComponent(m[1]) : "";
    const file = m[2] ? decodeURIComponent(m[2]) : "";
    if (req.method === "GET" && !name) { send(res, 200, this.list()); return true; }
    if (req.method === "DELETE" && name && !file) { send(res, 200, { ok: this.delete(name) }); return true; }
    if (name && file) { await serveWorkspace(req, res, send, path.join(managedExtensionsDir(), path.basename(name)), file); return true; }
    send(res, 405, { error: "method not allowed" });
    return true;
  }
}

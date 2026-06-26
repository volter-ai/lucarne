import fs from "node:fs";
import path from "node:path";
import type http from "node:http";

/** Send a JSON response (the engine + every service share this one shape). */
export type Send = (res: http.ServerResponse, code: number, body: unknown) => void;

/** A subsystem route handler: returns true if it owned (and answered) the request. */
export interface RouteService {
  handle(req: http.IncomingMessage, res: http.ServerResponse, send: Send, pathname: string): Promise<boolean> | boolean;
}

// ── files workspace primitives (shared by the per-session + global + extension dirs) ──
export function putWorkspaceFile(dir: string, name: string, data: Buffer): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, path.basename(name)), data);
}
export function listWorkspaceFiles(dir: string): string[] {
  try { return fs.readdirSync(dir).filter((f) => !f.startsWith(".")).sort(); } catch { return []; }
}
export function workspaceFilePath(dir: string, name: string): string | null {
  const fp = path.join(dir, path.basename(name));
  return fs.existsSync(fp) ? fp : null;
}

/** REST handler for a files workspace dir (GET list/file, PUT, DELETE). */
export async function serveWorkspace(
  req: http.IncomingMessage, res: http.ServerResponse, send: Send, dir: string, name: string,
): Promise<void> {
  if (req.method === "GET" && !name) return send(res, 200, listWorkspaceFiles(dir));
  if (req.method === "GET" && name) {
    const fp = workspaceFilePath(dir, name);
    if (!fp) return send(res, 404, { error: "no such file" });
    res.writeHead(200, { "content-type": "application/octet-stream" });
    fs.createReadStream(fp).pipe(res);
    return;
  }
  if (req.method === "PUT" && name) {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    putWorkspaceFile(dir, name, Buffer.concat(chunks));
    return send(res, 200, { ok: true });
  }
  if (req.method === "DELETE" && name) {
    const fp = workspaceFilePath(dir, name);
    if (fp) fs.rmSync(fp, { force: true });
    return send(res, 200, { ok: !!fp });
  }
  return send(res, 405, { error: "method not allowed" });
}

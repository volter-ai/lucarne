import fs from "node:fs";
import path from "node:path";
import type http from "node:http";

/** Send a JSON response (the engine + every service share this one shape). */
export type Send = (res: http.ServerResponse, code: number, body: unknown) => void;

/** Default body cap — must match engine.MAX_BODY_BYTES. */
export const MAX_BODY_BYTES = 128 * 1024 * 1024;

/**
 * Read a request body with a HARD cap enforced WHILE reading — a `content-length`
 * check alone is bypassed by `Transfer-Encoding: chunked`. Throws a tagged error
 * past the limit so callers can 413.
 */
export async function readBodyCapped(req: http.IncomingMessage, limit = MAX_BODY_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > limit) { const e = new Error("payload too large"); (e as { code?: string }).code = "LUCARNE_BODY_TOO_LARGE"; throw e; }
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

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
    let data: Buffer;
    try { data = await readBodyCapped(req); } catch { return send(res, 413, { error: "payload too large" }); }
    putWorkspaceFile(dir, name, data);
    return send(res, 200, { ok: true });
  }
  if (req.method === "DELETE" && name) {
    const fp = workspaceFilePath(dir, name);
    if (fp) fs.rmSync(fp, { force: true });
    return send(res, 200, { ok: !!fp });
  }
  return send(res, 405, { error: "method not allowed" });
}

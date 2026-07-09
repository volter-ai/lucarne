import type http from "node:http";
import { serveWorkspace, type RouteService, type Send } from "../http.js";
import { globalFilesDir } from "../profiles.js";

/**
 * The global `/files` durable workspace — a daemon-wide scratch dir, not tied to
 * any session. (The per-session `/sessions/:id/files` route stays in the engine,
 * since it resolves the dir from the live session, but shares `serveWorkspace`.)
 */
export class WorkspaceService implements RouteService {
  async handle(req: http.IncomingMessage, res: http.ServerResponse, send: Send, pathname: string): Promise<boolean> {
    const m = pathname.match(/^\/files\/?(.*)$/);
    if (!m) return false;
    await serveWorkspace(req, res, send, globalFilesDir(), decodeURIComponent(m[1] ?? ""));
    return true;
  }
}

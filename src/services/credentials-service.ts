import type http from "node:http";
import { totpCode, type Credential, type CredentialProvider } from "../credentials.js";
import type { RouteService, Send } from "../http.js";

/**
 * The `/credentials` subsystem — a global, NOT session-scoped store, kept out of
 * the engine so the secret store is peelable and the engine stays session-centric.
 * HTTP only ever returns blurred views; secrets leave only via server-side login
 * injection (the engine calls `store.get` directly for that).
 */
export class CredentialsService implements RouteService {
  constructor(private readonly store: CredentialProvider) {}

  /** Current TOTP code for a stored credential (or null if it has none). */
  totp(name: string): string | null {
    const c = this.store.get(name);
    return c?.totp ? totpCode(c.totp) : null;
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse, send: Send, pathname: string): Promise<boolean> {
    const m = pathname.match(/^\/credentials\/?([^/]*)\/?(totp)?$/);
    if (!m) return false;
    const name = m[1] ? decodeURIComponent(m[1]) : "";
    if (req.method === "GET" && !name) { send(res, 200, this.store.list()); return true; }
    if (req.method === "GET" && name && m[2] === "totp") {
      const code = this.totp(name);
      send(res, code ? 200 : 404, code ? { code } : { error: "no totp for credential" });
      return true;
    }
    if (req.method === "GET" && name) { const b = this.store.blur(name); send(res, b ? 200 : 404, b ?? { error: "no such credential" }); return true; }
    if (req.method === "PUT" && name) {
      let body = ""; for await (const c of req) body += c;
      this.store.put(name, body ? (JSON.parse(body) as Credential) : {});
      send(res, 200, { ok: true });
      return true;
    }
    if (req.method === "DELETE" && name) { send(res, 200, { ok: this.store.delete(name) }); return true; }
    send(res, 405, { error: "method not allowed" });
    return true;
  }
}

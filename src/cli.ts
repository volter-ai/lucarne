#!/usr/bin/env node
import { parseArgs } from "node:util";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Lucarne } from "./engine.js";
import { VERSION } from "./version.js";

const API = process.env.LUCARNE_URL ?? "http://127.0.0.1:7800";
const TOKEN = process.env.LUCARNE_TOKEN;

const HELP = `lucarne — self-hostable browser sessions you can drive, watch, and record

Usage:
  lucarne serve [--port 7800] [--host 127.0.0.1]   start the engine daemon
  lucarne create [-b docker|native] [-p name]      mint a session -> {cdpUrl, viewUrl}
  lucarne ls                                        list sessions
  lucarne rm <id>                                   destroy a session
  lucarne open <id>                                 open a session's porthole
  lucarne rec <id>                                  list a session's recordings
  lucarne build-image                               build the docker backend image

Env:
  LUCARNE_URL     daemon URL for client commands (default http://127.0.0.1:7800)
  LUCARNE_TOKEN   bearer token (set on both the daemon and the client when used)
  LUCARNE_CHROME  path to the Chrome/Chromium binary (native backend)

Drive any session with vanilla Playwright:
  const b = await chromium.connectOverCDP(session.cdpUrl)
`;

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  if (TOKEN) headers["authorization"] = `Bearer ${TOKEN}`;
  const res = await fetch(API + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => { throw new Error(`lucarne: cannot reach daemon at ${API} — is \`lucarne serve\` running?`); });
  if (!res.ok) {
    // Don't print an error body and exit 0 as if it worked — surface the failure.
    const detail = await res.text().catch(() => "");
    const hint = res.status === 401 ? " — check LUCARNE_TOKEN" : "";
    throw new Error(`lucarne ${method} ${path} -> ${res.status}${detail ? ` ${detail.trim()}` : ""}${hint}`);
  }
  return res.json();
}

function openUrl(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  execFile(cmd, [url], () => {});
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: "string" },
      host: { type: "string" },
      backend: { type: "string", short: "b" },
      profile: { type: "string", short: "p" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const cmd = positionals[0];
  if (values.version) { process.stdout.write(VERSION + "\n"); return; }
  if (values.help || !cmd) { process.stdout.write(HELP); return; }

  switch (cmd) {
    case "serve": {
      const engine = new Lucarne({
        port: values.port ? Number(values.port) : undefined,
        host: values.host,
      });
      await engine.listen();
      process.stdout.write(`lucarne engine on http://${engine.host}:${engine.port}\n`);
      const restored = await engine.restore();
      if (restored.length) process.stdout.write(`lucarne restored ${restored.length} durable session(s): ${restored.join(", ")}\n`);
      const shutdown = async (): Promise<void> => { await engine.close(); process.exit(0); };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      return;
    }
    case "create": {
      const s = await api("POST", "/sessions", { profile: values.profile, backend: values.backend });
      process.stdout.write(JSON.stringify(s, null, 2) + "\n");
      return;
    }
    case "ls": {
      process.stdout.write(JSON.stringify(await api("GET", "/sessions"), null, 2) + "\n");
      return;
    }
    case "rm": {
      const id = positionals[1];
      if (!id) throw new Error("usage: lucarne rm <id>");
      process.stdout.write(JSON.stringify(await api("DELETE", "/sessions/" + id)) + "\n");
      return;
    }
    case "open": {
      const id = positionals[1];
      if (!id) throw new Error("usage: lucarne open <id>");
      const s = (await api("GET", "/sessions/" + id)) as { viewUrl?: string };
      if (!s.viewUrl) throw new Error(`no such session '${id}'`);
      openUrl(s.viewUrl);
      process.stdout.write(`opening ${s.viewUrl}\n`);
      return;
    }
    case "rec": {
      const id = positionals[1];
      if (!id) throw new Error("usage: lucarne rec <id>");
      process.stdout.write(JSON.stringify(await api("GET", `/sessions/${id}/recordings`), null, 2) + "\n");
      return;
    }
    case "build-image": {
      const dockerDir = fileURLToPath(new URL("../docker", import.meta.url));
      await new Promise<void>((resolve, reject) => {
        const p = execFile("docker", ["build", "-t", "lucarne-browser:latest", dockerDir], (e, _o, stderr) =>
          e ? reject(new Error(stderr || e.message)) : resolve(),
        );
        p.stdout?.pipe(process.stdout);
        p.stderr?.pipe(process.stderr);
      });
      process.stdout.write("built lucarne-browser:latest\n");
      return;
    }
    default:
      throw new Error(`unknown command '${cmd}'\n\n${HELP}`);
  }
}

main().catch((e: Error) => { process.stderr.write((e.message ?? String(e)) + "\n"); process.exit(1); });

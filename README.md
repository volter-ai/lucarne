# lucarne

[![CI](https://github.com/volter-ai/lucarne/actions/workflows/ci.yml/badge.svg)](https://github.com/volter-ai/lucarne/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/lucarne.svg)](https://www.npmjs.com/package/lucarne)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

**Self-hostable browser sessions you can drive, watch, and record — on your own machine and your own IP.**

A browser session in `lucarne` exposes three surfaces at once:

- **drive** — a CDP endpoint; point Playwright at it (`chromium.connectOverCDP(session.cdpUrl)`)
- **watch + control** — a porthole URL; open it or `<iframe>` it to see the browser and take over by hand
- **record** — an ambient rolling recording in the session's data dir

It's the missing middle between *headless automation* (drivable, but you can't watch) and *remote desktop* (watchable, but not cleanly drivable) — a real browser an agent can operate **and** a human can supervise, running where you choose.

**Who it's for:** agent builders who need a browser an agent drives while a human can watch and take over, and anyone automating their *own* logged-in accounts on their own machine and IP (no cloud browser farm, no handing your cookies to a third party).

```
        ┌──────────────── lucarne engine ────────────────┐
 you ──▶ │  porthole (watch + control) ◀── browser ──▶ CDP │ ◀── Playwright / your agent
        │                              │                  │
        │                              └──▶ recording      │
        └───────────────────────────────────────────────┘
```

## Install

```sh
npm install lucarne                 # the engine + `lucarne` CLI
npm install playwright              # only if you'll DRIVE sessions over CDP (most people will)
```

Requires **Node ≥ 22**. Prerequisites by what you use:

- **`native` backend** → Google Chrome installed (or point `LUCARNE_CHROME` / `chromePath` at a Chromium binary).
- **`docker` backend** → Docker (`lucarne build-image` once).
- **recording** (on by default) → **`ffmpeg`** on the engine host. No ffmpeg ⇒ no recordings (everything else still works).

Driving is **vanilla Playwright** against the session's `cdpUrl`, so `playwright` is a peer you install yourself — `npm install lucarne` alone does not pull it in.

## Quickstart

```sh
npx lucarne serve                       # start the engine on :7800
npx lucarne create -b native -p alpha   # mint a session -> { cdpUrl, viewUrl }
npx lucarne open alpha                  # watch + control it in your browser
```

Drive that same session with **vanilla Playwright** — nothing custom:

```ts
import { chromium } from "playwright";

const res = await fetch("http://127.0.0.1:7800/sessions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ profile: "alpha", backend: "native" }),
});
const session = await res.json();

const browser = await chromium.connectOverCDP(session.cdpUrl);   // ← drive
const page = browser.contexts()[0].pages()[0];
await page.goto("https://example.com");
// meanwhile, open session.viewUrl to watch + take over
```

Or use the typed client against a running daemon:

```ts
import { LucarneClient } from "lucarne";
import { chromium } from "playwright";

const lucarne = new LucarneClient({ baseUrl: "http://127.0.0.1:7800", token: process.env.LUCARNE_TOKEN });
const session = await lucarne.create({ profile: "alpha", backend: "native" });
const browser = await chromium.connectOverCDP(session.cdpUrl);   // drive with Playwright
```

The client covers the full API — `create`/`list`/`get`/`status`/`act`/`login`/`tabs`/`logs`/`content`/`activity`/`screenshot`/`pdf`/`recordings`/`exportContext`/… .

The full API is described by an **OpenAPI 3.1** spec at `/openapi.json`, with a Swagger UI at `/docs`.
There's also a stdlib-only **Python client** (`clients/python/lucarne.py`) and an **MCP server**
(`lucarne-mcp`, stdio) that exposes lucarne as agent tools — point any MCP client at it with
`LUCARNE_URL` / `LUCARNE_TOKEN`. Per-session knobs include `mobile`, `quality`, `proxy`, `geo`,
`metadata`, `maxLifetimeMs`/`inactivityMs`, and engine-level `maxConcurrent` + `cors`.

Or embed the engine directly, no daemon:

```ts
import { Lucarne } from "lucarne";

const engine = new Lucarne();
const session = await engine.create({ profile: "alpha", backend: "native" });
console.log(session.cdpUrl, session.viewUrl);
```

## Recipes

Concrete jobs, each a runnable example in [`examples/`](./examples):

- **Operate your own logged-in accounts** — a durable `profile` (seed it from your
  real Chrome once) stays logged in across runs; drive it with Playwright.
  → [`drive.ts`](./examples/drive.ts), [Profiles](#profiles-stay-logged-in)
- **Agent computer-use with a human watching** — high-level `act` (click/type/scroll/
  screenshot) over the same input plane the porthole shows, plus an actor-tagged
  **activity feed** so the agent knows what the human just did and yields instead of
  fighting. → [`computer-use.ts`](./examples/computer-use.ts)
- **Supervised login (secret never leaves the host)** — store a credential encrypted
  at rest; the daemon injects username/password/**TOTP** server-side, so the agent
  logs in without ever seeing the secret. → [`supervised-login.ts`](./examples/supervised-login.ts)
- **Record everything for audit / replay** — sessions record by default; pull the mp4
  segments or open the built-in player. → [`record-and-replay.ts`](./examples/record-and-replay.ts)
- **Embed the porthole in your own UI** — single-origin `viewUrl`, drop it in an
  `<iframe>` (read-only or with URL-bar controls). → [`embed-porthole.html`](./examples/embed-porthole.html)
- **From Python, or any MCP agent** — stdlib Python client, or the `lucarne-mcp`
  stdio server. → [`python_drive.py`](./examples/python_drive.py), [`mcp-config.json`](./examples/mcp-config.json)

## Use it from Python

The daemon is a Node CLI, but you only ever talk to it over **HTTP + CDP**, so the
language you drive from is your choice. There's a **stdlib-only** Python client.
**There is no PyPI package — `pip install lucarne` will not find it.** It's a single
file you vendor (or read straight from the shipped npm tarball):

```sh
npm install -g lucarne && lucarne serve          # the daemon (Node ≥ 22), once
curl -O https://raw.githubusercontent.com/volter-ai/lucarne/main/clients/python/lucarne.py
pip install playwright                            # to drive the cdpUrl from Python
```
```python
from lucarne import LucarneClient                 # the vendored file
from playwright.sync_api import sync_playwright

luc = LucarneClient("http://127.0.0.1:7800")
s = luc.create(profile="demo", backend="native")
with sync_playwright() as p:
    page = p.chromium.connect_over_cdp(s["cdpUrl"]).contexts[0].pages[0]
    page.goto("https://example.com")
```

The Python client covers `health/create/list/get/destroy/act/content`; for the rest of
the surface, call the HTTP API directly (see [API](#api) / `/openapi.json`). Full example:
[`python_drive.py`](./examples/python_drive.py).

## MCP server

`lucarne-mcp` is a stdio MCP server that exposes lucarne as agent tools — give your
AI assistant (Claude Desktop, etc.) a browser. **Start a daemon first** (`lucarne serve`);
the MCP server is a thin bridge to it over `LUCARNE_URL`, so sessions outlive the agent.
`native` sessions need Chrome installed.

```json
{
  "mcpServers": {
    "lucarne": {
      "command": "npx",
      "args": ["-y", "lucarne-mcp"],
      "env": { "LUCARNE_URL": "http://127.0.0.1:7800", "LUCARNE_TOKEN": "" }
    }
  }
}
```

Tools: **`lucarne_create`**, **`lucarne_list`**, **`lucarne_destroy`**, **`lucarne_act`**
(click/move/type/key/scroll/screenshot), **`lucarne_content`** (rendered HTML).
`LUCARNE_TOKEN: ""` = no auth (fine on loopback); set it if you started `serve` with a token.
(Restart your MCP client after editing its config.) The MCP lane is deliberately thin and
`act` is **coordinate-based** — for selector-driven automation, drive the session's `cdpUrl`
with Playwright instead.

## Backends

**A backend is only an isolation strategy.** Drive, watch (porthole), and record are
shared engine code over CDP — *identical* for every backend. Both backends just spawn
an isolated Chrome and expose CDP; the engine does the rest, so a session behaves the
same whichever backend it ran on.

| | `native` | `docker` |
|---|---|---|
| isolation | local process + own profile | container (process + fs + net) |
| Chrome | real local Chrome, off-screen | Linux Chrome in a container |
| fingerprint | **real** (your actual machine) | Linux / no-GPU (bot-detectable) |
| IP | your residential IP | your residential IP |
| needs | Google Chrome | Docker + `lucarne build-image` |

*Shared by both* (engine-side, over CDP): the **porthole** (CDP screencast → JPEG frames
over a **WebSocket** → canvas — survives reverse proxies/tunnels, unlike MJPEG), and
**recording** (CDP screencast → ffmpeg, hardware-encoded on macOS; needs `ffmpeg` on the
engine host). The container is therefore tiny — just Chrome + Xvfb + a CDP bridge, no
VNC/GStreamer stack.

The porthole has **full input fidelity** — modifiers, virtual key codes, editing shortcuts
(select-all / copy / cut / paste / undo via CDP `commands`), **clipboard paste** (text pasted
in the porthole lands in the focused field), drag, double/triple-click, right-click,
scroll, **touch** (phone gestures → `Input.dispatchTouchEvent`), and **IME** composition
(CJK input commits through `Input.imeSetComposition` + `insertText`).

Use **`native`** when you're operating *your own* accounts (real fingerprint + IP matter, isolation-from-your-main-browser is enough). Use **`docker`** when you want stronger sandboxing and don't mind the occasional "verify new device".

By default `native` is **headful** (a real, off-screen window — the authentic lane). Pass
`headless: true` (or `LUCARNE_HEADLESS=1`, or per session `create({ headless: true })`) to run
`--headless=new` instead — no window and **no focus steal**, ideal for servers, CI, or when you
don't need to watch it on this machine.

Build the docker image once:

```sh
npx lucarne build-image     # builds lucarne-browser:latest from the bundled Dockerfile
```

## Profiles (stay logged in)

A **named** profile is durable: its cookies, logins, localStorage and extensions live
under `~/.lucarne/profiles/<name>` (override the root with `LUCARNE_HOME`) and persist
across sessions — so an agent operating *your* accounts stays logged in. An anonymous
session (no `profile`) is ephemeral and wiped on stop. Durable profiles graceful-shutdown
so writes flush to disk.

```ts
await engine.create({ profile: "alpha" });                    // durable, reused by name
await engine.create({ profile: "alpha", seedFromChrome: true }); // first run: seed from your real Chrome
await engine.create({ profile: "alpha", seedFrom: "/path/to/Chrome" }); // …or any user-data-dir
await engine.create({ persist: false });                       // one-off, ephemeral
```

Seeding copies cookies/logins/storage **only on a profile's first creation** — it never
clobbers an established profile. On the same machine the OS-keychain key is shared, so
seeded cookies decrypt and you start authenticated.

Load custom unpacked extensions with `create({ extensions: ["/path/to/ext"] })` (native
backend) — a persistent/seeded profile also brings its own installed extensions along.

Durable sessions **survive a daemon restart**: their specs persist to
`LUCARNE_HOME/sessions.json`, and `lucarne serve` re-spawns them on startup from the
on-disk profile (login state intact). A clean `close()` keeps them; an explicit
`destroy` / `DELETE /sessions/:id` forgets them so a restart won't bring them back.

## API

```ts
const engine = new Lucarne(options?);
await engine.listen();                          // start the HTTP control API
const s = await engine.create({ profile, backend });  // -> Session
engine.list();                                  // -> Session[]
engine.get(id);                                 // -> Session | undefined
await engine.destroy(id);
await engine.close();                           // stop API + tear down all sessions
```

`Session = { id, backend, cdpUrl, viewUrl, createdAt }`.

HTTP control API (what the CLI talks to):

```
POST   /sessions                          CreateSessionOptions -> Session
         {profile?, backend?, persist?, seedFrom?, seedFromChrome?, headless?, extensions?, mobile?,
          quality?, proxy?, geo?, activity?, metadata?, maxLifetimeMs?, inactivityMs?}
GET    /sessions                          -> Session[]
DELETE /sessions                          -> { released }   (release-all)
GET    /sessions/:id                      -> Session
GET    /sessions/:id/status               -> SessionStatus   (uptime, idle, dims, limits)
POST   /sessions/:id/touch                -> { ok }   (reset the inactivity clock)
GET    /sessions/:id/context              -> { cookies, localStorage, origin }   (export)
POST   /sessions/:id/context              {cookies?, localStorage?}  -> { ok }   (import)
GET    /sessions/:id/tabs                 -> { active, tabs:[{id,url,title}] }
POST   /sessions/:id/tabs/:targetId       -> { ok }   (point porthole at that tab)
GET    /sessions/:id/logs[?kind=&limit=]  -> LogEntry[]   (network/console/browser)
GET    /sessions/:id/logs?stream=1        -> text/event-stream   (live SSE)
GET    /sessions/:id/content              -> text/html   (rendered outerHTML)
GET    /sessions/:id/activity[?format=&stream=1]  -> { now, recent }  (agent-readable: what the human/agent did)
GET    /sessions[?meta.key=val]           -> Session[]   (filter by user metadata)
PUT/GET/DELETE /credentials/:name         -> store creds (GET is blurred — never returns secrets)
GET    /credentials/:name/totp            -> { code }   (RFC 6238 TOTP)
POST   /sessions/:id/login                {credential, userSelector?, passSelector?, totpSelector?, submitSelector?}
POST   /sessions/:id/act                  {action:"click|move|type|key|scroll|screenshot", x?,y?,...}  (computer-use; coordinate-based — for selector-driving use Playwright over cdpUrl)
GET    /sessions/:id/replay               -> text/html   (recording player)
PUT/GET/DELETE /extensions/:name/:file    -> upload/manage extensions; create({extensions:["name"]})
GET    /openapi.json  ·  GET /docs        -> OpenAPI 3.1 spec + Swagger UI
```

Credentials are encrypted at rest (AES-256-GCM under a machine-local key) and the secret
never leaves the engine: `POST /sessions/:id/login` injects username/password/TOTP into the
page server-side, so the agent logs in without ever seeing the password. Per-session
`quality` (1–100) controls screencast/recording JPEG size.
DELETE /sessions/:id                      -> { ok }
POST   /sessions/:id/upload               {path, selector?}  -> { ok }  (inject a host file into <input type=file>)
GET    /sessions/:id/downloads            -> string[]   (captured download filenames, oldest first)
GET    /sessions/:id/downloads/:file      -> application/octet-stream
DELETE /sessions/:id/downloads/:file      -> { ok }
GET    /sessions/:id/screenshot           -> image/png   (current page)
GET    /sessions/:id/pdf                   -> application/pdf
GET    /sessions/:id/recordings           -> string[]   (segment filenames, oldest first)
GET    /sessions/:id/recordings/:file     -> video/mp4
GET    /health                            -> { ok, sessions }   (no token needed; ids only when authed)
GET    /profiles                          -> [{ name, active }]   (durable profiles on disk)
DELETE /profiles/:name                    -> { ok }   (refused while a session is live)
GET    /files | PUT/GET/DELETE /files/:name           -> durable global workspace
GET    /sessions/:id/files | PUT/GET/DELETE .../files/:name   -> per-session scratch workspace
```

`Session = { id, backend, cdpUrl, viewUrl, createdAt }`. Recording is on by default
(`record: false` or `LUCARNE_RECORD=0` to disable), a rolling buffer of `retentionMin`
minutes (default 60) of one-minute segments.

## Security

`lucarne` binds to `127.0.0.1` by default — keep it there unless you add a token.

- **CDP is full, unauthenticated control of the browser.** It stays on loopback; never expose a `cdpUrl`. Drivers/agents run on the same host. The `docker` backend publishes container CDP with `docker run -p 127.0.0.1:<port>:9222` — explicitly bound to loopback, never the LAN (it is **not** a bare `-p 9222`).
- **Optional token.** Set `LUCARNE_TOKEN` (or `new Lucarne({ token })`) to require `Authorization: Bearer <t>` / `?token=<t>` on the control API **and** the porthole (HTTP + the WebSocket). Use a long random value, e.g. `export LUCARNE_TOKEN=$(openssl rand -hex 32)`. **Required** whenever you bind off loopback.
- **All portholes are served under the daemon** at `/sessions/:id/view` — one origin, token-gated, relative URLs — so the whole engine sits behind a single reverse proxy / tunnel cleanly, for every backend. Append `?interactable=0` for a read-only viewer (input dropped server-side), or `?controls=1` for a URL bar + back/forward/reload chrome.
- Sessions run real browsers logged into real accounts — treat access to `lucarne` as access to those accounts.

### Exposing it (remote / from your phone)

`lucarne serve --tunnel` exposes the daemon through a tunnel **you already have
installed** — it shells out to the binary, prints the public token-gated `viewUrl`, and
**auto-provisions a token** (a tunneled daemon is never left unauthenticated):

```sh
lucarne serve --tunnel ngrok           # or: --tunnel cloudflared
# → lucarne tunnel: https://ab12.ngrok-free.app  (token-gated)
#   phone view:    https://ab12.ngrok-free.app/sessions/<id>/view/?token=…&controls=1
```

Any other tunnel works via `--tunnel-cmd` — the command just has to print its public
`https://…` URL (tailscale, `ssh -R`, a corporate/relay client). lucarne sets
`LUCARNE_LOCAL_URL`/`LUCARNE_PORT` in its environment:

```sh
lucarne serve --tunnel-cmd "ssh -R 80:localhost:7800 my.relay.example"
```

lucarne **shells out to a tunnel you installed and bundles none** — no extra dependency,
no vendor lock-in (so a private relay is just a `--tunnel-cmd`). Prefer this loopback +
tunnel posture over binding directly; if you must, `serve --host 0.0.0.0 --port <n>` needs
a token and your own TLS. **Never tunnel a `cdpUrl` — only the `viewUrl`.**

### Run it as a service (systemd)

Durable sessions survive a daemon restart, so a unit + `Restart=always` is enough. Keep
the token in a `0600` env-file, not inline (so it isn't in `systemctl show`):

```ini
# /etc/systemd/system/lucarne.service
[Service]
EnvironmentFile=/etc/lucarne.env          # LUCARNE_TOKEN=...  (chmod 0600)
Environment=LUCARNE_HOME=/var/lib/lucarne
ExecStart=/usr/bin/lucarne serve
Restart=always
User=lucarne

[Install]
WantedBy=multi-user.target
```

Health-probe it at `GET /health` (`{ ok, sessions }`, no token needed). The `docker`
backend is selected per session — `lucarne create -b docker -p alpha` (or `{"backend":"docker"}`).

## Status & testing

**1.0 — the API is stable** and follows [SemVer](https://semver.org/): no breaking
changes to the documented surface without a major bump. New capabilities land in minor
releases; read [`CHANGELOG.md`](./CHANGELOG.md) before upgrading.

Every feature lands with a committed, re-runnable acceptance proof that asserts **real
behavior** — a rendered JPEG frame, real-Chrome state, a valid mp4, an RFC TOTP vector —
**never an HTTP 200** (see [`ROADMAP.md`](./ROADMAP.md) "Proof of completion" and
[`CONTRIBUTING.md`](./CONTRIBUTING.md)). The suite (`npm test`) runs the **native** backend
against real Chrome and is enforced in CI on Linux (`google-chrome-stable` + `ffmpeg`,
under `xvfb`). The **docker** backend is smoke-tested when Docker is available (building the
~700 MB image per CI run is intentionally not gated); the native lane is the primary,
fully-proven path. A separate `docker` CI lane (`.github/workflows/docker.yml`) builds the
image and drives a real container (`npm run test:docker`) — on demand, weekly, and whenever
docker-relevant code changes — so the docker backend is proven too, just not on every push.

## Why "lucarne"

A lucarne is a small window set into a roof or a spire — a little opening that lets you see into (and out of) something much larger. That's the porthole onto a browser session.

## License

MIT © Aaron Volter

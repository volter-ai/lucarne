# lucarne

**Self-hostable browser sessions you can drive, watch, and record — on your own machine and your own IP.**

A browser session in `lucarne` exposes three surfaces at once:

- **drive** — a CDP endpoint; point Playwright at it (`chromium.connectOverCDP(session.cdpUrl)`)
- **watch + control** — a porthole URL; open it or `<iframe>` it to see the browser and take over by hand
- **record** — an ambient rolling recording in the session's data dir

It's the missing middle between *headless automation* (drivable, but you can't watch) and *remote desktop* (watchable, but not cleanly drivable) — a real browser an agent can operate **and** a human can supervise, running where you choose.

```
        ┌──────────────── lucarne engine ────────────────┐
 you ──▶ │  porthole (watch + control) ◀── browser ──▶ CDP │ ◀── Playwright / your agent
        │                              │                  │
        │                              └──▶ recording      │
        └───────────────────────────────────────────────┘
```

## Install

```sh
npm install lucarne        # library + `lucarne` CLI
```

Requires **Node ≥ 22**. The `native` backend needs Google Chrome installed; the `docker` backend needs Docker.

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

const lucarne = new LucarneClient({ baseUrl: "http://127.0.0.1:7800", token: process.env.LUCARNE_TOKEN });
const session = await lucarne.create({ profile: "alpha", backend: "native" });
const browser = await chromium.connectOverCDP(session.cdpUrl);   // drive with Playwright
```

The full API is described by an **OpenAPI 3.1** spec at `/openapi.json`, with a Swagger UI at `/docs`.
There's also a stdlib-only **Python client** (`clients/python/lucarne.py`) and an **MCP server**
(`lucarne-mcp`, stdio) that exposes lucarne as agent tools — point any MCP client at it with
`LUCARNE_URL` / `LUCARNE_TOKEN`. Per-session knobs include `mobile`, `quality`, `proxy`, `geo`,
`metadata`, `timeoutMs`/`inactivityMs`, and engine-level `maxConcurrent` + `cors`.

Or embed the engine directly, no daemon:

```ts
import { Lucarne } from "lucarne";

const engine = new Lucarne();
const session = await engine.create({ profile: "alpha", backend: "native" });
console.log(session.cdpUrl, session.viewUrl);
```

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
in the porthole lands in the focused field), drag, double/triple-click, right-click, and
scroll, and **touch** (phone gestures → `Input.dispatchTouchEvent`). Not yet handled: **IME**
(CJK composition) — the known tail.

Use **`native`** when you're operating *your own* accounts (real fingerprint + IP matter, isolation-from-your-main-browser is enough). Use **`docker`** when you want stronger sandboxing and don't mind the occasional "verify new device".

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
POST   /sessions                          {profile?, backend?, persist?, seedFrom?, seedFromChrome?, timeoutMs?, inactivityMs?}  -> Session
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
GET    /sessions[?meta.key=val]           -> Session[]   (filter by user metadata)
PUT/GET/DELETE /credentials/:name         -> store creds (GET is blurred — never returns secrets)
GET    /credentials/:name/totp            -> { code }   (RFC 6238 TOTP)
POST   /sessions/:id/login                {credential, userSelector?, passSelector?, totpSelector?, submitSelector?}
POST   /sessions/:id/act                  {action:"click|move|type|key|scroll|screenshot", ...}  (computer-use)
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

- **CDP is full, unauthenticated control of the browser.** It stays on loopback; never expose a `cdpUrl`. Drivers/agents run on the same host.
- **Optional token.** Set `LUCARNE_TOKEN` (or `new Lucarne({ token })`) to require `Authorization: Bearer <t>` / `?token=<t>` on the control API **and** the porthole (HTTP + the WebSocket). Set this whenever you bind to a non-loopback host.
- **All portholes are served under the daemon** at `/sessions/:id/view` — one origin, token-gated, relative URLs — so the whole engine sits behind a single reverse proxy / tunnel cleanly, for every backend. Append `?interactable=0` for a read-only viewer (input dropped server-side), or `?controls=1` for a URL bar + back/forward/reload chrome.
- Sessions run real browsers logged into real accounts — treat access to `lucarne` as access to those accounts.

`lucarne` ships an *optional* token, but deliberately does **not** ship tunneling or a fleet UI — those belong to whatever consumes it.

## Why "lucarne"

A lucarne is a small window set into a roof or a spire — a little opening that lets you see into (and out of) something much larger. That's the porthole onto a browser session.

## License

MIT © Aaron Volter

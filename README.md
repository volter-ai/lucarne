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

Or embed the engine directly, no daemon:

```ts
import { Lucarne } from "lucarne";

const engine = new Lucarne();
const session = await engine.create({ profile: "alpha", backend: "native" });
console.log(session.cdpUrl, session.viewUrl);
```

## Backends

One API, two backends — pick per session via `backend`:

| | `native` | `docker` |
|---|---|---|
| Chrome | real local Chrome, launched off-screen | Linux Chrome in a container |
| fingerprint | **real** (your actual machine) | Linux / no-GPU (bot-detectable) |
| IP | your residential IP | your residential IP |
| isolation | per-profile data isolation | container (process + fs + net) |
| porthole | raw-CDP screencast (MJPEG), token-gated | noVNC (loopback-only) |
| recording | CDP screencast → ffmpeg (hardware-encoded on macOS) | in-container GStreamer |
| needs | Google Chrome (+ ffmpeg for recording) | Docker + `lucarne build-image` |

Use **`native`** when you're operating *your own* accounts (real fingerprint + IP matter, isolation-from-your-main-browser is enough). Use **`docker`** when you want stronger sandboxing and don't mind the occasional "verify new device".

Build the docker image once:

```sh
npx lucarne build-image     # builds lucarne-browser:latest from the bundled Dockerfile
```

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
POST   /sessions                          {profile?, backend?}  -> Session
GET    /sessions                          -> Session[]
GET    /sessions/:id                      -> Session
DELETE /sessions/:id                      -> { ok }
GET    /sessions/:id/recordings           -> string[]   (segment filenames, oldest first)
GET    /sessions/:id/recordings/:file     -> video/mp4
```

`Session = { id, backend, cdpUrl, viewUrl, createdAt }`. Recording is on by default
(`record: false` or `LUCARNE_RECORD=0` to disable), a rolling buffer of `retentionMin`
minutes (default 60) of one-minute segments.

## Security

`lucarne` binds to `127.0.0.1` by default — keep it there unless you add a token.

- **CDP is full, unauthenticated control of the browser.** It stays on loopback; never expose a `cdpUrl`. Drivers/agents run on the same host.
- **Optional token.** Set `LUCARNE_TOKEN` (or `new Lucarne({ token })`) to require `Authorization: Bearer <t>` / `?token=<t>` on the control API **and** native portholes. Set this whenever you bind to a non-loopback host.
- **Native portholes are served under the daemon** at `/sessions/:id/view` — one origin, token-gated, so the whole engine sits behind a single reverse proxy / tunnel cleanly (the porthole uses relative URLs, so it nests under any proxy path).
- **The docker (noVNC) porthole is served by the container**, so it is **not** token-gated by lucarne — keep it on loopback, or front it with your own proxy.
- Sessions run real browsers logged into real accounts — treat access to `lucarne` as access to those accounts.

`lucarne` ships an *optional* token, but deliberately does **not** ship tunneling or a fleet UI — those belong to whatever consumes it.

## Why "lucarne"

A lucarne is a small window set into a roof or a spire — a little opening that lets you see into (and out of) something much larger. That's the porthole onto a browser session.

## License

MIT © Aaron Volter

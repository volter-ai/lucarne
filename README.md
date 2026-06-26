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
| porthole | raw-CDP screencast (MJPEG) | noVNC |
| needs | Google Chrome | Docker + `lucarne build-image` |

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
POST   /sessions   {profile?, backend?}  -> Session
GET    /sessions                          -> Session[]
GET    /sessions/:id                      -> Session
DELETE /sessions/:id                      -> { ok }
```

## Security

`lucarne` binds the daemon and all portholes to `127.0.0.1` by default — and you should keep it that way.

- **CDP is full, unauthenticated control of the browser.** Never expose a `cdpUrl` on a public interface.
- **The porthole has no auth.** It is a viewer/controller of a live, possibly-logged-in browser. Put your *own* auth + transport (a tunnel, a reverse proxy, an SSH forward) in front of it before it leaves localhost.
- Sessions run real browsers logged into real accounts — treat access to `lucarne` as access to those accounts.

`lucarne` deliberately does **not** ship auth, tunneling, or a fleet UI — those belong to whatever consumes it.

## Why "lucarne"

A lucarne is a small window set into a roof or a spire — a little opening that lets you see into (and out of) something much larger. That's the porthole onto a browser session.

## License

MIT © Aaron Volter

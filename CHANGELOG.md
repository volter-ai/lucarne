## lucarne 1.7.5

- Packaging fix: `termfleet` is no longer installed with Lucarne. The repository's autonomy runner
  uses `@termfleet/core` directly as development-only tooling; neither is part of Lucarne's runtime.

## lucarne 1.7.3

- Widget hot replacement: registering changed iframe HTML under the same widget namespace now reloads the
  existing mounted iframe in place. Daemon restarts pick up rebuilt consumer UI immediately without waiting
  for the host page to navigate, while the host element and page-level listeners remain singletons.

## lucarne 1.7.2

- Widget size handshake: the iframe now re-posts its measured size until the host page acknowledges it
  (`{action:'sizeAck'}`, on the same `ns`-scoped chrome channel), instead of posting once and hoping. Fixes a
  roughly coin-flip boot in which the widget's first size message landed before the host armed its listener and
  was lost forever — leaving a small collapsed pill stranded inside an oversized, mostly-empty glass card. The
  host also boots at a plausible pill size (220x44, was 300x120), so the pre-handshake frame is no longer a
  large empty placeholder.

## lucarne 1.7.1

- Widget glass theme probe: sample the element stack under a real viewport point (not just
  `body`/`html`) so pages that paint their background on a container (HN's table, docs sites)
  read as light; a fully-transparent stack on a loaded document now means the UA's white
  canvas, not dark. Fixes an illegible dark-frost widget on light pages.

# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may break).

## [1.7.0]

The platform is **two packages**.

- **`lucarne` 1.7.0 — the engine, widget included.** Sessions you can drive
  (CDP), watch and control (porthole), and record; plus the in-page widget
  infrastructure at `lucarne/widget`, `lucarne/widget/host`,
  `lucarne/widget/runtime`, `lucarne/widget/build`, `lucarne/widget/preact`.
  `esbuild`, `preact` and `playwright-core` are OPTIONAL peers — the srcdoc
  build helper loads `esbuild` lazily and names it if it's missing, `preact`
  stays inside the preact adapter, and the widget selftest keeps its lazy
  `playwright-core` load — so installing the engine still pulls in neither a
  bundler nor a UI framework nor a browser.
  The engine's own MCP bin is gone: the raw computer-use plane (coordinate
  clicks, rendered HTML) is reachable over the HTTP API, and the agent-facing
  MCP surface is the human-paced interact plane below.

- **`lucarne-interact` 0.3.0 — the verbs, recall, the records store, and the
  one MCP.** The human-paced ACT plane (`open`/`snap`/`scroll`/`activate`/
  `back`/`capture`/`type`/`send`/`video.*`) and the passive read-only recall
  sensor are joined by the record language and store they write into
  (`lucarne-interact/records`) and by **`lucarne-mcp`**, the platform's one
  stdio MCP server: read-only corpus queries, the interact verbs over a
  session's `cdpUrl`, and session create/list/destroy against a lucarne
  daemon over plain HTTP. `--corpus-only` (or `LUCARNE_MCP_CORPUS_ONLY=1`)
  serves the corpus queries alone — a mode that loads no browser stack and
  performs no network I/O at all.
  The charter holds at the agent boundary exactly as it holds on the class:
  there is no `click`, `goto` or `eval` tool; `type` stages and never
  submits; `send` is the one submit path and runs the same default-refuse
  `decideSend` gate, with its standing mode set by the operator
  (`LUCARNE_SEND_MODE`, default `ask`) rather than by the agent.
  This package depends on no lucarne package: it reaches a session over its
  `cdpUrl` and a daemon over HTTP.

## [1.6.1]

### Fixed
- **Sticky injections now reliably run on reloads and navigations.**
  `Page.addScriptToEvaluateOnNewDocument` fires at document-START — before
  `document.documentElement` exists — so a DOM-touching injected source would throw
  and no-op on each fresh document (it only appeared to work on the current, already-
  loaded document via the immediate eval). The store now ALSO re-evaluates every source
  on the page's `load` event (DOM present), so an injection genuinely survives a reload,
  a navigation, a newly opened tab, and a daemon restart. Injected sources may now run
  twice per document (document-start hook + load re-eval), so they must be null-safe +
  idempotent (documented in the README `/inject` note).
- The request-triggered first apply is awaited and SURFACES a genuine browser-side fault
  (a live page the store can't reach) as a **502** — while a tab closed concurrently with
  the request is absorbed as a non-failure (no spurious error), and `POST /inject` can't
  200 while applying to nothing; async discovery of pages opened later stays best-effort.
  The desired state is now persisted even when the apply surfaces a fault, so a durable
  session's injection is never silently lost on the next restart. Page CDP sessions get an
  onClose prune so a dropped page socket re-attaches on the next apply (load hook stays live).

## [1.6.0]

New capability: sticky script injection (`/inject`), the engine-side piece cadence's
in-page widget mounts through — ported from cadence's Playwright-based eval-server
sticky store onto the engine's own raw CDP client, so the engine stays Playwright-free.

### Added
- **`POST/GET /sessions/:id/inject`** — register/replace (`{id, source, bypassCSP?}`) or
  remove (`{id, remove:true}`) a *sticky* script injection: applied to the session's
  already-open pages immediately, re-applied on every reload
  (`Page.addScriptToEvaluateOnNewDocument`), and covering NEWLY OPENED tabs via raw CDP
  target discovery (`Target.setDiscoverTargets`/`Target.targetCreated`) — no Playwright
  `BrowserContext` page event is available or used. `bypassCSP:true` holds a LIVE
  per-page CDP session for as long as the page is open (`Page.setBypassCSP` is bound to
  the session's lifetime, not the page's). The injection set is persisted into the
  session spec (`LUCARNE_HOME/sessions.json`, additive `inject` field on
  `CreateSessionOptions`) so a daemon restart re-applies everything for a durable
  session. `GET` returns the currently-registered (and policy-accepted) ids.
- **`injectPolicy(id) => boolean`** engine option — accept/reject a sticky-injection id;
  default is permissive (every id accepted). A rejected id makes `POST /inject` return
  4xx and `GET /inject` never lists it. The hook only decides accept/reject — content
  doctrine (e.g. a shell-only allow-list) is the embedder's policy, not the engine's.
  `LucarneClient` gains `injections()`/`setInjection()`/`removeInjection()`.

## [1.5.2]

Repo-shape-only change: the engine moved into an npm-workspaces monorepo. No engine
behavior, public API, or SemVer promise changes.

### Changed
- **The repo is now an npm-workspaces monorepo.** The engine (`src`, `test`, `docker`,
  its `package.json`) moved to `packages/lucarne` (`git mv`, history preserved). The
  root is a private workspaces package (`workspaces: ["packages/*"]`) with a shared
  `tsconfig.base.json`; `clients/python`, `examples/`, `standards/`, `scheduler/`,
  `.claude/`, and the top-level docs stay at the repo root. `packages/lucarne/{clients,
  examples,LICENSE,README.md}` are symlinks to the root originals so `npm pack` ships
  the identical file list it always did (README, LICENSE, `dist`, `docker`, the Python
  client, the examples, both bins). Root `npm test`/`npm run build` fan out to
  workspaces (`--workspaces --if-present`).

## [1.4.1]

A **third** adversarial review round (6 skeptics aimed at the 1.4.0 diff — "a hardening
pass is itself new code") found that BOTH of 1.4.0's flagship fixes shipped follow-on
defects, plus robustness/perf/honesty issues. All fixed, the no-Chrome ones each with a
committed proof.

### Fixed (privacy — a 1.4.0 regression)
- **A password typed AFTER Tabbing from a non-secret field is no longer leaked.** 1.4.0
  captured field secrecy only at type-START and Tab did not flush, so `username<Tab>password`
  coalesced into one run classified by the *username* field → the password logged
  UNredacted (a textbook login flow). Now Tab/Enter/Escape flush the buffer and secrecy is
  the fail-closed UNION of the type-start read and a flush-time re-read. Proven by a
  cross-field e2e (the password value never appears in the activity feed).

### Fixed (robustness — cdp.ts, the least-reviewed module)
- **A malformed CDP frame or a throwing event handler no longer crashes the daemon** — the
  raw socket reader guards `JSON.parse` and each handler dispatch.
- **A dropped CDP socket is no longer silent** — an `onclose` rejects every in-flight call
  (was: hung until the 15s timeout) and marks the connection closed so later calls fail
  fast instead of going quietly dead.
- **`close()` drains in-flight calls** (clear timers + reject) so it can't leave a non-`unref`'d
  15s timer pinning the loop. Both proven with a fake CDP server.

### Fixed (lifecycle — a 1.4.0 regression)
- **`create` can no longer hang forever after a wedged teardown.** A `docker rm -f` with no
  timeout could leave `destroying` un-drained, hanging every future same-id create; the
  teardown's `stop()` is now bounded (12s) so it always settles.

### Performance
- **`downloads()` stats each file once** (was: `statSync` *inside* the sort comparator —
  O(N·logN) sync stats, ~146 ms at 1000 files, blocking the loop). Proof: decorate-once.
- **The frame watchdog is gated** on `record || a live viewer` and seeds once — idle,
  unwatched, unrecorded sessions are now fully dormant (was: a `captureScreenshot` every
  second per session, defeating Chrome's idle throttling). Its errors are now LOGGED, not
  swallowed.
- **CDP ports are reclaimed** via a free-list (was: `nextCdp++` forever → invalid ports
  after ~56k create/destroy cycles). Proof: a freed port is reused by the next create.
- **The recorder retention prune and profile seeding are async** (were sync FS storms on
  the event loop at high retention / large profiles).

### Fixed (input)
- **Shifted symbols and numpad operators map to the correct virtual key code** (`:` `?` `{`
  `+` `~` `_` `"`, NumpadAdd/Subtract/…) — they were keyed by the unshifted char and
  resolved to vk `0`, so the page's keyCode handlers and browser shortcuts never fired.
  Proof: a keymap table assertion.

### Honesty
- **Retracted a 1.4.0 over-claim.** The 1.4.0 CHANGELOG said the watchdog primed frames for
  "fully-idle pages"; round 3 proved it primed ZERO frames on a static headless page and
  the active-page proof never exercised that path. The fully-idle headless recording path
  remains **unverified** (it needs a real headless Chrome the local env can't run without
  focus-stealing); the watchdog now logs failures so the stall is diagnosable, and the
  claim is corrected rather than left standing.

### Packaging
- Removed a stray `__pycache__/*.pyc` from the npm tarball.

## [1.4.0]

A second adversarial review round (6 skeptics — regression-on-the-1.3.0-diff, security
bypass re-attack, empirical concurrency stress, recording-in-headless, cross-platform,
completeness) found that 1.3.0's own hardening shipped new holes. All fixed, each with a
committed proof.

### Security
- **The porthole WebSocket upgrade is now CSRF/rebinding-guarded** (was: only the HTTP
  plane). A cross-origin web page could open the porthole WS and drive + watch a tokenless
  loopback daemon — **critical**, now closed (shared guard on both planes).
- **The rebinding host check is a strict loopback LITERAL** — `127.x.evil.com` (which
  `startsWith("127.")` accepted) and an absent `Host` are now refused (fail-closed).
- **`file://` nav block strips leading C0 control chars** first (`\x00file://` bypassed the
  old `\s*` regex) and default-denies by scheme allowlist (http/https/about/data only).
- **Body cap is enforced WHILE reading** (a `Transfer-Encoding: chunked` body bypassed the
  content-length-only check → OOM). Upload confinement now uses `realpath` (symlink escape).

### Fixed (concurrency)
- **destroy-then-recreate-same-id no longer clobbers the new session** — `create` awaits an
  in-flight teardown, so the old `destroy`'s dir cleanup can't wipe the successor's
  workspace (a confirmed race I introduced in 1.3.0). Verified under empirical stress.

### Fixed (Windows — was hard-broken)
- Backends use `node:fs` instead of POSIX `mkdir`/`rm` (every session create threw `ENOENT`
  on Windows). Tunnel teardown kills the tree via `taskkill` on win32 (the POSIX
  process-group kill silently orphaned the tunnel). Chrome resolves from a per-platform
  candidate list (Program Files (x86) / per-user install / `chromium`).

### Fixed (privacy)
- **Typed-secret redaction is captured at type-time and broadened** — a password typed
  before a submit/navigation was leaking UNredacted (focus gone at flush → fail-open); now
  fail-closed, covering password + `autocomplete` cc/otp/current-password + name/id
  cvv/ssn/card/secret. **Network-log URLs are stripped of query/fragment** (they carried
  OAuth/bearer tokens into the `/logs` ring).

### Fixed (recording)
- **An ACTIVE headless page now records real frames**, proven by a committed e2e that
  asserts a real (>2 KB, `ftyp`) mp4 — the prior proof had been weakened to a 200/MIME
  check that a 48-byte empty stub passed. A frame watchdog attempts to seed frames for
  low-activity pages via `Page.captureScreenshot`. **Honesty note (corrected in 1.4.1):**
  the 1.4.0 watchdog did NOT actually prime a *fully-idle* headless page — that path
  stayed unverified; see 1.4.1. Headful (the native default, continuous compositing) was
  always unaffected.

### Chore
- Regenerated `package-lock.json` (was pinned at `0.5.0` → `npm ci` failed on a fresh clone).

## [1.3.0]

A hardening release from a 6-dimension adversarial review (security red-team,
concurrency/leak deep-dive, proof-integrity skeptic, contract-drift, claims-vs-reality,
fresh-install). Every finding below ships with a committed proof.

### Security
- **Docker CDP is now pinned to loopback** (`-p 127.0.0.1:<port>:9222`) regardless of the
  daemon's `--host` — previously, `serve --host 0.0.0.0` published the container's
  (un-tokened) CDP to the LAN. CDP for **both** backends is loopback-only, always.
- **Token is enforced off-loopback, not just advised.** `serve` auto-provisions + prints a
  token whenever it binds off loopback (`--host` ≠ loopback, or `--tunnel`), so a
  remotely-reachable daemon is never unauthenticated.
- **CSRF / DNS-rebinding guard** for the tokenless loopback mode: requests with a
  non-loopback `Host` or cross-origin `Origin` are refused (403), so a malicious web page
  can't drive your localhost daemon.
- **Host-file read closed:** navigation refuses `file://`/`chrome://` (no read-back via
  `/content`/`/screenshot`), `/upload` is confined to the session `/files` workspace, and
  the `extensions` create-option is `basename`-confined (was the one un-sanitized path).
- **Request body size cap** (413 over 128 MB) so one large upload can't OOM the daemon;
  **timing-safe** token comparison.

### Fixed (concurrency / leaks)
- **`destroy` is now idempotent at its synchronous entry** — the 500 ms reaper no longer
  re-enters destroy ~12× during a slow `stop()` and over-releases the concurrency slot
  (which corrupted `maxConcurrent` accounting).
- **`create` rolls back fully on every error path** (browser/container `stop()` + media
  close + slot release + dir cleanup) — previously a mid-create failure (esp. with
  `extensions`) leaked Chrome/ffmpeg and could permanently deadlock all future creates.
- **Concurrent same-id `create`s coalesce** onto one in-flight promise (no orphaned twin
  session). **`act()` now refreshes the idle clock** so an agent-driven `inactivityMs`
  session isn't reaped mid-work. **ffmpeg availability is probed once + cached** (no
  synchronous spawn per create on the event loop). Docker `restore` reclaims an orphan
  container of the same name. Porthole WS drops frames for a stalled client (no unbounded
  buffering).

### Fixed (contract drift)
- MCP `lucarne_act` exposes `button`/`clickCount` (right-/double-click were unreachable via
  MCP). Python `list()` URL-encodes the metadata filter (matched the Node SDK). Python
  `__version__` derives from package metadata (no double-hardcoded drift). OpenAPI documents
  the bare-list routes (`/files`, `/extensions`, `/sessions/:id/files`); added
  `client.deleteDownload()`.

### Docs / tests
- Security section rewritten to match enforced reality (incl. honest notes that
  `?interactable=0` is a per-connection mode not a capability boundary, and `/login` is not
  a confidentiality boundary against the caller). Fixed README staleness (`sessionStorage`
  in context, `metadata` in `Session`). Killed two weak proofs (`theme` theater, `seed`
  no-clobber that didn't test no-clobber) and added real coverage: the security fixes,
  end-to-end recording through the engine, `act()`-keeps-alive, idempotent double-destroy,
  create-rollback, and `deleteExtension`.

## [1.2.2]

### Fixed
- **Tunnel teardown could orphan the real tunnel process.** A `--tunnel-cmd` runs under a
  shell; `stop()` sent SIGTERM to the shell, which (for a non-`exec` wrapper) left the
  actual tunnel child running and the public ingress open after the daemon stopped. The
  shell child is now spawned **detached** and `stop()` kills the whole process group with a
  SIGKILL backstop — proven against a real non-exec grandchild.
- **ngrok/cloudflared URL match now handles multi-label hosts** (regional/reserved domains
  like `name.eu.ngrok.io`, branded `*.trycloudflare.com`), and a preset-pattern miss now
  falls through to the generic non-noise heuristic instead of timing out on a live tunnel.

### Note
- The Python client (PyPI `lucarne`) is versioned to match (1.2.2) and its summary
  corrected ("create and drive" — the thin client doesn't itself watch/record).

## [1.2.1]

### Fixed
- **`--tunnel cloudflared` grabbed the wrong URL.** Real cloudflared prints a
  `cloudflare.com/website-terms` link and a `developers.cloudflare.com` docs link in its
  startup banner *before* the actual `trycloudflare.com` tunnel URL, and the naive "first
  non-loopback https URL" picked the banner link. Each preset now matches its real URL
  host (`*.trycloudflare.com`, `*.ngrok[-free].{app,dev,io}`); the generic `--tunnel-cmd`
  heuristic also skips obvious vendor/doc hosts. Verified end-to-end against **real**
  cloudflared *and* ngrok tunnels (public URL → `/health` 200, token gate 401/200), and
  the real banner text is now a committed regression proof.

## [1.2.0]

### Added
- **`lucarne serve --tunnel ngrok|cloudflared`** (and `--tunnel-cmd "<command>"` for any
  other tunnel — tailscale, `ssh -R`, a private relay) — exposes the daemon for remote /
  phone access by **shelling out to a tunnel you already have installed**. lucarne bundles
  no tunnel and adds no dependency (stays vendor-neutral: a custom relay is just a
  `--tunnel-cmd`). It parses the tunnel's public URL, prints the token-gated `viewUrl`, and
  **auto-provisions a token** so a tunneled daemon is never unauthenticated. New
  `src/tunnel.ts` (`startTunnel`/`pickPublicUrl`/`tunnelSpawnSpec`/`ensureTunnelToken`),
  proven deterministically with a stub `--tunnel-cmd` (no ngrok/network needed in CI).

## [1.1.0]

### Added
- **Full SDK ↔ HTTP parity.** `LucarneClient` now covers the whole API: credentials
  (`putCredential`/`credentials`/`credential`/`deleteCredential`/`credentialTotp`),
  managed `extensions`/`deleteExtension`, the global + per-session file workspaces
  (`files`/`file`/`putFile`/`deleteFile`, `sessionFiles`/`sessionFile`/`putSessionFile`/
  `deleteSessionFile`). The "typed SDK" now reaches every documented route.

### Docs
- Closed the residual gaps a second onboarding pass surfaced: a **systemd service**
  unit, the explicit `pip install lucarne` "won't find it — vendor the file" note, the
  MCP `act`-is-coordinate-based tradeoff, the docker CDP `-p 127.0.0.1:<port>:9222`
  loopback mechanism (stated, not just asserted), and `SECURITY.md` updated to 1.x +
  token/key rotation.

## [1.0.0]

First stable release. The API now follows SemVer — no breaking changes to the
documented surface without a major bump. This release froze the contract after a
public-surface audit + a 7-persona onboarding test; the changes below are the
freeze fixes.

### Changed (breaking)
- **`CreateSessionOptions.timeoutMs` → `maxLifetimeMs`** (and the matching
  `SessionStatus` field). It's the absolute max-lifetime cap; the old name read as an
  idle timeout next to `inactivityMs`. (`inactivityMs` is unchanged.)
- **`ActivityNow.focusedField` is now `string | undefined`** (was typed `string | null`)
  — the public type now matches what the engine actually serves.

### Fixed
- `ActivityEvent` / `ActivityNow` / `LogEntry` had drifting duplicate definitions; they
  now have **one home** (`types.ts`) so the exported type can't diverge from the wire.
- The typed SDK's `logs()` returns `LogEntry[]` (was `unknown[]`); `health()` includes
  the optional `ids`; added `client.upload()` and `client.deleteProfile()`.
- Exported `BlurredCredential` and `LogEntry` (a host implementing `CredentialProvider`
  can now name its return type). OpenAPI documents `DELETE /profiles/{name}` and the
  `/files/{name}` PUT/DELETE verbs.

### Docs
- README: dedicated **Python** and **MCP** sections (were buried one-liners), an explicit
  **`npm install playwright`** note, **ffmpeg** promoted to a prerequisite, an
  **"exposing it / from your phone"** reverse-proxy + tunnel recipe, and the `act`
  computer-use verb clarified as coordinate-based. IME is documented as supported.

## [0.12.0]

### Changed
- **1.0-readiness refactor (architecture).** The global, non-session subsystems —
  credentials, the `/files` workspace, and managed `/extensions` — moved out of the
  engine into their own `RouteService` modules (`src/services/*`, `src/http.ts`), so
  the engine is session-centric and those subsystems are peelable. **Behavior is
  unchanged** (the existing HTTP proofs cover it); the removed engine methods
  (`credentialTotp`, `listManagedExtensions`, `deleteManagedExtension`, the workspace
  helpers) were internal.

### Added
- **Pluggable credential store** — `EngineOptions.credentials` accepts any
  `CredentialProvider`; the encrypted-file store ships as the default
  `FileCredentialStore` (both now exported). Bring your own vault/KMS without the
  secret store being baked into the engine.
- **Backend-registration seam** — `engine.registerBackend(backend)` /
  `EngineOptions.backends`; add an isolation backend without editing the engine.
- Exported the shared `ActAction` type (one shape across the engine, SDK, and MCP —
  was duplicated and could drift).

### Removed
- The dead `EngineOptions.viewPortBase` (vestigial since the porthole went
  single-origin in 0.3).

## [0.11.0]

### Added
- **Full-surface typed SDK** — `LucarneClient` now covers `screenshot`/`pdf`/`recordings`/
  `recording`/`downloads`/`download`/`activity`/`touch`/`exportContext`/`importContext`
  (binary endpoints return `Uint8Array`). New exported types `ActivityEvent`/`ActivityNow`/
  `SessionContext`, and an exported `VERSION`.
- **`lucarne --version`** (`-v`), sourced from `package.json` — the CLI, MCP `serverInfo`,
  and OpenAPI `info.version` now share one version (no more hard-coded drift).
- **`LUCARNE_CHROME`** env to point the native backend at a specific Chrome/Chromium binary.
- **Runnable examples** for every advertised capability (computer-use, record/replay,
  supervised login, porthole embed, Python, MCP config) + a README **Recipes** section.
- **Docker-backend CI proof** — a smoke job builds the image and drives a real container
  (`test/docker-smoke.mjs`), so the docker path is proven, not assumed.

### Changed
- **Clearer failures, never silent.** The CLI now exits non-zero with a message on an HTTP
  error (was: print body, exit 0); a missing Chrome binary fails fast with guidance (was: a
  25 s timeout); a taken port rejects with a clear message (was: a raw crash). The **docker
  backend now rejects** `proxy`/`extensions` (native-only) instead of silently ignoring them.
- The OpenAPI spec documents the full session surface (`act`/`activity`/`context`/`touch`/
  `recordings`/`downloads`/`files`/`view`), and the published package ships `clients/` +
  `examples/` (the README-referenced Python client was previously orphaned).

## [0.10.0]

### Added
- **Activity log (Initiative II, A1–A3)** — an agent-ergonomic feed of what the *human* (and agent)
  did in a session, so an agent collaborates instead of fighting. `create({ activity: true })` /
  `LUCARNE_ACTIVITY=1`; `GET /sessions/:id/activity` → `{ now, recent }`, `?format=text|playwright`,
  `?stream=1` SSE. Events are **actor-tagged** (`human` = porthole input, `agent` = act/CDP driver),
  navigation from CDP, clicks/typing from the porthole; typed text is coalesced and **redacted** for
  password/sensitive fields. **Clicks resolve `{selector, text, role}`** (`elementFromPoint`, off the hot
  path), so the Playwright-verb format renders `await page.click("button#login")` in the agent's own
  vocabulary. `now` carries `url`/`title`/`focusedField`/`lastHumanActionMsAgo` — the **presence-to-yield**
  signal an agent uses to avoid fighting the human.

## [0.9.1]

### Added
- **Headless option** for the native backend (`headless: true` / `LUCARNE_HEADLESS=1`,
  per-session `create({ headless })`) — `--headless=new`, no window, **no focus steal**.
  Headful stays the default (the authentic lane). The acceptance suite now runs headless
  by default (no more stolen focus / no xvfb needed for most of it); a gated `headed:`
  proof (`LUCARNE_TEST_HEADED=1`, run in CI) still verifies the real headful path.

## [0.9.0]

### Added
- **CI now runs the full acceptance suite** (Linux + `google-chrome-stable` + `ffmpeg`
  under `xvfb`), not just `npm run build` — the proofs are enforced on every push/PR.
- **Recording acceptance proof** — a `record: true` session produces a playable mp4,
  verified end to end with `ffprobe` (valid duration). New `segmentSeconds` option
  (default 60) so recording can be tested without waiting a full minute.
- Project governance: `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, and this
  changelog. README CI/npm badges and a pre-1.0 stability note.

## [0.8.0]

### Added
- **Computer-use REST** (`POST /sessions/:id/act`: click/move/type/key/scroll/screenshot)
  for non-CDP agents.
- **MCP server** (`lucarne-mcp`) exposing create/list/destroy/act/content as agent tools.
- Concurrency cap + queue (`maxConcurrent`), BYO passthrough `proxy` + `geo` override,
  permissive `cors`, and a stdlib **Python client** (`clients/python/lucarne.py`).

## [0.7.0]

### Added
- Durability (status, `timeout`/`inactivity` reaping, survive daemon restart), multi-tab
  porthole, view-only + nav controls, touch, mobile viewport, screenshot/PDF, health +
  per-session stats, session-context export/import, extensions (CDP `loadUnpacked`),
  files workspace, profile API, quality control.
- Observability: network/console/browser **log capture** + SSE, `/content` HTML,
  userMetadata tags. **Credentials API + RFC 6238 TOTP**, encrypted at rest, auto-inject.
  Typed **Node SDK** + **OpenAPI**/`/docs`, IME/composition, porthole theme, extension
  upload/manage, recording **replay** viewer.

## [0.6.0]

### Added
- Persistent named profiles (`~/.lucarne/profiles/<name>`), **seed-from-Chrome**, clipboard
  paste, file **upload** into the page, and browser **download** capture.

## [0.5.0]

### Added
- Full porthole input parity — modifiers, virtual key codes, editing shortcuts
  (select-all/copy/cut/paste/undo via CDP `commands`), drag, multi-click, right-click,
  scroll.

## [0.4.0]

### Changed
- Unified both backends on **one CDP-screencast-over-WebSocket porthole** (survives reverse
  proxies/tunnels). Thinned the docker image to Chrome + Xvfb + a CDP bridge.

## [0.3.0]

### Added
- Single-origin porthole routing under the daemon (`/sessions/:id/view`), so the whole
  engine sits behind one reverse proxy.

## [0.2.0]

### Added
- Native-backend recording (shared CDP screencast → ffmpeg), optional `LUCARNE_TOKEN`,
  `GET /sessions/:id/recordings`.

## [0.1.0]

### Added
- Initial release: the browser-session engine — drive (CDP), watch + control (porthole),
  record — with `native` and `docker` backends, the `lucarne` CLI, and the HTTP API.

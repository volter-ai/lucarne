# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may break).

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

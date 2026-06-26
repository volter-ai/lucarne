# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may break).

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

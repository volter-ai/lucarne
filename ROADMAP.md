# lucarne roadmap — feature-complete for the native lane

## Goal

**1:1 with the browser-infra category (Browserbase · Steel · Browserless) on every
*operational* feature — omitting only the two things we deliberately invert:**

- **native, not cloud** — runs on *your* machine; no managed fleet / regions / billing.
- **authentic, not spoofed** — real Chrome, real fingerprint, your real IP and logins;
  so no anti-detect / fingerprint-spoofing / captcha-solving (the human solves it via the
  porthole — that's the feature).

Everything else they have, we build. This file is the exhaustive checklist (the union of
all three platforms' feature surfaces) so "done" is provable. `✅ have · 🔨 build (phase) ·
🚫 deliberate non-goal`.

---

## A. Session lifecycle & management
- ✅ create / get / list / destroy session, token auth
- ✅ P1 explicit **`status`** + rich session object (uptime, idle, dims, limits); `GET /sessions/:id/status`. *(Proof: status returns uptime + dims.)* · 🔨 P1 `release-all`
- ✅ P1 **`timeout`** (max duration) and **`inactivityTimeout`** (idle auto-release; `touch` / porthole input resets it). *(Proof: idle session reaped · touch keeps alive · timeout reaps even an active session.)*
- ✅ P1 **session outlives the driver** — sessions are engine-owned processes; a porthole/CDP client disconnect never ends them, reconnect by id. 🔨 P1 survive *daemon* restart (persisted registry — see "survive restart")
- 🔨 P2 `userMetadata` tags + list-query filter
- 🔨 P3 concurrency allocation / pooling / queue
- 🚫 regions / multi-region (your machine *is* the location) · billing/credits · rate-limits

## B. Persistence — the P0 crux
- ✅ **P0 persistent profiles** — durable named profiles (`~/.lucarne/profiles/<name>`, `LUCARNE_HOME`
  override) keep cookies, localStorage, IndexedDB, prefs **and extensions** across sessions; durable
  profiles graceful-shutdown (SIGTERM) to flush to disk, anonymous sessions stay ephemeral.
  *(Proof: cookie survives destroy + recreate.)*
- ✅ **P0 seed from your real Chrome profile** — `seedFrom`/`seedFromChrome` copy cookies/logins/storage
  on a profile's first creation so it starts authenticated. *(Proof: seeded profile carries the source cookie.)*
- 🔨 P1 profile API — create / get / list / update / delete
- 🔨 P1 **session-context export/import** — dump cookies + localStorage + sessionStorage + IndexedDB; restore into a new session
- 🔨 P2 encrypted profiles/credentials at rest
- 🚫 stored *spoofed* fingerprints (native = real fingerprint)

## C. Drive / connect
- ✅ CDP endpoint → Playwright / Puppeteer / Selenium / any CDP client
- 🔨 P3 `computer-use` REST action endpoint (move/click/type/scroll/screenshot) for non-CDP agents
- 🔨 P3 Selenium remote URL (if asked) · DevTools inspector redirect

## D. Live view / human takeover (the porthole)
- ✅ interactive porthole, **full input parity** (modifiers, editing shortcuts, drag, multi-click, right-click, scroll), token-gated, single-origin / proxy-embeddable
- 🔨 P1 **multi-tab** — list pages, per-tab view, switch/focus tab (sessions have >1 tab today; porthole shows one)
- ✅ P1 view-only mode (`?interactable=0`, input dropped server-side) *(Proof: input from a view-only socket never reaches Chrome.)* · 🔨 P1 `showControls` nav chrome (URL bar + back/forward) · quality control · theme
- 🔨 P1 **touch input** (phone gestures → `Input.dispatchTouchEvent`) + mobile viewport / virtual keyboard
- ✅ P0 **clipboard sync** — text pasted into the porthole is delivered into the focused field (CDP `Input.insertText`). *(Proof: paste lands in a real input.)*
- 🔨 P2 **WebRTC transport** option (cellular-smooth; current WS-JPEG stays the default)
- 🔨 P2 **native-UI capture decision** — CDP screencast shows the *page*, not native browser UI (file-picker, basic-auth, print, OS dropdowns). Decide: keep CDP-screencast + handle those over CDP, or capture the real window (native backend *has* a real window). Known architectural gap for the native lane.
- 🔨 P2 disconnect events · IME / composition input

## E. Recording / replay
- ✅ recording (CCTV ring → ffmpeg, hardware-encoded)
- 🔨 P2 **replay viewer/player** over the segments · per-tab recording · HLS delivery

## F. Observability / logs
- 🔨 P2 **network log capture** (CDP `Network.*`) · **console log capture** · CDP event log — per session, API + SSE stream
- ✅ P1 **health endpoint** — `GET /health` (liveness + session count; ids only to an authed caller). *(Proof: count == live sessions.)* · 🔨 P1 per-session stats / "pressure"
- 🔨 P3 log export · OpenTelemetry

## G. File handling
- ✅ **P0 download retrieval** — downloads captured to a per-session dir (browser-level `Browser.setDownloadBehavior`); `GET/DELETE /sessions/:id/downloads[/file]`. *(Proof: porthole-triggered download captured, bytes match.)*
- ✅ **P0 file upload into the browser** — inject a host file into `<input type=file>` via CDP `DOM.setFileInputFiles`; `POST /sessions/:id/upload`. *(Proof: page's file input reports matching name + sha256.)*
- 🔨 P1 session + global files/workspace API

## H. Capture / output
- ✅ P1 **screenshot API** + **PDF API** (CDP `Page.captureScreenshot` / `printToPDF`); `GET /sessions/:id/{screenshot,pdf}`. *(Proof: valid PNG at viewport width · valid PDF ≥1 page.)*
- 🔨 P2 rendered-`/content` HTML
- 🔨 P3 `/scrape` (elements) · markdown/readability · `/export` bundle — *optional* (raw CDP/Playwright already covers driving)
- 🚫 `/search` · `/map` · `/crawl` · `/smart-scrape` — the *scraping platform* surface, the other lane

## I. Extensions
- 🔨 P1 extensions — load custom extensions; **your profile's extensions come free** once persistent profiles land
- 🔨 P2 extension upload/manage API

## J. Credentials / auth injection
- 🔨 P2 credentials API — store + auto-inject username/password/**TOTP**, blur from agent/viewer
  *(less critical than for cloud — with persistent profiles you simply stay logged in — but valuable)*
- 🔨 P3 1Password / secrets-manager integration

## K. Proxies / network
- 🔨 P3 optional **BYO passthrough proxy** + geolocation override (e.g., when *you* travel)
- 🚫 residential/datacenter **proxy network** / IP rotation (your real IP is the whole point)

## L. Stealth / anti-detect / captcha  🚫 (the inverted lane — do NOT build)
- 🚫 fingerprint spoofing · stealth plugins · `humanize` · `skipFingerprintInjection`
- 🚫 captcha-*solving* service / `/unblock` — **the human solves it via the porthole**
- 🚫 `verified`/`advancedStealth` browser builds

## M. AI / agent integration
- 🔨 P3 **MCP server** — mint / list / drive / watch / take-over as MCP tools (any agent can use lucarne)
- 🔨 P3 high-level actions (`act`/`extract`/`observe`) — *optional*; or just document "use Playwright over `cdpUrl`"
- ✅ framework drivers work today (anything that speaks CDP/Playwright)

## N. SDK / API / DX
- 🔨 P2 typed client SDK (Node + Python) · **OpenAPI/Swagger** docs · `/docs` UI
- ✅ CLI · REST control API

## O. Deployment / ops
- ✅ Docker self-host (thin image) · token auth
- ✅ P1 idle reaping / TTL (inactivity + max-duration reaper) · ✅ health endpoint
- 🔨 P3 concurrency / queue config · CORS · env config
- 🚫 managed cloud / HA / autoscaling / multi-region (local by design)

---

## Build order (phases)

**Phase 1 — "actually be me" (P0):** persistent profiles · seed-from-real-Chrome · clipboard sync · file upload · download retrieval. *Without these, "operate my accounts" isn't real.*

**Phase 2 — daily-driver robustness (P1):** session durability (timeout / inactivity / keepAlive / reconnect / persisted registry / survive restart) · multi-tab porthole · view-only + nav controls · touch input · screenshot/PDF API · health/metrics · session-context export/import · extensions · files API · idle reaping.

**Phase 3 — observability & DX (P2):** network/console/CDP log capture + stream · replay viewer · typed SDK + OpenAPI · credentials API (+ TOTP) · IME · WebRTC porthole option · native-UI-capture decision · encrypted profiles.

**Phase 4 — agents, ecosystem, scale (P3):** MCP server · computer-use REST endpoint · concurrency/pooling · optional BYO-proxy + geo · high-level actions · termfleet-native window kind · log export/OTel.

---

## Proof of completion (the discipline)

**No feature is "done" until a committed, re-runnable acceptance proof asserts its REAL
behavior and passes (exit 0)** — at the level that actually matters (rendered pixels /
real-Chrome state / the loaded UI), **never an HTTP 200.** (This session repeatedly
mistook "the proxy returns 200" for "it works" when the UI was blank/offline — the proof
discipline exists to kill that.) Proofs live in `test/acceptance.mjs` (`npm test`). CI runs
build/typecheck; acceptance runs where Chrome is available. Every feature PR must add/extend
a proof, green, before it counts.

### Green today (committed in `test/acceptance.mjs`)
✅ drive (connectOverCDP navigates) · ✅ porthole renders a real JPEG frame · ✅ input: caps/shift
typing reaches Chrome · ✅ input: Cmd+A select-all (CDP editing command) · ✅ persist: cookie survives
destroy + recreate · ✅ persist→seed: fresh profile seeded from another carries its cookie · ✅ seed:
only on first creation · ✅ clipboard: paste lands in focused input · ✅ upload: file input reports
name + sha256 · ✅ download: porthole-triggered download captured + bytes match. **Phase 1 (P0) complete.**
P1 so far: ✅ screenshot · ✅ pdf · ✅ health · ✅ status (rich object) · ✅ inactivity reap (+touch reset) ·
✅ max-duration timeout · ✅ view-only (input dropped server-side). **19/19.**
Proven *ad hoc* this session, to be converted to committed proofs: recording → valid 60s mp4;
full chain (console→bridge→lucarne) renders a live green pixel + click/type lands in the UI.

### Acceptance proof each roadmap item must meet
**P0** — persistent profiles: set cookie/login in profile X, destroy + recreate same profile, assert it persists · seed: fixture profile's known cookie present in new session · clipboard: paste delivers text into a focused real-Chrome input · file upload: page's file input reports matching filename + sha256 · downloads: triggered download listed + fetched bytes' sha256 match.
**P1** — durability: keepAlive session survives daemon kill+restart, reconnect by id, state intact · multi-tab: API lists 2 tabs, porthole switches, frames differ · touch: dispatched tap fires page handler at mapped coords · screenshot/PDF: valid PNG(magic+dims)/PDF(%PDF+pagecount) · health: count == live sessions · context export/import: exported cookies/storage equal after import.
**P2** — logs: captured log contains the known request URL + console line · replay: ≥N frames for N seconds recorded · credentials/TOTP: auto-fills a fixture login, generates a valid TOTP · SDK/OpenAPI: SDK round-trips create/list/destroy, spec validates.
**P3** — MCP: client calls create/list/drive/destroy with asserted results · termfleet-native: the in-UI proof (provider green + window renders live pixel + click/type lands) — committed, not ad hoc.

## The thesis
> Steel/Browserbase/Browserless = *ephemeral, managed, anonymized* browsers at scale — **spoof to evade.**
> **lucarne = your durable, authenticated, real browser identities — *be genuinely you* — an agent
> operates them and you watch/take-over from anywhere.**
> Same operational toolkit, the half of the market nobody else serves. This roadmap closes every
> operational gap and *only* that half; the spoofing/cloud surface is deliberately, permanently out.

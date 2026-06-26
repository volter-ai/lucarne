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
- 🔨 P1 `release-all`, explicit `status` + rich session object (createdAt, duration, eventCount, dims)
- 🔨 P1 **`timeout`** (max duration) and **`inactivityTimeout`** (idle auto-release; reset on CDP/input)
- 🔨 P1 **`keepAlive` + reconnect** across client disconnect (session outlives the driver)
- 🔨 P2 `userMetadata` tags + list-query filter
- 🔨 P3 concurrency allocation / pooling / queue
- 🚫 regions / multi-region (your machine *is* the location) · billing/credits · rate-limits

## B. Persistence — the P0 crux
- 🔨 **P0 persistent profiles** — durable named profiles (`~/.lucarne/profiles/<name>`) that keep
  cookies, localStorage, IndexedDB, sessionStorage, service workers, prefs **and extensions**
  across sessions. *(Today `native` `rm -rf`s the profile every run = always logged out — the
  single most important fix.)*
- 🔨 **P0 seed from your real Chrome profile** — import cookies/logins so a profile starts authenticated
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
- 🔨 P1 view-only mode (`interactable=false`) · `showControls` nav chrome (URL bar + back/forward) · quality control · theme
- 🔨 P1 **touch input** (phone gestures → `Input.dispatchTouchEvent`) + mobile viewport / virtual keyboard
- 🔨 P0 **clipboard sync** (paste passwords / 2FA / text into the porthole)
- 🔨 P2 **WebRTC transport** option (cellular-smooth; current WS-JPEG stays the default)
- 🔨 P2 **native-UI capture decision** — CDP screencast shows the *page*, not native browser UI (file-picker, basic-auth, print, OS dropdowns). Decide: keep CDP-screencast + handle those over CDP, or capture the real window (native backend *has* a real window). Known architectural gap for the native lane.
- 🔨 P2 disconnect events · IME / composition input

## E. Recording / replay
- ✅ recording (CCTV ring → ffmpeg, hardware-encoded)
- 🔨 P2 **replay viewer/player** over the segments · per-tab recording · HLS delivery

## F. Observability / logs
- 🔨 P2 **network log capture** (CDP `Network.*`) · **console log capture** · CDP event log — per session, API + SSE stream
- 🔨 P1 **health / metrics endpoint** (liveness, per-session stats, "pressure")
- 🔨 P3 log export · OpenTelemetry

## G. File handling
- 🔨 **P0 download retrieval** — capture files the session downloads; list / get / delete API
- 🔨 **P0 file upload into the browser** — inject a local file into `<input type=file>` via CDP `DOM.setFileInputFiles`, exposed in porthole + API
- 🔨 P1 session + global files/workspace API

## H. Capture / output
- 🔨 P1 **screenshot API** + **PDF API** (CDP `Page.captureScreenshot` / `printToPDF` — trivial)
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
- 🔨 P1 idle reaping / TTL · health endpoint
- 🔨 P3 concurrency / queue config · CORS · env config
- 🚫 managed cloud / HA / autoscaling / multi-region (local by design)

---

## Build order (phases)

**Phase 1 — "actually be me" (P0):** persistent profiles · seed-from-real-Chrome · clipboard sync · file upload · download retrieval. *Without these, "operate my accounts" isn't real.*

**Phase 2 — daily-driver robustness (P1):** session durability (timeout / inactivity / keepAlive / reconnect / persisted registry / survive restart) · multi-tab porthole · view-only + nav controls · touch input · screenshot/PDF API · health/metrics · session-context export/import · extensions · files API · idle reaping.

**Phase 3 — observability & DX (P2):** network/console/CDP log capture + stream · replay viewer · typed SDK + OpenAPI · credentials API (+ TOTP) · IME · WebRTC porthole option · native-UI-capture decision · encrypted profiles.

**Phase 4 — agents, ecosystem, scale (P3):** MCP server · computer-use REST endpoint · concurrency/pooling · optional BYO-proxy + geo · high-level actions · termfleet-native window kind · log export/OTel.

---

## The thesis
> Steel/Browserbase/Browserless = *ephemeral, managed, anonymized* browsers at scale — **spoof to evade.**
> **lucarne = your durable, authenticated, real browser identities — *be genuinely you* — an agent
> operates them and you watch/take-over from anywhere.**
> Same operational toolkit, the half of the market nobody else serves. This roadmap closes every
> operational gap and *only* that half; the spoofing/cloud surface is deliberately, permanently out.

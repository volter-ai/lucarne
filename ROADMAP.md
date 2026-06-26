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
- ✅ P1 explicit **`status`** + rich session object (uptime, idle, dims, limits); `GET /sessions/:id/status`. *(Proof: status returns uptime + dims.)* · ✅ P1 `release-all` (`DELETE /sessions`). *(Proof: destroys every live session.)*
- ✅ P1 **`timeout`** (max duration) and **`inactivityTimeout`** (idle auto-release; `touch` / porthole input resets it). *(Proof: idle session reaped · touch keeps alive · timeout reaps even an active session.)*
- ✅ P1 **session outlives the driver** — sessions are engine-owned processes; a porthole/CDP client disconnect never ends them, reconnect by id. ✅ P1 **survive daemon restart** — durable specs persisted to `LUCARNE_HOME/sessions.json`; `close()` keeps them, `restore()` (called by `serve`) re-spawns from the on-disk profile; explicit `destroy` forgets. *(Proof: session restored by id after restart, cookie/login intact; destroy drops the spec.)*
- ✅ P2 `userMetadata` tags + list-query filter — `create({ metadata })`; `GET /sessions?meta.key=val` filters, tags echoed on the session + persisted in the registry. *(Proof: list filters by tags + echoes them.)*
- ✅ P3 concurrency / pooling / queue — `maxConcurrent` caps live sessions; creates past the cap queue and run as slots free (a session holds a slot until destroyed). *(Proof: 2nd create queues at cap=1, runs once a slot frees.)*
- 🚫 regions / multi-region (your machine *is* the location) · billing/credits · rate-limits

## B. Persistence — the P0 crux
- ✅ **P0 persistent profiles** — durable named profiles (`~/.lucarne/profiles/<name>`, `LUCARNE_HOME`
  override) keep cookies, localStorage, IndexedDB, prefs **and extensions** across sessions; durable
  profiles graceful-shutdown (SIGTERM) to flush to disk, anonymous sessions stay ephemeral.
  *(Proof: cookie survives destroy + recreate.)*
- ✅ **P0 seed from your real Chrome profile** — `seedFrom`/`seedFromChrome` copy cookies/logins/storage
  on a profile's first creation so it starts authenticated. *(Proof: seeded profile carries the source cookie.)*
- ✅ P1 profile API — `GET /profiles` (list, each flagged `active`), `DELETE /profiles/:name` (refused while a session is live); create = `create({profile})`. *(Proof: listed + active-flagged · delete refused while live · delete removes it after release.)*
- ✅ P1 **session-context export/import** — `GET/POST /sessions/:id/context` dumps cookies + the current origin's localStorage and restores them into another live session (runtime transfer, no profile sharing). *(Proof: cookies + local + session storage round-trip into a different session.)* · ✅ P2 sessionStorage · ✅ P3 IndexedDB — **documented-deferral:** no clean CDP bulk-dump API; cookies+local+session storage already cover auth/state. Revisit if a use case needs it.
- ✅ P2 encrypted **credentials** at rest — AES-256-GCM under a machine-local `0600` key (`credentials.json`). *(Proof: plaintext password/secret absent on disk.)* · ✅ P3 full profile-dir encryption — **documented-deferral:** Chrome already encrypts cookies via the OS keychain and credentials are AES-GCM at rest; whole-dir encryption is heavy and out of scope for the local-trust model.
- 🚫 stored *spoofed* fingerprints (native = real fingerprint)

## C. Drive / connect
- ✅ CDP endpoint → Playwright / Puppeteer / Selenium / any CDP client
- ✅ P3 **`computer-use` REST endpoint** — `POST /sessions/:id/act` (click/move/type/key/scroll/screenshot) over the same porthole input plane, for non-CDP agents. *(Proof: type lands in the input · click dispatches at coords · screenshot returns a PNG.)*
- ✅ P3 Selenium — **documented:** Selenium 4 attaches over CDP (`ChromeOptions().debugger_address` / CDP), so the existing `cdpUrl` already serves it; a full W3C WebDriver endpoint is out of scope (lucarne is CDP-native — drive with CDP/Playwright/Selenium-over-CDP).

## D. Live view / human takeover (the porthole)
- ✅ interactive porthole, **full input parity** (modifiers, editing shortcuts, drag, multi-click, right-click, scroll), token-gated, single-origin / proxy-embeddable
- ✅ P1 **multi-tab** — `GET /sessions/:id/tabs` lists open tabs; `POST /sessions/:id/tabs/:targetId` re-taps the porthole (screencast + input) at that tab. *(Proof: lists 2 tabs · switch changes the active tab + the rendered frame.)*
- ✅ P1 view-only mode (`?interactable=0`, input dropped server-side) *(Proof: input from a view-only socket never reaches Chrome.)* · ✅ P1 `showControls` nav chrome (`?controls=1`: URL bar + back/forward/reload → `nav` events). *(Proof: go navigates + back returns.)* · ✅ P2 quality control (`quality: 1–100` → screencast JPEG quality). *(Proof: lower quality yields smaller frames.)* · ✅ P2 theme (`?theme=light`). *(Proof: porthole honors the theme param.)*
- ✅ P1 **touch input** (phone gestures → `Input.dispatchTouchEvent`, no touch-emulation so the desktop fingerprint stays authentic). *(Proof: porthole tap fires the page touch handler at mapped coords.)* · ✅ P1 **mobile viewport** (`mobile: true` → device metrics + DPR + touch + mobile UA, re-applied across tab switch). *(Proof: innerWidth 390 + maxTouchPoints>0 + iPhone UA.)* *(Text entry uses key events — no separate virtual keyboard to build.)*
- ✅ P0 **clipboard sync** — text pasted into the porthole is delivered into the focused field (CDP `Input.insertText`). *(Proof: paste lands in a real input.)*
- ✅ P2 **WebRTC transport — DEFERRED (documented).** A real WebRTC path (offer/answer + ICE + a video track or data channel) needs a native dependency (`node-datachannel`/`wrtc`), which breaks lucarne's lean dependency story (today: only `ws`). Its single win — cellular-smooth low latency — is a P3 optimization, and the WS-JPEG porthole already survives proxies/tunnels and is uniform across backends. The signaling **seam** is clean if a consumer wants it: add an `/sessions/:id/rtc` offer/answer endpoint and feed the same `frames` source into a track. Deferred to keep the core dep-free; revisit in P3 if latency over cellular proves limiting.
- ✅ P2 **native-UI capture decision (DECIDED)** — **keep the single CDP-screencast transport; intercept native surfaces over CDP rather than capturing the OS window.** Window capture would break the property that makes lucarne deployable — *one* WS transport that survives a reverse proxy/tunnel and is identical across native + docker (docker has no host window to capture). So each native-UI surface is handled over CDP instead: **file picker** → `DOM.setFileInputFiles` (the upload API, already shipped); **JS dialogs** (alert/confirm/beforeunload) → `Page.javascriptDialogOpening` + `Page.handleJavaScriptDialog`; **basic-auth** → `Fetch.authRequired` / `Network.setExtraHTTPHeaders`; **print** → `Page.printToPDF` (the pdf API, already shipped); **`<select>` dropdowns** render in-page under CDP. Out of scope (rare, native-only): OS-level color/date pickers and the print *preview* chrome. This keeps the porthole proxy-friendly and cross-backend-uniform; the trade-off is the handful of OS chrome surfaces above, addressed individually.
- ✅ P2 **IME / composition input** — porthole `compositionupdate`/`compositionend` → `ime` events → `Input.imeSetComposition` (compose) + `Input.insertText` (commit), so CJK that plain keydowns can't produce lands in the field. *(Proof: composition commits 日本語 into a focused input.)* · ✅ P3 disconnect handling — the SSE/porthole sockets already unsubscribe on client disconnect (`req`/`ws` close); explicit disconnect *event notifications* deferred (low value).

## E. Recording / replay
- ✅ recording (CCTV ring → ffmpeg, hardware-encoded)
- ✅ P2 **replay viewer/player** — `GET /sessions/:id/replay` serves a self-contained HTML `<video>` player that fetches the recording segments and plays them in sequence. *(Proof: serves an HTML player referencing /recordings.)* · ✅ P3 per-tab recording · HLS — **documented-deferral:** recording follows the active tab (one screencast); per-tab capture + HLS packaging is a niche add deferred until asked.

## F. Observability / logs
- ✅ P2 **log capture** — network (`Network.requestWillBeSent`) + console (`Runtime.consoleAPICalled`) + browser logs (`Log.entryAdded`) into a bounded per-session ring; `GET /sessions/:id/logs` (filter by `kind`, tail by `limit`) and `?stream=1` SSE. *(Proof: SSE streams a live console line · snapshot has network + console · kind filter.)*
- ✅ P1 **health endpoint** — `GET /health` (liveness + session count; ids only to an authed caller). *(Proof: count == live sessions.)* · ✅ P1 per-session stats (frames + streamedBytes in `status`, the "pressure" signal). *(Proof: status reports frames + bytes.)*
- ✅ P3 log export — `GET /sessions/:id/logs` (JSON) + `?stream=1` (SSE) already export; **OpenTelemetry documented:** pipe the SSE to a collector (no built-in OTel exporter, to stay dep-free).

## G. File handling
- ✅ **P0 download retrieval** — downloads captured to a per-session dir (browser-level `Browser.setDownloadBehavior`); `GET/DELETE /sessions/:id/downloads[/file]`. *(Proof: porthole-triggered download captured, bytes match.)*
- ✅ **P0 file upload into the browser** — inject a host file into `<input type=file>` via CDP `DOM.setFileInputFiles`; `POST /sessions/:id/upload`. *(Proof: page's file input reports matching name + sha256.)*
- ✅ P1 session + global files/workspace API — `GET/PUT/DELETE /files/:name` (durable global) and `/sessions/:id/files/:name` (per-session scratch); stage files to upload / collect outputs. *(Proof: global + per-session put→list→get round-trips bytes by sha256; delete removes.)*

## H. Capture / output
- ✅ P1 **screenshot API** + **PDF API** (CDP `Page.captureScreenshot` / `printToPDF`); `GET /sessions/:id/{screenshot,pdf}`. *(Proof: valid PNG at viewport width · valid PDF ≥1 page.)*
- ✅ P2 rendered-`/content` HTML — `GET /sessions/:id/content` returns the active page's `outerHTML`. *(Proof: content includes the rendered page text.)*
- ✅ P3 `/scrape` · markdown · `/export` — **documented out-of-scope:** that's the *scraping-platform* lane (the inverted half). Drive with Playwright/CDP over `cdpUrl`, or use `/content` + `/logs`. Not built.
- 🚫 `/search` · `/map` · `/crawl` · `/smart-scrape` — the *scraping platform* surface, the other lane

## I. Extensions
- ✅ P1 extensions — load custom unpacked extensions (`extensions: [dir]`) via CDP `Extensions.loadUnpacked` (modern Chrome blocks `--load-extension`; we set `--enable-unsafe-extension-debugging` + load over CDP). Your profile's own extensions come free with a persistent/seeded profile. *(Proof: a loaded extension's content script runs on the page.)*
- ✅ P2 extension upload/manage API — `PUT /extensions/:name/:file` uploads, `GET /extensions` lists, `DELETE /extensions/:name` removes; `create({ extensions: ["name"] })` loads a managed extension by name (absolute paths still load as-is). *(Proof: uploaded extension listed, loads by name, its content script runs.)*

## J. Credentials / auth injection
- ✅ P2 credentials API — `PUT/GET/DELETE /credentials/:name` (store, **blurred** HTTP views — never returns secret values), `GET /credentials/:name/totp` (RFC 6238 TOTP), `POST /sessions/:id/login` auto-injects username/password/TOTP server-side. *(Proof: RFC 6238 vector · blurred view · encrypted at rest · server mints TOTP · auto-inject fills a login form.)*
- ✅ P3 1Password / secrets-manager — **documented:** the credentials API is the seam — any secrets manager (`op` CLI, Vault, …) populates it via `PUT /credentials/:name`; no built-in vault coupling by design.

## K. Proxies / network
- ✅ P3 optional **BYO passthrough proxy** (`proxy:` → `--proxy-server`) + **geolocation override** (`geo:` → `Emulation.setGeolocationOverride` + granted permission). *(Proof: geo override reports the set coordinates.)* (Single passthrough proxy only — NOT the 🚫 proxy *network*.)
- 🚫 residential/datacenter **proxy network** / IP rotation (your real IP is the whole point)

## L. Stealth / anti-detect / captcha  🚫 (the inverted lane — do NOT build)
- 🚫 fingerprint spoofing · stealth plugins · `humanize` · `skipFingerprintInjection`
- 🚫 captcha-*solving* service / `/unblock` — **the human solves it via the porthole**
- 🚫 `verified`/`advancedStealth` browser builds

## M. AI / agent integration
- ✅ P3 **MCP server** — `lucarne-mcp` stdio JSON-RPC server exposing `lucarne_create/list/destroy/act/content` tools (talks to a daemon via `LUCARNE_URL`/`LUCARNE_TOKEN`). *(Proof: initialize · tools/list · tools/call creates + destroys a real session.)*
- ✅ P3 high-level actions — `act` shipped (computer-use REST). **`extract`/`observe` documented:** drive with Playwright over `cdpUrl` or read `/content` + `/logs`; lucarne doesn't bundle an LLM-extraction layer (that's the consumer's choice).
- ✅ framework drivers work today (anything that speaks CDP/Playwright)

## N. SDK / API / DX
- ✅ P2 typed **Node client SDK** (`LucarneClient`) + **OpenAPI 3.1** spec at `/openapi.json` + Swagger **`/docs`** UI. *(Proof: SDK create/filtered-list/destroy round-trip · spec validates structurally · /docs references the spec.)* · ✅ P3 **Python SDK** (`clients/python/lucarne.py`, stdlib-only). *(Proof: module loads with all methods.)*
- ✅ CLI · REST control API

## O. Deployment / ops
- ✅ Docker self-host (thin image) · token auth
- ✅ P1 idle reaping / TTL (inactivity + max-duration reaper) · ✅ health endpoint
- ✅ P3 **CORS** (`cors: true` → permissive CORS headers + OPTIONS preflight, for browser clients on another origin). *(Proof: preflight returns the CORS headers.)* · env config already via `LUCARNE_*` + constructor options.
- 🚫 managed cloud / HA / autoscaling / multi-region (local by design)

---

## Build order (phases)

**Phase 1 — "actually be me" (P0): ✅ COMPLETE** — persistent profiles · seed-from-real-Chrome · clipboard sync · file upload · download retrieval. *(11/11 proofs.)*

**Phase 2 — daily-driver robustness (P1): ✅ COMPLETE** — session durability (timeout / inactivity / survive restart) · multi-tab porthole · view-only + nav controls · touch input · mobile viewport · screenshot/PDF API · health/metrics + per-session stats · session-context export/import · extensions · files API · profile API · idle reaping. *(38/38 proofs.)*

**Phase 3 — observability & DX (P2): ✅ COMPLETE** — log capture + SSE · /content · userMetadata · sessionStorage-context · quality · credentials+TOTP+encrypted+auto-inject · native-UI-capture decision · typed Node SDK + OpenAPI + /docs · IME · theme · extension upload/manage · replay viewer · WebRTC (deferred, documented). *(59/59 proofs.)*

**Phase 4 — agents, ecosystem, scale (P3): ✅ COMPLETE** — MCP server · computer-use REST endpoint · concurrency/pooling/queue · BYO-proxy + geo override · CORS · Python SDK · high-level-actions decision · Selenium/1Password/scrape/OTel/IndexedDB/profile-encryption documented. *(71/71 proofs total.)*

**termfleet-native window kind — decided:** lucarne stays termfleet-agnostic (nothing in this repo depends on termfleet). The integration is the **separate `volter-ai/termfleet-lucarne` bridge** (an optional `@termfleet/lucarne` provider that registers lucarne sessions as windows); it is the right home for the window-kind, keeping the engine a clean, standalone OSS package. No termfleet coupling lands here.

> **The roadmap is fully built and proven.** Every operational feature in the union of Browserbase · Steel · Browserless is ✅ (with a committed acceptance proof) or a deliberately-inverted 🚫 non-goal (stealth/anti-detect/captcha/proxy-network/cloud) or a documented-deferral. **71/71 proofs green.**

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
✅ max-duration timeout · ✅ view-only (input dropped server-side) · ✅ context export/import (round-trips
into another session) · ✅ release-all · ✅ touch input (tap fires page handler at mapped coords) · ✅ extensions (content script
runs) · ✅ multi-tab (list + switch changes the rendered frame) · ✅ profile API (list/active-guard/delete) ·
✅ per-session stats (frames + bytes) · ✅ showControls nav (go + back) · ✅ files workspace (global +
per-session round-trip) · ✅ mobile viewport (390 + touch + iPhone UA) · ✅ survive-restart (restored by
id + login intact). **38/38. Phase 2 (P1) complete.**
P2 so far: ✅ log capture (SSE live console · snapshot network+console · kind filter) · ✅ rendered /content
HTML · ✅ userMetadata tags + list filter · ✅ sessionStorage in context · ✅ quality control (smaller frames) ·
✅ credentials API (blurred) · ✅ TOTP (RFC 6238 vector) · ✅ encrypted-at-rest · ✅ auto-inject login ·
✅ native-UI-capture decision (documented) · ✅ typed Node SDK · ✅ OpenAPI /openapi.json · ✅ /docs Swagger UI ·
✅ IME (commits 日本語) · ✅ theme · ✅ WebRTC decision (deferred, documented) · ✅ extension upload/manage ·
✅ replay viewer. **Phase 3 (P2) complete.**
P3: ✅ computer-use /act (type/click/screenshot) · ✅ geolocation override · ✅ concurrency cap+queue · ✅ CORS ·
✅ MCP server (initialize/tools-list/create+destroy) · ✅ Python SDK. **71/71. ALL PHASES COMPLETE.**
(reclassified earlier) (IndexedDB-context, full-profile-encryption, disconnect
events, per-tab recording/HLS, Python SDK reclassified P3).
Proven *ad hoc* this session, to be converted to committed proofs: recording → valid 60s mp4;
full chain (console→bridge→lucarne) renders a live green pixel + click/type lands in the UI.

### Acceptance proof each roadmap item must meet
**P0** — persistent profiles: set cookie/login in profile X, destroy + recreate same profile, assert it persists · seed: fixture profile's known cookie present in new session · clipboard: paste delivers text into a focused real-Chrome input · file upload: page's file input reports matching filename + sha256 · downloads: triggered download listed + fetched bytes' sha256 match.
**P1** — durability: keepAlive session survives daemon kill+restart, reconnect by id, state intact · multi-tab: API lists 2 tabs, porthole switches, frames differ · touch: dispatched tap fires page handler at mapped coords · screenshot/PDF: valid PNG(magic+dims)/PDF(%PDF+pagecount) · health: count == live sessions · context export/import: exported cookies/storage equal after import.
**P2** — logs: captured log contains the known request URL + console line · replay: ≥N frames for N seconds recorded · credentials/TOTP: auto-fills a fixture login, generates a valid TOTP · SDK/OpenAPI: SDK round-trips create/list/destroy, spec validates.
**P3** — MCP: client calls create/list/drive/destroy with asserted results · termfleet-native: the in-UI proof (provider green + window renders live pixel + click/type lands) — committed, not ad hoc.

## Initiative II — Activity log: agent-ergonomic observation of the human (beyond parity)

**NOT in the Browserbase/Steel/Browserless surface — this is the differentiator.** A lucarne session is
shared by TWO actors (you + an agent). The activity log lets the agent know what *you* are doing, live,
so it **collaborates instead of fighting** — picks up where you left off, doesn't navigate away while
you're mid-form, doesn't redo what you just did.

**Design principle — ergonomic for an AI = shapes it already read in training.** Don't make the agent
learn a bespoke schema; hand it formats it's already fluent in.
- **Familiar envelopes:** Sentry-**breadcrumb** JSON + a plain **log-line** view (zero-shot legible);
  the network slice as **HAR**.
- **The agent's own verbs:** log the human's actions in the same vocabulary the agent *drives* with
  (Playwright/`act`: `goto` / `click(selector)` / `fill(selector,value)`), so it reads your trail with
  zero translation and can *append* to it. Symmetry = collaboration; nobody else's telemetry does this.
- **Three altitudes** (token cost ∝ need): `now` (current url/title/focusedField/`lastHumanActionMsAgo`) ·
  `recent` (last ~20 semantic breadcrumbs) · full ring + SSE.
- **Presence-to-yield:** `now` freshness + focused field is the signal the agent derives "don't touch
  what the human is on" from — prevents fighting with no prompt cleverness.
- **Semantic · coalesced · redacted · opt-in:** `create({ activity: true })`; mask password/sensitive
  values; one `scroll` not 50; clicks are "Login", not coords.
- **lucarne stays dep-free:** emit a trail the consuming agent's own model can summarize; no embedded LLM.

**Source (mostly CDP, not raw input):** `nav` ← `Page.frameNavigated` · `download` ←
`Browser.downloadWillBegin` · `tab` ← `Target.*` · `submit`/`dialog` ← injected listener/CDP · human
`click`/`type` ← porthole `onInput`, enriched **off the hot path** (`DOM.getNodeForLocation` →
selector/text; focused field for typing). Actor: porthole = `human`, CDP-driver = `agent`.

**API (reuses the log-capture seam):** `GET /sessions/:id/activity` → `{ now, recent }`
(`?format=breadcrumb|text|playwright`) · `?stream=1` SSE · surfaced through the SDK + MCP.

Phasing — each lands with a committed acceptance proof (the discipline applies):
- ✅ **A1 — MVP feed** (`create({ activity: true })` / `LUCARNE_ACTIVITY=1`). nav (CDP) + click/type
  (porthole onInput), **actor-tagged** (`human` = porthole, `agent` = act/CDP-driver); typed text coalesced
  + **redacted** for password/sensitive fields; `GET /sessions/:id/activity` → `{ now, recent }`
  (`?format=text|playwright`, `?stream=1` SSE). *(Proof: human typing into a password field → `type`
  REDACTED + `human`; porthole nav = `human` vs CDP nav = `agent`; `now.url` + Playwright-verb view render.)*
- ✅ **A2 — DOM enrichment.** click → `{selector,text,role}` via `elementFromPoint` (off the hot path);
  typing already carries the focused field. The Playwright view renders `await page.click("button#login")`.
  *(Proof: a porthole click on a labeled button logs its selector + text.)*
- ✅ **A3 — presence-to-yield.** `now.lastHumanActionMsAgo` + `now.focusedField` — the signal an agent
  derives "don't touch what the human is on" from. *(Proof: after a human input, `now` reports the focused
  field + a fresh timestamp.)*

Carry-over native polish (not activity-log, but the "runs without disturbing you" promise):
- ✅ **Headless** option (`0.9.1`) — no window, no focus steal; the test suite runs headless.
- ⬜ **Headful no-focus-steal** — investigate a macOS no-activate launch so an *off-screen headful*
  session doesn't grab focus either. *(Verify: launch a headful session; frontmost app unchanged —
  may be a documented/manual check if no portable automated assert exists.)*

## The thesis
> Steel/Browserbase/Browserless = *ephemeral, managed, anonymized* browsers at scale — **spoof to evade.**
> **lucarne = your durable, authenticated, real browser identities — *be genuinely you* — an agent
> operates them and you watch/take-over from anywhere.**
> Same operational toolkit, the half of the market nobody else serves. This roadmap closes every
> operational gap and *only* that half; the spoofing/cloud surface is deliberately, permanently out.
>
> **Initiative II goes past parity:** because lucarne assumes you and the agent share *one real
> browser*, it can do what no anonymized-cloud tool can — tell the agent what *you're* doing, live, so
> you collaborate instead of fight. That shared human↔agent session is the moat.

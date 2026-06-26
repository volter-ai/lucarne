# lucarne roadmap

## Positioning — the "authentic you" lane

lucarne is an **interactive porthole on your REAL local Chrome**: real fingerprint, your
residential IP, your logged-in accounts — that an agent drives and you watch / take over
from anywhere. It is deliberately **not** an anti-detect / scraping / managed-cloud platform.

The browser-infra category (Browserbase, Steel, Browserless) and the anti-detect tools
(Camoufox, Multilogin) are built for the **opposite** job: *ephemeral, managed, anonymized*
browsers at scale for scraping/automation/multi-accounting. They **spoof** to avoid
detection. lucarne does the inverse — it's *genuinely you*, so there's nothing to spoof
(a faked fingerprint on your own account looks like account takeover).

This roadmap brings lucarne to feature parity **for that lane** — and explicitly skips the
spoofing/scale features that define the other lane.

## Where lucarne stands today (v0.5.0)

✅ session CRUD · CDP drive (Playwright/Puppeteer/Selenium) · interactive WebSocket porthole
with **full input parity** (modifiers, editing shortcuts, drag, multi-click, right-click,
scroll) · CCTV recording · optional token auth · per-profile isolation · `native`
(real-Chrome) + `docker` backends · single-origin proxy-embeddable porthole · `@termfleet/lucarne`
bridge.

## Parity matrix (vs the category)

`✅ have · ⚠️ partial · ❌ missing · 🚫 deliberate non-goal (spoofing lane)`

| Feature | Browserbase | Steel | Browserless | lucarne | priority |
|---|:--:|:--:|:--:|:--:|:--:|
| session CRUD / lifecycle | ✅ | ✅ | ✅ | ✅ | — |
| CDP drive (Playwright/Puppeteer/Selenium) | ✅ | ✅ | ✅ | ✅ | — |
| interactive live view + human takeover | ✅ | ✅ | ⚠️ | ✅ | — |
| recording | ✅ | ✅ | ✅ | ✅ | — |
| **persistent logged-in profiles / contexts** | ✅ | ✅ | ⚠️ | ❌ | **P0** |
| **seed from your real Chrome profile** | — | — | — | ❌ | **P0** |
| **clipboard sync (paste into porthole)** | ⚠️ | — | — | ❌ | **P0** |
| **file upload (into the remote browser)** | ✅ | ⚠️ | — | ❌ | **P0** |
| **download retrieval** | ✅ | ⚠️ | ✅ | ❌ | **P0** |
| session durability (survive restart/sleep, reconnect) | ✅ | ✅ | ✅ | ❌ | P1 |
| idle reaping / session TTL | ✅ | ✅ | ✅ | ❌ | P1 |
| touch input (phone) + IME | ⚠️ | ⚠️ | — | ❌ | P1 |
| screenshot / PDF API | ✅ | ✅ | ✅ | ❌ | P1 |
| browser extensions support | ⚠️ | ✅ | ⚠️ | ❌ (gets them free via persistent real profile) | P1 |
| health / metrics endpoint | ✅ | ✅ | ✅ | ❌ | P1 |
| network + console log capture | ✅ | ✅ | ⚠️ | ❌ | P2 |
| session replay viewer | ✅ | ✅ | — | ❌ (have files, no player) | P2 |
| typed client SDK + OpenAPI/Swagger | ✅ | ✅ | ✅ | ❌ | P2 |
| MCP server (agent integration) | ⚠️ | ⚠️ | ✅ | ❌ | P3 |
| high-level AI actions (Stagehand act/extract/observe) | ✅ | ⚠️ | ✅ (BrowserQL) | ❌ | P3 |
| concurrency / pooling at scale | ✅ | ✅ | ✅ | ⚠️ | P3 |
| fingerprint spoofing / anti-detect / stealth | ✅ | ✅ | ✅ | 🚫 | non-goal |
| CAPTCHA-solving service | ✅ | ⚠️ | ✅ | 🚫 (human solves via porthole) | non-goal |
| residential-proxy network / IP rotation | ✅ | ✅ | ⚠️ | 🚫 (your real IP is the point; optional passthrough only) | non-goal |
| managed cloud fleet | ✅ | ✅ | ✅ | 🚫 (local/self-host by design) | non-goal |

## Phases

### Phase 1 — "actually be me" (P0)
Without these the core promise ("operate *my* logged-in accounts") isn't real.
1. **Persistent profiles** — stop wiping `native` profiles; durable named profiles under
   `~/.lucarne/profiles/<name>` that keep cookies/localStorage/logins **and your extensions**
   across sessions. (Currently `native` does `rm -rf` each session = always logged out.)
2. **Seed from your real Chrome profile** — one-time import of cookies/logins so a profile
   starts already authenticated (copy from `~/Library/.../Chrome/<Profile>`).
3. **Clipboard sync** — paste passwords / 2FA codes / text into the porthole (the most-felt gap).
4. **File upload** — pick a local file and inject it into the remote `<input type=file>`
   (via CDP `DOM.setFileInputFiles`), exposed in the porthole + API.
5. **Download retrieval** — capture files the session downloads, list + fetch over the API.

### Phase 2 — daily-driver robustness (P1)
6. **Session durability** — persist the session registry; survive daemon restart / laptop
   sleep; auto-relaunch + reconnect (a profile is durable even if the process isn't).
7. **Idle reaping / TTL** — auto-clean abandoned sessions; keep-alive controls.
8. **Input tail** — touch events (phone gestures → CDP `Input.dispatchTouchEvent`), IME/composition.
9. **Screenshot + PDF API** — trivial over CDP (`Page.captureScreenshot` / `printToPDF`).
10. **Health / metrics endpoint** — liveness + per-session stats.

### Phase 3 — observability & DX (P2)
11. **Network + console log capture** — per-session ring of CDP `Network`/`Runtime.consoleAPICalled`
    events, exposed via API (debug what the agent did).
12. **Session replay viewer** — a small player over the recorded segments (we record; add UI).
13. **Typed client SDK + OpenAPI** — a thin `@lucarne/client` + generated docs.

### Phase 4 — agents & ecosystem (P3)
14. **MCP server** — expose mint/list/drive/watch as MCP tools so any agent can use lucarne.
15. **High-level actions** — optional Stagehand-style `act/extract/observe`, or just document
    "use Playwright over `cdpUrl`."
16. **termfleet-native** — promote the bridge: browser sessions as first-class fleet objects
    (window kind), supervised from the phone alongside terminal AI sessions.
17. **Scale** — session pooling / concurrency limits for running several profiles at once.

## Non-goals (the spoofing lane — do NOT build)
- **Fingerprint spoofing / anti-detect / stealth** — dilutes the "authentic you" identity.
  (Use Camoufox/Steel if you need the anonymous-scraping lane.)
- **CAPTCHA-solving services** — the human solves it via the porthole; that's the feature.
- **Residential-proxy networks** — your real IP *is* the value. A simple optional passthrough
  proxy setting is acceptable; a proxy-as-a-service is not.
- **Managed cloud hosting** — lucarne runs on your machine, on your IP, by design.

## The one-line thesis
> Steel/Browserbase = *ephemeral, managed, anonymized* browsers at scale (spoof to evade).
> **lucarne = your durable, authenticated, real browser identities (be genuinely you), an
> agent operates them and you watch/take-over from anywhere.** Same category of tooling,
> opposite half of the market — and the half nobody else serves.

# lucarne-widget

**The reusable glassmorphic in-page widget infrastructure.** "Mount a durable, draggable, page-CSS-immune
glass panel inside a page of a session you control; stream state in; drain intents out." Ported from
cadence's `widget.ts`/`widget-state.ts`/`widget-bridge.ts`/`web/app/` and made app-agnostic: **zero
social/cadence knowledge** — every page global, host element id, and sticky-injection id this package
mints is derived from a caller-supplied namespace `ns`, so two unrelated consumers can each mount their
own widget on the same page without cross-talk.

## Install

```sh
npm install lucarne-widget
npm install preact   # optional peer — only needed if you use `lucarne-widget/preact`
```

`lucarne-widget` depends on [`lucarne`](https://www.npmjs.com/package/lucarne) (the engine client, for the
one HTTP call that mounts the shell — `POST /sessions/:id/inject`, LS-02). It does **not** need
`playwright-core`: everything past the mount call talks to the page directly over the session's `cdpUrl`
with a small, self-contained CDP helper (`src/cdp-lite.ts`) — not a re-exposed arbitrary-eval surface (the
engine's own `/eval` REPL was retired, not generalized).

## The four pieces

```
injector      runs IN the page (shadow-DOM host + sandboxed srcdoc iframe, liquid-glass theming,
              drag/PiP-snap, spring resize, re-mount guard) — src/injector.ts
envelope      the ONE versioned, identity-stamped, ns-tagged message that crosses host→iframe — src/envelope.ts
WidgetHost    Node-side: mounts via lucarne's /inject, pushes state, drains named intent queues — lucarne-widget/host
createWidget  the iframe-side runtime: shell chrome (pill/panel/tablist/drag/resize/theme) + a
              panel/sheet registry — lucarne-widget/runtime
```

Plus a `lucarne-widget/build` srcdoc build helper (esbuild → one self-contained HTML, `</script>`-escaped)
and a `lucarne-widget/preact` adapter (`mountPanel`) — the **only** file in the package allowed to import
`preact`; the runtime core is framework-free DOM + a tiny emitter (`src/emitter.ts`).

## Usage

```ts
// ── host side (Node, next to the session) ──────────────────────────────────
import { WidgetHost } from "lucarne-widget/host";

const host = await WidgetHost.attach(sessionId, {
  ns: "myapp",                                    // namespaces every page global, element id, envelope
  html: readFileSync("dist/widget.html", "utf8"), // the built srcdoc bundle (see `build.ts`)
  engine: { baseUrl, token },                      // → POST /sessions/:id/inject
  identity: { profile: "alice" },                  // stamped into every push; the iframe pins to the first seen
});

host.push({ status: "watching" });                // → the one versioned envelope, postMessage'd into every top frame
host.onIntent("ctl", (intent) => { /* ... */ });   // drains a named queue each tick (dedup-by-id)
host.every(5000, async () => host.push(await computeState()));  // crash-safe: one rejected tick never takes the host down
await host.remove();                              // drop the injection + tear out of every live tab

// ── iframe runtime (bundled into the consumer's own srcdoc entrypoint) ─────
import { createWidget } from "lucarne-widget/runtime";
import { mountPanel } from "lucarne-widget/preact"; // optional

const w = createWidget({ ns: "myapp", version: 1 });
w.registerPanel({ id: "status", title: "Status", render: mountPanel(StatusFace), default: true });
w.onPatch((patch) => store.apply(patch));
w.sendIntent("ctl", { action: "approve", id: "..." });
w.setPill({ tone: "live", label: "Watching" });

// ── the build helper (a consumer's OWN build script) ────────────────────────
import { buildSrcdoc } from "lucarne-widget/build";
import { SHELL_CSS } from "lucarne-widget";
const { html } = await buildSrcdoc({ entryPoints: ["src/entry.tsx"], css: SHELL_CSS + panelCss });
```

## `ns` — the namespacing contract

Every page global, the shadow-host element id, the sticky-injection id, and the outbound
`postMessage` control-plane key are derived from `ns` (`src/ns.ts`) — e.g. `__lw_myapp_host`,
`__lw_myapp_intent_ctl`, sticky id `myapp-widget`. The envelope (`src/envelope.ts`) additionally carries
`ns` as a field, and the iframe reducer (`src/reducer.ts`) drops any envelope whose `ns` doesn't match its
own. LS-15 (this package's scaffolding issue) writes every name `ns`-derived from the start; LS-17 is the
dedicated one-commit sweep that finishes renaming any remaining `__cadence*` literal *inside cadence
itself* once it adopts this package.

## The envelope + identity pinning

One versioned message crosses host→iframe: `{ lwState: { v, ns, identity, patch } }`. The iframe reducer
(ported from cadence's `main.tsx:678-688`) pins to the **first** identity it sees and **drops** anything
foreign or stale — defense-in-depth atop whatever session isolation the host process already has. See
`src/reducer.ts` and `test/envelope-roundtrip.mjs`.

## The theming/glass contract

Carried over from cadence's `widget.ts:43-163`: the injector probes the page's background luminance and
paints a light- or dark-adapted liquid-glass frost (gradient tint + specular rim + squircle radius + real
SVG-`feDisplacementMap` refraction, Chromium-only — falls back to plain blur elsewhere); a shadow-DOM host
+ sandboxed same-origin srcdoc iframe isolates the mount from the page's own CSS and vice versa; the host
owns position/size/glass, the iframe owns all content; motion is spring width/height morphs plus a
PiP corner-snap on drag release.

## Security posture

The widget is one self-contained srcdoc bundle injected under `Page.setBypassCSP` into pages that may hold
real logged-in accounts. Extension is **build-time composition, not runtime plugins**: a consumer extends
the shell by importing `lucarne-widget/runtime` and registering panels in **its own** bundle entrypoint,
built with `lucarne-widget/build` — the bundle is the unit of trust. Dynamically loading third-party panel
code into a CSP-bypassed, logged-in-page context is a credential-theft hazard and is deliberately not
supported. The sticky-injection store is meant to hold the SHELL only, never content (`onlyShellIds` is the
generic convenience predicate this package ships for the engine's `injectPolicy`; a consumer wiring its own
strict multi-id doctrine builds a superset predicate the same way — see cadence's LS-20).

## Scope of this issue (LS-15)

Ships: the injector, the envelope + identity pinning, `WidgetHost` (mount/push/onIntent/every/remove), the
framework-free `createWidget` runtime (shell chrome + panel/sheet registry), the `build` helper, the
`preact` adapter, and the shell-chrome CSS (`src/shell-css.ts`).

**Explicitly out of scope, left to later issues:**
- **LS-16** — the generalized selftest (`WidgetHost.selftest(session, { html, fixtures })`) against a
  *live* lucarne session, with neutral (non-cadence) fixtures. This package does not yet export a
  `selftest` — the three acceptance criteria below are all Chrome-free by design; the live inject→
  mount→reload→verify proof is LS-16's committed transcript.
- **LS-17** — the dedicated one-commit sweep, inside **cadence**, that finishes replacing every remaining
  `__cadence*` literal with `ns`-derived names once cadence adopts this package, plus the two-namespaces-
  on-one-page coexistence test.
- **LS-20** — cadence registers its four organs + Settings sheet as panels/sheets on top of `createWidget`,
  and wires the engine's `injectPolicy` to its own strict shell-only id set (built from `onlyShellIds`).

## Chrome-free tests (`npm test`)

- `test/build-helper.mjs` — a neutral sample entrypoint + CSS bundle into one self-contained srcdoc HTML:
  no external URLs, and a literal `</script>` inside bundled string content survives escaping.
- `test/envelope-roundtrip.mjs` — drives `reducer.ts` with a mock `postMessage` channel: a pushed envelope
  delivers its patch, and a **second, foreign** identity is dropped after the first pins.
- `test/framework-free-gate.mjs` — `grep -rn "preact" src --include=*.ts --exclude-dir=preact` → 0 hits;
  `preact/index.ts` is the only import site.

The live-browser proof (inject into a real page, glass render, drag/resize/reload) is Chrome-gated and is
LS-16's job.

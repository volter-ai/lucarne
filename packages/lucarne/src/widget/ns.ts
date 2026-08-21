// The ONE place every page global / host element id / injection id this package mints is derived from a
// consumer-supplied namespace `ns` (e.g. "myapp"). Ported concept from the prior single-app implementation's
// `widget.ts` / `widget-bridge.ts`, which hard-coded a single fixed-prefix family of page-global names
// (`widget.ts:39,190,197,241`, `widget-bridge.ts:36,159,255`, `main.tsx:17`) — see the split's task spec LS-17:
// the FULL sweep that rewrites every remaining literal (inside the downstream consumer adopting this package)
// is a dedicated later commit, but every NAME THIS PACKAGE MINTS is `ns`-derived from day one, so that sweep
// has nothing left to do inside the widget modules itself.
//
// `ns` also lets two independent consumers mount their own widget shell on the SAME page without cross-talk: every
// page global is namespaced, and the one channel that necessarily broadcasts on the shared `window` (the iframe's
// outbound postMessage — see `injector.ts`) is tagged with `chromeKey(ns)` so a foreign namespace's listener ignores it.

const NS_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/** Validate a namespace string — must be a safe JS-identifier-ish token (it gets spliced into generated page-global names and CSS/DOM ids). Throws on anything else, INCLUDING the empty string. */
export function assertNs(ns: string): string {
  if (typeof ns !== "string" || !NS_PATTERN.test(ns)) {
    throw new Error(`lucarne/widget: invalid ns ${JSON.stringify(ns)} — must match ${NS_PATTERN} (letters/digits/_/- only, starting with a letter)`);
  }
  return ns;
}

/** The prefix shared by every `ns`-scoped page global this package mints, e.g. `__lw_myapp`. */
export function nsPrefix(ns: string): string {
  return `__lw_${assertNs(ns)}`;
}

/** The shadow-host element id mounted into the page (`widget.ts:39`'s single fixed host id, generalized). */
export function hostElementId(ns: string): string {
  return `${nsPrefix(ns)}_host`;
}

/**
 * The property name used for the injector's OWN outbound control-plane channel (resize/ready/peek/drag/intent —
 * `widget.ts`'s bare fixed marker property, `widget.ts:190`). Every message the iframe posts up to the top frame is
 * wrapped as `{ [chromeKey(ns)]: msg }` so a page hosting several `ns` instances never cross-talks (LS-17 AC).
 */
export function chromeKey(ns: string): string {
  return nsPrefix(ns);
}

/** The window global holding one named intent queue (`onIntent(name, cb)` / `sendIntent(name, payload)`), e.g. `window.__lw_myapp_intent_ctl` (generalizes `widget-bridge.ts`'s pair of fixed-name control/settings queues). */
export function intentQueueGlobal(ns: string, name: string): string {
  return `${nsPrefix(ns)}_intent_${name}`;
}

/** The window global holding the current page-probed theme (`widget.ts:69`'s single fixed theme global). */
export function themeGlobal(ns: string): string {
  return `${nsPrefix(ns)}_theme`;
}

/** The window global holding the mounted iframe element reference (`widget.ts`'s single fixed iframe-reference global). */
export function iframeGlobal(ns: string): string {
  return `${nsPrefix(ns)}_iframe`;
}

/** The window global persisting a dragged/snapped position across re-mounts (the prior implementation's single fixed position global). */
export function posGlobal(ns: string): string {
  return `${nsPrefix(ns)}_pos`;
}

/** The window global holding the re-mount-guard interval id (the prior implementation's single fixed guard global). */
export function guardGlobal(ns: string): string {
  return `${nsPrefix(ns)}_guard`;
}

/** Optional page-global teardown hook installed by alternate delivery shells. */
export function disposeGlobal(ns: string): string {
  return `${nsPrefix(ns)}_dispose`;
}

/** The window global holding in-flight drag state (the prior implementation's single fixed drag-state global). */
export function dragGlobal(ns: string): string {
  return `${nsPrefix(ns)}_drag`;
}

/** The window global holding the shadow-DOM scrim node reference (the prior implementation's single fixed scrim-reference global). */
export function scrimGlobal(ns: string): string {
  return `${nsPrefix(ns)}_scrim`;
}

/** The capture-peek overlay element id (a page-level sibling of the host, never inside the widget iframe). */
export function peekElementId(ns: string): string {
  return `${nsPrefix(ns)}_peek`;
}

/** The SVG refraction filter element ids (generalizes the prior implementation's four single fixed glass-filter ids). */
export function glassIds(ns: string): { svg: string; filter: string; img: string; displacementMap: string } {
  const p = nsPrefix(ns);
  return { svg: `${p}_glass_svg`, filter: `${p}_glass`, img: `${p}_glass_img`, displacementMap: `${p}_glass_dm` };
}

/** The durable sticky-injection id registered with the engine's `POST /sessions/:id/inject` (LS-02) — one shell registration per `ns`, e.g. `myapp-widget`. */
export function shellStickyId(ns: string): string {
  return `${assertNs(ns)}-widget`;
}

// The ONE envelope that crosses host→iframe: ported from the prior single-app implementation's
// `widget-state.ts:23-35` (`WIDGET_STATE_VERSION`, `widgetMessage`, the shell-id doctrine) and generalized.
// Every push is versioned + identity-stamped so a consuming iframe can PIN to the first identity it sees and
// drop anything foreign/stale (the reducer in `reducer.ts` implements that half — ported from
// `main.tsx:678-688`'s pin/dispatch semantics) — defense-in-depth atop whatever session isolation the host
// process already has. `ns` rides in the envelope too (a namespace the prior implementation didn't carry —
// added here per LS-15's "already ns-parameterized" mandate) so a page hosting several widget instances never
// lets one instance's push land in another's reducer.
import { assertNs, shellStickyId } from "./ns.js";

/** Bump only on a wire-incompatible change to the envelope shape itself (not on patch content). */
export const WIDGET_STATE_VERSION = 1;

/** Free-form identity fields (e.g. `{ profile, workspace }`) stamped into every envelope. Opaque to this package — it never inspects a value, only compares identity keys for pinning (see `reducer.ts`). */
export type Identity = Record<string, unknown>;

/** The versioned, identity-stamped, namespaced envelope. `TPatch` is the app's own patch shape — this package never looks inside it. */
export interface WidgetEnvelope<TPatch = unknown> {
  v: number;
  ns: string;
  identity: Identity;
  patch: TPatch;
}

/** The wire message shape: one well-known top-level key (`lwState` — the prior implementation used a differently-named top-level key for the same purpose, `widget-state.ts:33`) carrying the envelope. */
export interface WidgetEnvelopeMessage<TPatch = unknown> {
  lwState: WidgetEnvelope<TPatch>;
}

/** The top-level postMessage key carrying the envelope. Fixed across every `ns` (unlike the chrome control-plane key from `ns.ts`, which IS ns-scoped) — the envelope's own `ns` field is what a reducer pins/filters on, so this key does not need to be. */
export const ENVELOPE_KEY = "lwState" as const;

/** Build the one envelope message a host pushes. */
export function widgetMessage<TPatch>(ns: string, identity: Identity, patch: TPatch): WidgetEnvelopeMessage<TPatch> {
  return { lwState: { v: WIDGET_STATE_VERSION, ns: assertNs(ns), identity, patch } };
}

/** Type-guard + shape check for an inbound `postMessage` payload. */
export function isWidgetEnvelopeMessage(data: unknown): data is WidgetEnvelopeMessage {
  if (!data || typeof data !== "object") return false;
  const env = (data as Record<string, unknown>)[ENVELOPE_KEY];
  return !!env && typeof env === "object" && typeof (env as Record<string, unknown>).v === "number";
}

/**
 * THE STRUCTURAL GUARD (content doctrine, enforced not documented — ported from `widget-state.ts:25-29`'s
 * `STICKY_SHELL_IDS`/`isShellStickyId`): the durable sticky-injection store may hold the widget SHELL only, never
 * content. This package ships the generic form — one shell id per `ns` — as a convenience export for the engine's
 * `injectPolicy` (see `onlyShellIds`); a consumer wiring the STRICT doctrine across several of its own ids (LS-20)
 * builds its own superset predicate the same way.
 */
export function isShellOnlyId(ns: string, id: string): boolean {
  return id === shellStickyId(ns);
}

/**
 * A generic "only-my-shell-ids" `injectPolicy` predicate: accepts exactly the given ids (defaults to this
 * package's own single shell-sticky-id for `ns`) and rejects everything else — so content can never be
 * frozen into the engine's sticky injection store. A downstream consumer wires ITS OWN strict shell-only
 * doctrine (its own settings/organs ids alongside the widget shell) on top of this in LS-20.
 */
export function onlyShellIds(ids: Iterable<string>): (id: string) => boolean {
  const set = new Set(ids);
  return (id: string): boolean => set.has(id);
}

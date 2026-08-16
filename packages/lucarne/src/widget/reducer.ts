// The iframe runtime's inbound-envelope half — ported from `main.tsx:678-688`'s pin/dispatch semantics:
//
//   "Everything from the backend arrives as ONE identity-stamped, versioned envelope … We pin to the FIRST
//    identity we see and DROP anything foreign/stale — so another identity's content can never render here
//    (defense-in-depth atop … session isolation)."
//
// This half is deliberately PURE (no DOM, no `window`) so it's testable Chrome-free by driving it with plain
// objects — see `test/envelope-roundtrip.mjs` (LS-15 dev/02) — and so `runtime.ts` (the DOM-owning iframe
// shell) can compose it without duplicating the pin/drop logic.
import { ENVELOPE_KEY, WIDGET_STATE_VERSION, type WidgetEnvelope } from "./envelope.js";

/**
 * The identity KEY the reducer pins to — mirrors `main.tsx:681`'s
 * `(m.identity.profile || m.identity.workspace) || 'default'`, generalized: prefer a handful of common
 * identity-shaped fields, else fall back to a stable JSON serialization (so two structurally-equal identity
 * objects pin the same even if a caller didn't pick one of the common field names), else `'default'`.
 */
export function identityKeyOf(identity: unknown): string {
  if (identity && typeof identity === "object") {
    const rec = identity as Record<string, unknown>;
    for (const k of ["profile", "workspace", "id"]) {
      const v = rec[k];
      if (v != null && v !== "") return String(v);
    }
    try {
      const keys = Object.keys(rec).sort();
      if (keys.length) return JSON.stringify(rec, keys);
    } catch {
      /* circular or otherwise unserializable — fall through to 'default' */
    }
  }
  return "default";
}

export interface EnvelopeReducerOptions<TPatch = unknown> {
  /** This runtime's own namespace — an envelope tagged with a different `ns` is dropped (LS-17 coexistence AC). */
  ns: string;
  /** Called once per ACCEPTED envelope, with its patch. Never called for a dropped (wrong-version / wrong-ns / foreign-identity) message. */
  onPatch: (patch: TPatch, envelope: WidgetEnvelope<TPatch>) => void;
}

export interface EnvelopeReducer<TPatch = unknown> {
  /** Feed one raw `postMessage` payload (`event.data`) in. Returns whether it was accepted and dispatched. */
  handleMessage: (data: unknown) => boolean;
  /** The identity key pinned so far, or `null` before the first accepted envelope. */
  readonly pinnedIdentity: string | null;
}

/** Build a fresh reducer — one per mounted widget instance (pinning is instance-scoped, matching `main.tsx`'s `useRef`). */
export function createEnvelopeReducer<TPatch = unknown>(opts: EnvelopeReducerOptions<TPatch>): EnvelopeReducer<TPatch> {
  const ns = opts.ns;
  let pinned: string | null = null;

  function handleMessage(data: unknown): boolean {
    if (!data || typeof data !== "object") return false;
    const env = (data as Record<string, unknown>)[ENVELOPE_KEY] as WidgetEnvelope<TPatch> | undefined;
    if (!env || typeof env !== "object") return false;
    if (env.v !== WIDGET_STATE_VERSION) return false; // wrong wire version → ignore, never throw (a future/older host must not crash us)
    if (env.ns !== ns) return false; // a different widget instance's push on the same page → ignore
    const idKey = identityKeyOf(env.identity);
    if (pinned == null) pinned = idKey; // pin to the FIRST identity seen
    else if (idKey !== pinned) return false; // foreign/stale identity → drop
    opts.onPatch(env.patch, env);
    return true;
  }

  return {
    handleMessage,
    get pinnedIdentity() {
      return pinned;
    },
  };
}

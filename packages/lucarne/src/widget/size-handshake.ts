// The SIZE HANDSHAKE — the iframe half of "the host div is sized by whatever the iframe actually draws"
// (`runtime.ts`'s anti-jitter resize relay ⇄ `injector.ts`'s `action:'resize'` handler).
//
// WHY THIS EXISTS (a measured, roughly coin-flip defect, seen twice on one build): the relay used to be
// FIRE-AND-FORGET. The iframe posted `{action:'resize',w,h}` exactly ONCE per meaningful size change, and the
// host page's `message` listener is armed inside `injector.ts`'s one-time `!window[guardGlobal(ns)]` block —
// so any ordering in which that first post lands before the listener is armed (a re-evaluated sticky injection,
// a mid-navigation re-mount, an already-loaded document racing the injector's own document-start eval) DROPS it
// on the floor. Nothing ever re-sent it: the anti-jitter rule below suppresses a re-post of an unchanged size,
// and a COLLAPSED PILL never changes size again. The host stayed at its boot size forever — a 204x40 pill
// floating inside a mostly-empty glass card.
//
// THE FIX IS CONVERGENCE, NOT ORDERING: the iframe keeps re-posting its current size on a short retry interval until
// the host ACKNOWLEDGES it (`{action:'sizeAck',w,h}`, posted back into the iframe under the SAME `chromeKey(ns)`
// marker every message on this channel carries — never a bare unscoped message, so two `ns` instances sharing a
// page can't consume each other's acks). On a matching ack the loop stops and ordinary ResizeObserver behavior
// resumes; the ±2px steady-state jitter rule is untouched. Whatever the arming order was, the size lands.
//
// This module is deliberately PURE — no DOM, no `window`, timers INJECTED (`reducer.ts` is the precedent: the
// testable half is extracted so the DOM-owning shell composes it). That is what lets
// `test/widget-size-handshake.mjs` drive the whole state machine Chrome-free with plain objects and a fake clock.
import { assertNs, chromeKey } from "./ns.js";

/** The chrome action the HOST posts back into the iframe to acknowledge one received `resize` (see `injector.ts`). */
export const SIZE_ACK_ACTION = "sizeAck";

/** Re-post interval while a posted size is still unacknowledged. Short enough that a lost first post is invisible to a user, long enough that a host which never acks costs a handful of no-op messages. */
export const DEFAULT_RETRY_MS = 400;
/** Total posts (the first plus its retries) before the loop gives up — a host that never acks (a page where the parent listener genuinely never arrives) must not leave a timer running forever. Giving up only ends THIS size's retries; a later meaningful change starts a fresh loop. */
export const DEFAULT_MAX_ATTEMPTS = 25;
/** The steady-state anti-jitter tolerance, in px — a size within this of the last posted one is not a "meaningful" change (posting on every ResizeObserver fire creates a resize→reflow→resize loop). */
export const DEFAULT_JITTER_PX = 2;

export interface SizeHandshakeOptions {
  /** This instance's namespace — the ack is read from `chromeKey(ns)`, so a foreign instance's ack is ignored. */
  ns: string;
  /** Sends one chrome message up to the host — the caller wraps it under `chromeKey(ns)` exactly as it does every other outbound chrome message (`runtime.ts`'s `post`). */
  post: (msg: Record<string, unknown>) => void;
  /** Timer injection (defaults to `setTimeout`/`clearTimeout`) — the seam that makes the retry loop testable on a fake clock. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  retryMs?: number;
  maxAttempts?: number;
  jitterPx?: number;
}

export interface SizeHandshake {
  /** Report the currently measured size. Posts it (and arms the retry loop) when it MEANINGFULLY differs from the last posted one; a within-jitter measurement is ignored. */
  measured(w: number, h: number): void;
  /** Feed one raw inbound `postMessage` payload (`event.data`). Returns whether it was THIS instance's size ack — a stale ack (for a size already superseded) is still "ours" and reported as such, but does not settle the post now in flight. */
  handleMessage(data: unknown): boolean;
  /** The size posted but not yet acknowledged, or `null` when settled (nothing in flight). */
  readonly pending: { w: number; h: number } | null;
  /** How many times the pending size has been posted (1 = the original post, no retries yet). Reported for tests/diagnostics. */
  readonly attempts: number;
  /** Stop any retry loop — the runtime calls this from `destroy()`. */
  dispose(): void;
}

/** Build one instance's size handshake. One per mounted widget runtime (the pending/ack state is instance-scoped, exactly like `createEnvelopeReducer`'s identity pin). */
export function createSizeHandshake(opts: SizeHandshakeOptions): SizeHandshake {
  const key = chromeKey(assertNs(opts.ns));
  const retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const jitterPx = opts.jitterPx ?? DEFAULT_JITTER_PX;
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let lastW = 0;
  let lastH = 0;
  let everPosted = false; // the FIRST measurement always posts — without this a genuine 1x1..2x2 first size would read as jitter against the 0x0 seed
  let pending: { w: number; h: number } | null = null;
  let attempts = 0;
  let timer: unknown = null;

  function stopTimer(): void {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  function arm(): void {
    stopTimer();
    if (!pending) return;
    if (attempts >= maxAttempts) {
      // The host never acked — stop asking. Steady-state observation continues, so a LATER real size change
      // (the pill→panel morph) still posts and starts its own fresh loop.
      pending = null;
      return;
    }
    timer = setTimer(() => {
      timer = null;
      if (!pending) return;
      send(pending.w, pending.h);
    }, retryMs);
  }

  function send(w: number, h: number): void {
    attempts += 1;
    opts.post({ action: "resize", w, h });
    arm();
  }

  return {
    measured(w: number, h: number): void {
      const meaningful = !everPosted || Math.abs(w - lastW) > jitterPx || Math.abs(h - lastH) > jitterPx;
      if (!meaningful) return; // ignore jitter → breaks the resize↔reflow loop (the retry loop, not a re-measure, is what re-sends an unacked size)
      everPosted = true;
      lastW = w;
      lastH = h;
      pending = { w, h };
      attempts = 0;
      send(w, h);
    },
    handleMessage(data: unknown): boolean {
      if (!data || typeof data !== "object") return false;
      const msg = (data as Record<string, unknown>)[key]; // a foreign ns's ack lives under a DIFFERENT key → invisible here (LS-17 coexistence)
      if (!msg || typeof msg !== "object") return false;
      const ack = msg as { action?: unknown; w?: unknown; h?: unknown };
      if (ack.action !== SIZE_ACK_ACTION) return false;
      if (!pending) return true; // ours, but nothing is in flight (a duplicate ack) — consumed, nothing to settle
      if (ack.w !== pending.w || ack.h !== pending.h) return true; // acks the size we ALREADY superseded → keep retrying the current one
      pending = null;
      stopTimer();
      return true;
    },
    get pending() {
      return pending ? { w: pending.w, h: pending.h } : null;
    },
    get attempts() {
      return attempts;
    },
    dispose(): void {
      pending = null;
      stopTimer();
    },
  };
}

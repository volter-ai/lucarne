// send-flow.ts — the `send()` DRIVE loop, factored out so it is drivable WITHOUT a browser (all
// I/O is injected), matching this package's existing pattern for `type()` (type-loop.ts). This is
// what makes LS-11 dev/01's decision-table proof a real Chrome-free unit test: the test passes a
// MOCK transport (`pressKey`/`pressSubmit`/`readComposerProbe`) and asserts it records ZERO
// dispatches on every refusing branch. `InteractSession#send` (session.ts) supplies the real
// page-backed callbacks.
//
// The REFUSE-BY-DEFAULT guarantee lives in the control flow below, structurally: `decideSend` is
// evaluated FIRST, and the function returns immediately on a refusal — before `deps.pressKey`,
// `deps.pressSubmit`, or even `deps.readComposerProbe` is ever called. There is no code path from
// "policy/approval refused" to a keypress; the only calls into `deps` happen strictly after
// `decision.send === true`.
import { type ComposerCheckResult, type ComposerProbeResult, checkComposerHoldsDraft } from "./composer-check.js";
import { type DecideSendApproval, type DecideSendResult, type GuardrailResult, decideSend } from "./send-gate.js";

/** Press a key combo in the focused composer (real impl: `page.keyboard.press(key)`). */
export type SendGestureKey = { key: string };
/** Keyboard-activate a submit control (real impl: `page.locator(sel).first().press('Enter')`). */
export type SendGestureSubmit = { submit: string };
export type SendGesture = SendGestureKey | SendGestureSubmit;

export function isSubmitGesture(g: SendGesture): g is SendGestureSubmit {
  return typeof (g as SendGestureSubmit).submit === "string";
}

/** Caller-supplied policy: computes the guardrail decision for this draft. Cadence passes `enforce()` + sourcing/assess; this package never computes content rules itself. */
export type SendPolicy = (text: string, ctx: Record<string, unknown>) => GuardrailResult | Promise<GuardrailResult>;

/** The public approval shape (`send()`'s API) — `mode` is narrowed to the two real values; structurally assignable into `DecideSendApproval`. */
export interface SendApproval {
  approved?: boolean;
  ack?: boolean;
  mode: "ask" | "yolo";
}

export interface SendFlowOptions {
  gesture: SendGesture;
  policy: SendPolicy;
  approval: SendApproval;
  /** Opaque bag passed through to `policy(text, ctx)` verbatim (e.g. cadence's platform/kind/candidate id). This package never reads or interprets it. */
  ctx?: Record<string, unknown>;
}

/** The transport this loop drives — every field is a mockable dispatch point for Chrome-free tests. */
export interface SendFlowDeps {
  /** Dispatch the `{key}` gesture. Invoked ONLY after a GO decision AND (for non-submit gestures) a passed composer check. */
  pressKey: (key: string) => Promise<void>;
  /** Dispatch the `{submit}` gesture. Invoked ONLY after a GO decision. */
  pressSubmit: (selector: string) => Promise<void>;
  /** Read the focused composer's held text. Invoked ONLY after a GO decision, and ONLY for `{key}` gestures — skipped for `{submit}` forms (browser.ts:516). Never invoked on a refuse. */
  readComposerProbe: () => Promise<ComposerProbeResult>;
}

/** The action a `send()` call resolved to — `decideSend`'s five outcomes, plus the transport-safety refusal this package adds (the composer-verification check has no equivalent in `decideSend`; it fires strictly after a GO). */
export type SendAction = DecideSendResult["action"] | "composer-mismatch";

export interface SendFlowResult {
  sent: boolean;
  action: SendAction;
  reason: string;
  /** The policy result `policy(text, ctx)` computed — carried through for the caller's own logging/ledger. */
  policyResult: GuardrailResult;
  gesture: SendGesture;
  /** Code-point count of the requested text (not UTF-16 length — matches the composer check's code-point-safe probe). */
  chars: number;
  /** Present only on a `composer-mismatch` refusal. */
  composerCheck?: ComposerCheckResult;
}

/**
 * Run one `send()` call to completion: compute the policy result, run it through the
 * byte-identical `decideSend` gate, and — ONLY on a GO decision — run the composer-verification
 * check (skipped for `{submit}` gestures) and then the gesture itself. See the module doc above
 * for the "zero keypress on refuse" structural guarantee.
 */
export async function runSendFlow(text: string, opts: SendFlowOptions, deps: SendFlowDeps): Promise<SendFlowResult> {
  const policyResult = await opts.policy(text, opts.ctx ?? {});
  const approval: DecideSendApproval = opts.approval;
  const decision = decideSend(policyResult, approval);
  const chars = [...text].length;

  if (!decision.send) {
    // REFUSE. Nothing in `deps` has been touched — no composer probe, no keypress, no submit
    // click. This branch is the entire safety property: default refuse, unless GO below.
    return { sent: false, action: decision.action, reason: decision.reason, policyResult, gesture: opts.gesture, chars };
  }

  if (!isSubmitGesture(opts.gesture)) {
    // The composer check only applies to the `{key}` gesture, per `browser.ts:516`'s `if
    // (!submit)` — a `{submit}` form's textarea isn't necessarily the focused element.
    const probe = await deps.readComposerProbe();
    const check = checkComposerHoldsDraft(probe, text);
    if (!check.ok) {
      return {
        sent: false,
        action: "composer-mismatch",
        reason: check.detail,
        policyResult,
        gesture: opts.gesture,
        chars,
        composerCheck: check,
      };
    }
    await deps.pressKey(opts.gesture.key);
  } else {
    await deps.pressSubmit(opts.gesture.submit);
  }

  return { sent: true, action: decision.action, reason: decision.reason, policyResult, gesture: opts.gesture, chars };
}

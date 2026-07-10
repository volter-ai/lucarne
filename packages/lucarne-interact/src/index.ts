// lucarne-interact — the non-bot-like interaction plane (act verbs + enforced pacing).
// LS-09 scaffolded open/snap/scroll/activate/back/capture/video.* + pacing + the shared video
// assembler. LS-10 added humanized `type()` (stages only, never Enter) + offline `typingStats` +
// yield-to-human. LS-11 adds the GATED `send()` — the only code path that presses Enter to
// submit/act, default-refuse (byte-identical `decideSend` + the composer-verification safety
// check). LS-28 first hardened `activate()` with a target classifier; LS-31/S1 INVERTS it from a
// blocklist (refuse an enumerated set, default-ALLOW the rest — incomplete against any site's full
// vocabulary of account-state/publish controls) to a structural default-REFUSE allowlist
// (`activate-gate.ts`): a non-overridable safety floor refuses any form-submit shape first; a small
// set of domain-agnostic structural shapes (real-href links, tabs, disclosure toggles, `<summary>`,
// `<textarea>`, anchor-menuitems) allow; a caller-supplied, DATA-ONLY `ActivatePolicy` may allowlist
// one further compose-open control by host+testid/aria-label; everything else refuses by default —
// `activate` stays navigation-only; `send()` remains the only path that can actually submit. LS-12
// adds the presence contract (`src/presence.ts`): the ACT half's per-session driven-target marker
// (written by every verb) and the OBSERVE half's actor-attribution / tab-tie-break read — it is
// package-INTERNAL and deliberately NOT re-exported here (see test/presence-export-map.mjs);
// `checkHumanYield` below is unchanged as this package's public surface, now implemented there.
// Recall (LS-13) lands under this same package at the `lucarne-interact/recall` subpath (see
// `src/recall/index.ts`) — a SEPARATE entry point, not re-exported from this root barrel. It
// imports `./presence.js` directly, same as session.ts does (the single shared module, LS-12
// dev/02's proof); `InteractSession#presenceSnapshot()` below is how a caller wires an existing
// session's presence marker into `startRecall`'s attribution.
export {
  InteractSession,
  type ActionEvent,
  type ActivateResult,
  type BackOptions,
  type BackResult,
  type CaptionsOptions,
  type CaptionsResult,
  type CaptureResult,
  type CdpUrlSource,
  type ClipResult,
  type InteractSessionOptions,
  type OpenOptions,
  type OpenResult,
  type PresenceMarker,
  type ScrollResult,
  type SendOptions,
  type SendResult,
  type StoryboardFrame,
  type StoryboardOptions,
  type StoryboardResult,
  type TypeOptions,
  type TypeResult,
  type VideoVerbs,
  // The GENERIC selector defaults `back()`/`captions()` fall back to when a caller doesn't override
  // (LS-36) — exported so a consumer can COMPOSE its own site-specific override
  // (`[...GENERIC_BACK_SELECTORS, ...siteSelectors]`) instead of duplicating the generic literal to
  // keep it alongside a site addition.
  GENERIC_BACK_SELECTORS,
  GENERIC_CAPTION_OVERLAY_SELECTORS,
} from "./session.js";
export {
  type DecideSendApproval,
  type DecideSendResult,
  type GuardrailResult,
  decideSend,
} from "./send-gate.js";
export {
  type SendAction,
  type SendApproval,
  type SendFlowDeps,
  type SendFlowOptions,
  type SendFlowResult,
  type SendGesture,
  type SendGestureKey,
  type SendGestureSubmit,
  type SendPolicy,
  isSubmitGesture,
  runSendFlow,
} from "./send-flow.js";
export {
  type ComposerCheckReason,
  type ComposerCheckResult,
  type ComposerProbeResult,
  checkComposerHoldsDraft,
  normalizeComposerText,
} from "./composer-check.js";
export {
  type ActivateAllowEntry,
  type ActivateDecision,
  type ActivateDenyEntry,
  type ActivatePolicy,
  type ActivateTargetDescriptor,
  classifyActivateTarget,
  describeActivateRefusal,
} from "./activate-gate.js";
export {
  DEFAULT_PACING,
  type PaceKind,
  type PaceProfile,
  type PacingConfig,
  pace,
  resolvePacing,
  sampleDwellMs,
} from "./pacing.js";
export { humanDelays, keyDelay, typingStats, type TypingStats } from "./typing.js";
export {
  runTypeLoop,
  type TypeLoopDeps,
  type TypeLoopOptions,
  type TypeLoopResult,
} from "./type-loop.js";
export {
  checkHumanYield,
  type ActivityNowLike,
  type ActivityProbe,
  type ActivitySnapshotLike,
  type InPageInputProbe,
  type YieldCheckInput,
  type YieldCheckResult,
  type YieldProbePath,
} from "./yield.js";
export {
  assembleMp4FromFrames,
  cleanupFramesDir,
  cropImageFromScreenshot,
  startScreencastToFrames,
  type AssembleOptions,
  type AssembleResult,
  type CDPLike,
  type CropBox,
  type CropResult,
  type ScreencastHandle,
  type ScreencastOptions,
} from "./video/assembler.js";

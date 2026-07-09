// lucarne-interact — the non-bot-like interaction plane (act verbs + enforced pacing).
// LS-09 scaffolded open/snap/scroll/activate/back/capture/video.* + pacing + the shared video
// assembler. LS-10 added humanized `type()` (stages only, never Enter) + offline `typingStats` +
// yield-to-human. LS-11 adds the GATED `send()` — the only code path that presses Enter/submits,
// default-refuse (byte-identical `decideSend` + the composer-verification safety check). LS-12
// adds the presence contract (`src/presence.ts`): the ACT half's per-session driven-target marker
// (written by every verb) and the OBSERVE half's actor-attribution / tab-tie-break read — it is
// package-INTERNAL and deliberately NOT re-exported here (see test/presence-export-map.mjs);
// `checkHumanYield` below is unchanged as this package's public surface, now implemented there.
// Recall (LS-13+) lands in a later issue under this same package (as the `lucarne-interact/recall`
// subpath), and will import `./presence.js` directly, same as session.ts does.
export {
  InteractSession,
  type ActionEvent,
  type ActivateResult,
  type BackOptions,
  type BackResult,
  type CaptionsResult,
  type CaptureResult,
  type CdpUrlSource,
  type ClipResult,
  type InteractSessionOptions,
  type OpenResult,
  type ScrollResult,
  type SendOptions,
  type SendResult,
  type StoryboardFrame,
  type StoryboardOptions,
  type StoryboardResult,
  type TypeOptions,
  type TypeResult,
  type VideoVerbs,
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
  startScreencastToFrames,
  type AssembleOptions,
  type AssembleResult,
  type CDPLike,
  type ScreencastHandle,
  type ScreencastOptions,
} from "./video/assembler.js";

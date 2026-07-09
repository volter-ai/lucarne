// lucarne-interact — the non-bot-like interaction plane (act verbs + enforced pacing).
// LS-09 scaffolded open/snap/scroll/activate/back/capture/video.* + pacing + the shared video
// assembler. LS-10 adds humanized `type()` (stages only, never Enter) + offline `typingStats` +
// yield-to-human. Send (LS-11), presence (LS-12), and recall (LS-13+) land in later issues under
// this same package (recall as the `lucarne-interact/recall` subpath).
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
  type StoryboardFrame,
  type StoryboardOptions,
  type StoryboardResult,
  type TypeOptions,
  type TypeResult,
  type VideoVerbs,
} from "./session.js";
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

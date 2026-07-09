// lucarne-interact — the non-bot-like interaction plane (act verbs + enforced pacing).
// This is the LS-09 scaffold: open/snap/scroll/activate/back/capture/video.* + pacing + the
// shared video assembler. Typing (LS-10), send (LS-11), presence (LS-12), and recall (LS-13+) land
// in later issues under this same package (recall as the `lucarne-interact/recall` subpath).
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

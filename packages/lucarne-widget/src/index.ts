// The root export — the environment-agnostic vocabulary shared by both sides of the widget (host + iframe
// runtime) and by a consumer wiring the engine's `injectPolicy`. Node-only (`WidgetHost`, `lucarne-widget/host`)
// and DOM-only (`createWidget`, `lucarne-widget/runtime`) code live at their own subpaths — see `package.json`'s
// `exports` map — so importing "." never pulls in either a `lucarne` HTTP client or a `document` dependency.
export {
  ENVELOPE_KEY,
  WIDGET_STATE_VERSION,
  isShellOnlyId,
  isWidgetEnvelopeMessage,
  onlyShellIds,
  widgetMessage,
  type Identity,
  type WidgetEnvelope,
  type WidgetEnvelopeMessage,
} from "./envelope.js";
export {
  assertNs,
  chromeKey,
  dragGlobal,
  glassIds,
  guardGlobal,
  hostElementId,
  iframeGlobal,
  intentQueueGlobal,
  nsPrefix,
  peekElementId,
  posGlobal,
  scrimGlobal,
  shellStickyId,
  themeGlobal,
} from "./ns.js";
export { createEnvelopeReducer, identityKeyOf, type EnvelopeReducer, type EnvelopeReducerOptions } from "./reducer.js";
export { injectorSource, type InjectorOptions } from "./injector.js";
export { SHELL_CSS } from "./shell-css.js";

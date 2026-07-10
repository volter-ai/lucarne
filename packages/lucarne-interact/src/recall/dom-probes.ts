// The generic, domain-agnostic per-tab DOM probes recall's screen sensor evaluates alongside every
// screenshot/signature read. LS-32: this file used to carry the media/visibility probe BODIES
// themselves, hardwired to one site's post/photo/media-path markup, and run unconditionally — a
// non-X consumer got X-shaped behavior (or silently zero media-crop/viewport-honesty) with no way
// to opt in its own markup. Those probe bodies moved DOWNSTREAM (a domain package's own
// `xMediaProbe`/`xVisibleProbe`) and are injected by the CALLER via `StartRecallOptions.probes`
// (`RecallPageProbes`, `types.ts`) — this package bundles none of its own, same LS-29 posture as
// `extractors`/`wireAdapters`. What's left here is genuinely domain-agnostic: the shared `MediaBox`
// shape a probe's output must conform to, and the two probes with NO site-specific content at all
// (tab visibility, and a signature read whose one site-shaped field — `firstText`'s CSS selector —
// is itself now a caller-supplied option, `RecallPageProbes.signatureSelector`).
//
// Both remaining probes are READ-ONLY DOM reads (`getBoundingClientRect`, `querySelectorAll`,
// attribute reads, `document.visibilityState`/`hasFocus()`) — they touch nothing, dispatch nothing,
// and fetch nothing. They run inside `page.evaluate`, so this file is only meaningful with a live
// Page; it has no unit test of its own (the logic a caller's probe OUTPUT feeds —
// `filterVisibleRecords`, `MediaCropTracker` — is what's Chrome-free tested, against fixture
// probe output, in test/recall-probes-pluggable.mjs).

/** One on-screen media element's clamped bounding box — the shape a caller's own `mediaProbe`
 *  (`RecallPageProbes.mediaProbe`) must return. Domain-agnostic: nothing here names a site. */
export interface MediaBox {
  sid: string;
  alt: string;
  x: number;
  y: number;
  w: number;
  h: number;
  dpr: number;
  /** Whether the box's rect was FULLY inside the viewport (vs. partially clipped). */
  full: boolean;
}

/** The generic per-tab visibility/focus/skip probe (the origin app's `recall.ts:71-72`). NON-http(s) tabs
 *  (about:blank, chrome://, our own file://data: surfaces) are SKIPPED so recall never records its
 *  own viz/widget surfaces, only real sites. */
export function tabVisibilityProbe(): { vis: boolean; foc: boolean; skip: boolean } {
  return {
    vis: document.visibilityState === "visible",
    foc: document.hasFocus(),
    skip: !/^https?:$/.test(location.protocol),
  };
}

/** The winning tab's own signature read (the origin app's `recall.ts:89-96`, minus its retired
 *  cross-eval intent-bus global's fields — NOT ported; see LS-13's `observers` hook + the task
 *  spec's §2 LS-13 note). LS-32: `firstTextSelector` is caller-supplied
 *  (`RecallPageProbes.signatureSelector`) rather than a hardcoded site-shaped selector — `null`/
 *  absent means "skip `firstText`" (return `""`) rather than guessing a markup convention. */
export function tabSignatureProbe(firstTextSelector: string | null): {
  url: string;
  title: string;
  scrollY: number;
  firstText: string;
  video: { ct: number; dur: number | null; paused: boolean } | null;
} {
  const v = document.querySelector("video");
  const a = firstTextSelector ? (document.querySelector(firstTextSelector) as HTMLElement | null) : null;
  return {
    url: location.href,
    title: document.title,
    scrollY: Math.round(scrollY),
    firstText: a ? (a.innerText || "").replace(/\s+/g, " ").slice(0, 80) : "",
    video: v ? { ct: +v.currentTime.toFixed(2), dur: Number.isFinite(v.duration) ? +v.duration.toFixed(2) : null, paused: v.paused } : null,
  };
}

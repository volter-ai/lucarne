// The two IN-PAGE probes recall's screen sensor evaluates alongside every screenshot — ported
// verbatim (as real, type-checked functions, not template-string blobs — there is no more
// eval-server HTTP boundary to serialize across) from cadence's `MEDIA_PROBE` (`recall.ts:112-126`)
// and `VISIBLE_PROBE` (`recall.ts:132-139`).
//
// Both are READ-ONLY DOM reads (`getBoundingClientRect`, `querySelectorAll`, attribute reads) —
// they touch nothing, dispatch nothing, and fetch nothing. They run inside `page.evaluate`, so this
// file is only meaningful with a live Page; it has no unit test of its own (the logic these
// probes' OUTPUT feeds — `filterVisibleRecords`, `MediaCropTracker` — is what's Chrome-free tested).
//
// Kept x-shaped (the `/status/<id>` link, the `article` element) — same as `VISIBLE_PROBE`'s own
// source lines — because that's the concrete site the split spec ported this behavior FROM;
// generalizing to a per-extractor viewport probe is a natural follow-on, not required by LS-13.

/** One on-screen media element's clamped bounding box (cadence's `recall.ts:112-126`). */
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

/**
 * Per-post media bounding boxes, CLAMPED to the visible viewport — gated on the post itself being
 * a "unit" this capture (≥120px visible) so every crop always has a unit to land on, and the image
 * must be LOADED (not lazy/blank). Evaluated in the SAME instant as the screenshot, so boxes align
 * with both the pixels and the ARIA snapshot.
 */
export function mediaProbe(): MediaBox[] {
  const dpr = window.devicePixelRatio || 1;
  const H = innerHeight;
  const W = innerWidth;
  const res: MediaBox[] = [];
  for (const a of Array.from(document.querySelectorAll("article"))) {
    const ar = a.getBoundingClientRect();
    if (Math.min(H, ar.bottom) - Math.max(0, ar.top) < 120) continue; // post must be a UNIT too
    const link = Array.from(a.querySelectorAll('a[href*="/status/"]'))
      .map((x) => x.getAttribute("href"))
      .find((h) => /\/status\/\d+/.test(h || ""));
    const m = link && link.match(/status\/(\d+)/);
    if (!m) continue;
    const el = a.querySelector(
      '[data-testid="tweetPhoto"] img, [data-testid="tweetPhoto"], video, [data-testid="videoPlayer"], img[src*="/media/"]',
    ) as (HTMLElement & { naturalWidth?: number }) | null;
    if (!el) continue;
    const img = (el.tagName === "IMG" ? el : el.querySelector && el.querySelector("img")) as
      | (HTMLImageElement | null)
      | undefined;
    if (img && !(img.naturalWidth > 0)) continue; // lazy / not yet loaded → blank crop; catch it on a later pass
    const r = el.getBoundingClientRect();
    if (r.width < 64 || r.height < 64) continue;
    const vl = Math.max(0, r.left);
    const vt = Math.max(0, r.top);
    const vr = Math.min(W, r.right);
    const vb = Math.min(H, r.bottom);
    const vw = vr - vl;
    const vh = vb - vt;
    if (vw < 80 || vh < 80) continue; // require a reasonable on-screen chunk
    const full = vh >= r.height - 2 && vw >= r.width - 2;
    const alt = (img && img.getAttribute("alt")) || el.getAttribute("alt") || (el.tagName === "VIDEO" ? "video" : "");
    res.push({ sid: m[1]!, alt: alt || "", x: vl, y: vt, w: vw, h: vh, dpr, full });
  }
  return res;
}

/**
 * Which post ids were actually ON SCREEN (≥120px of the element's height inside the viewport) —
 * the input to `filterVisibleRecords`'s viewport-honesty filter.
 */
export function visibleProbe(): string[] {
  const H = innerHeight;
  const ids: string[] = [];
  for (const a of Array.from(document.querySelectorAll("article"))) {
    const link = Array.from(a.querySelectorAll('a[href*="/status/"]'))
      .map((x) => x.getAttribute("href"))
      .find((h) => /\/status\/\d+/.test(h || ""));
    const m = link && link.match(/status\/(\d+)/);
    if (!m) continue;
    const r = a.getBoundingClientRect();
    const seen = Math.min(H, r.bottom) - Math.max(0, r.top);
    if (seen >= 120) ids.push(m[1]!);
  }
  return ids;
}

/** The generic per-tab visibility/focus/skip probe (cadence's `recall.ts:71-72`). NON-http(s) tabs
 *  (about:blank, chrome://, our own file://data: surfaces) are SKIPPED so recall never records its
 *  own viz/widget surfaces, only real sites. */
export function tabVisibilityProbe(): { vis: boolean; foc: boolean; skip: boolean } {
  return {
    vis: document.visibilityState === "visible",
    foc: document.hasFocus(),
    skip: !/^https?:$/.test(location.protocol),
  };
}

/** The winning tab's own signature read (cadence's `recall.ts:89-96`, minus the `window.__cadence`
 *  intent-bus fields — NOT ported; see LS-13's `observers` hook + the task spec's §2 LS-13 note). */
export function tabSignatureProbe(): {
  url: string;
  title: string;
  scrollY: number;
  firstText: string;
  video: { ct: number; dur: number | null; paused: boolean } | null;
} {
  const v = document.querySelector("video");
  const a = document.querySelector("article,.thing,.athing") as HTMLElement | null;
  return {
    url: location.href,
    title: document.title,
    scrollY: Math.round(scrollY),
    firstText: a ? (a.innerText || "").replace(/\s+/g, " ").slice(0, 80) : "",
    video: v ? { ct: +v.currentTime.toFixed(2), dur: Number.isFinite(v.duration) ? +v.duration.toFixed(2) : null, paused: v.paused } : null,
  };
}

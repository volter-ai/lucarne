// The ~150 lines of SHELL-CHROME CSS — split out of the prior single-app implementation's `web/app/style.css`,
// generalized: the wrap/pill/panel frame, the organ tablist, the drag affordance, and the generic
// status-indicator primitives (`.oi` dot/pulse/badge) that `registerPanel`'s `indicator`/`badge` callbacks (see
// `runtime.ts`) render through. Deliberately EXCLUDED (stays with the downstream consumer, ported forward
// unchanged by LS-20): the draft/option content styles (`.draft`, `.trow`, `.optcar`, `.replyto`, `.trust`,
// `.seg`, `.whypanel`, `.use`, `.draftchip`, …) and the "Apple-Intelligence" edge-glow/recording-dot
// flourishes, which carry that product's own semantics rather than generic shell chrome.
//
// A consumer's own build (`build.ts`'s `buildSrcdoc({ css })`) concatenates this with its own panel/organ CSS —
// this string is exported as a plain constant (not a `.css` file import) so it needs no bundler CSS loader.
export const SHELL_CSS = `
:root { color-scheme: dark;
  --bg:#14161c; --bg2:#0e1014; --bd:#262a35; --bd2:#2f3442; --fg:#e7eaf0; --mut:#8b93a7; --acc:#5b8cff; --ok:#5fd99a; --ask:#f0c060; --block:#ff7a7a;
  --fill: rgba(255,255,255,.05); --fill-2: rgba(255,255,255,.08); --fill-3: rgba(255,255,255,.12);
  --hair: rgba(255,255,255,.09); --on-acc:#0a0e1a; --on-ok:#06210f }
/* LIGHT SKIN — the host probes the page's bg luminance and posts { theme }; a consumer's runtime flips
   data-theme on the iframe document so the glass reads as frosted glass (not a dark slab) over a light page. */
:root[data-theme="light"] { color-scheme: light; --bg2:#eef1f6; --bd:#dfe3ec; --bd2:#cad0dd; --fg:#171b24; --mut:#586273; --acc:#3a63d8; --ok:#1f9d57; --ask:#a9760f; --block:#d23b3b;
  --fill: rgba(0,0,0,.05); --fill-2: rgba(0,0,0,.07); --fill-3: rgba(0,0,0,.10); --hair: rgba(0,0,0,.08); --on-acc:#ffffff; --on-ok:#ffffff }
:root[data-theme="light"] kbd { background:#e7ebf2; color:#48505f; border-color:#cdd4df }
:root[data-theme="light"] .ico:hover { background:rgba(0,0,0,.06) }
* { box-sizing: border-box }
html, body { margin: 0; height: 100%; background: transparent; overflow: hidden }   /* transparent → the HOST's glass (blur+tint) shows through; the host owns radius+shadow+clip; no scrollbar → no resize jitter */
body { font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--fg) }
.wrap { display: inline-block }

/* entrance: the pill/panel scale-fade in on mount (pairs with the host's spring size-morph) */
@keyframes lw-pop { from { opacity: 0; transform: scale(.96) } to { opacity: 1; transform: scale(1) } }
.pill, .panel { animation: lw-pop .34s cubic-bezier(.34, 1.3, .5, 1) both }
kbd { font: 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace; background: #20242e; border: 1px solid var(--bd2);
  border-bottom-width: 2px; border-radius: 4px; padding: 2px 4px; color: #b9c1d2; margin: 0 1px }

/* ── panel frame ───────────────────────────────────────────── */
.panel { position: relative; width: 360px; background: transparent }   /* radius + shadow + clip + glass come from the host element */
header { position: relative; display: flex; align-items: center; gap: 7px; padding: 15px 12px 10px; cursor: move; user-select: none }   /* the drag affordance: the gesture starts here and relays to the host, see runtime.ts's onHeaderDown */
header b { font-size: 13px; font-weight: 600 }
.ico { display: inline-flex; align-items: center; justify-content: center; background: 0; border: 0; color: var(--mut);
  cursor: pointer; font-size: 15px; line-height: 1; padding: 3px 5px; border-radius: 8px }
.ico:hover { color: var(--fg); background: #20242e }
.ico.sm { font-size: 13px; padding: 0 4px }
.plain { background: 0; border: 0; color: var(--mut); border-radius: 999px; padding: 8px 12px; font-size: 12.5px; cursor: pointer }
.plain:hover { color: var(--fg) }

/* THE SYMBOL SYSTEM — symbols set like type: em-sized + currentColor, so they ARE the same ink as adjacent text */
.ic { width: 1em; height: 1em; display: inline-block; vertical-align: -0.125em; flex: none }
.tri { display: inline-flex; transition: transform .2s ease }   /* disclosure chevron: the SAME glyph rotates, never a swapped icon */
.tri.open { transform: rotate(90deg) }

/* iOS sheet grabber — a subtle drag affordance at the top of the panel (the header itself is the drag handle) */
.grabber { position: absolute; top: 5px; left: 50%; transform: translateX(-50%); width: 30px; height: 4px; border-radius: 2px; background: var(--mut); opacity: .28; pointer-events: none }

/* ── resting pill (the Dynamic-Island-style collapsed state) ── */
.pill { display: inline-flex; align-items: center; gap: 9px; cursor: pointer; color: var(--fg);
  background: transparent; border: 1px solid transparent; border-radius: 999px; padding: 10px 16px;
  font-size: 12.5px; transition: border-color .12s }   /* the glass itself comes from the host; the capsule shape is the pill's own */
.pill:hover { border-color: var(--acc) }
.brand { display: inline-flex; align-items: center; color: var(--acc); flex: none }
.pill .lead { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; font-size: 12.5px; color: var(--fg); white-space: nowrap }
.pill .triad { display: inline-flex; align-items: center; gap: 7px; margin-left: auto; padding-left: 10px }

/* ── organ tablist (a macOS-toolbar icon-segmented control; the active tab lifts onto a glass thumb) ── */
.organs { display: inline-flex; align-items: center; gap: 1px; padding: 2px; border-radius: 11px; background: rgba(127,127,127,.08) }
.organ { position: relative; display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; border: 0; border-radius: 9px;
  background: 0; color: var(--mut); cursor: pointer; transition: background .14s, color .14s }
.organ:hover { color: var(--fg) }
.organ:focus-visible { outline: 2px solid var(--acc); outline-offset: 1px }
.organ.on { color: var(--fg); background: rgba(255,255,255,.10); box-shadow: 0 1px 2px rgba(0,0,0,.18) }
:root[data-theme="light"] .organ.on { background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.10) }
.winctl { display: inline-flex; align-items: center; gap: 2px; margin-left: auto }

/* organ INDICATORS — the generic status-primitive vocabulary a registered panel's indicator/badge callbacks
   render through: a DOT (tone: live|warn|dead|off), a PULSE (activity on/off), a BADGE (a count). App-agnostic —
   a consumer's own semantics (recording, thinking, queue depth, …) pick which primitive and which tone to use. */
.oi { flex: none }
.oi.dot { width: 6px; height: 6px; border-radius: 50%; border: 1.5px solid var(--mut); box-sizing: border-box; opacity: .7 }
.oi.dot.live { background: var(--ok); border-color: var(--ok); opacity: 1; box-shadow: 0 0 5px rgba(95,217,154,.7); animation: lw-breathe 2s ease-in-out infinite }
.oi.dot.warn { background: #ffc53d; border-color: #ffc53d; opacity: 1; box-shadow: 0 0 5px rgba(255,197,61,.7); animation: lw-breathe 1.4s ease-in-out infinite }
.oi.dot.dead { border-color: #ff7a7a; opacity: .55 }
.oi.dot.flash { animation: lw-flash .5s ease-out }
@keyframes lw-flash { 0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(95,217,154,.6) } 100% { transform: scale(1.5); box-shadow: 0 0 0 6px rgba(95,217,154,0) } }
.oi.pulse { width: 6px; height: 6px; border-radius: 50%; background: var(--mut); opacity: .5 }
.oi.pulse.on { background: var(--acc); opacity: 1; animation: lw-pulse 1.1s ease-in-out infinite }
@keyframes lw-pulse { 0%, 100% { opacity: .4; transform: scale(.78) } 50% { opacity: 1; transform: scale(1.18) } }
.oi.badge { min-width: 15px; height: 15px; padding: 0 4px; border-radius: 8px; background: var(--acc); color: #fff;
  font-size: 9.5px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center }
@keyframes lw-breathe { 0%, 100% { opacity: 1 } 50% { opacity: .45 } }

/* generic footer hint bar — an inset hairline separator + a keyboard-hint row (a consumer fills in its own keys) */
footer { position: relative; color: var(--mut); font-size: 10.5px; padding: 11px 14px 11px; margin-top: 8px;
  display: flex; align-items: center; gap: 3px; flex-wrap: wrap }
footer::before { content: ''; position: absolute; left: 14px; right: 14px; top: 0; height: 1px; background: var(--hair) }
footer.keys { flex-wrap: nowrap; justify-content: space-between }
footer.keys .khint { display: inline-flex; align-items: center; gap: 3px; flex-wrap: wrap; min-width: 0 }
footer.keys .kprim { display: inline-flex; align-items: center; gap: 4px; color: var(--fg); font-weight: 600; flex: none; margin-left: auto }
`;

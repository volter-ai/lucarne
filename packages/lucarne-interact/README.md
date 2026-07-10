# lucarne-interact

**The non-bot-like interaction plane** — one human-paced presence over a
[`lucarne`](https://www.npmjs.com/package/lucarne) session's `cdpUrl`. This
package's charter (ported from cadence's `browser.ts`, `cadence/src/browser.ts:1-6`)
is anti-bot-detection, not accessibility-compliance: reads are ARIA-only,
interaction is keyboard-first, navigation is click-a-link + back (like a
person), and **every action is followed by an ENFORCED human pause** drawn
from a normal distribution. If a bot-like action isn't a verb here, it
**physically cannot happen** — there is intentionally no `click` (synthetic
mouse), no `goto`/`go` (deep-linking), and no `eval` (arbitrary code) on
`InteractSession`.

LS-09 scaffolded the ACT verbs, enforced pacing, and the shared video
assembler. LS-10 added humanized typing: `type(text)` stages text via a
per-keystroke bigram/log-normal timing model (never presses Enter) and
yields the keyboard the instant a live human appears to type. **LS-11 adds
the GATED `send()`** — the *only* code path in this package that presses
Enter / submits: default-refuse, only an explicit approval or yolo mode
sends, with a pre-keypress composer-verification safety check. The presence
contract (LS-12) and recall — the OBSERVE half, at the `lucarne-interact/recall`
subpath (LS-13/13W/14) — land in later issues on top of this scaffold.

## Install

```sh
npm install lucarne-interact
npm install playwright-core   # peer — you bring your own Playwright driver
```

`playwright-core` is a **peer dependency**, the same posture as the `lucarne`
engine's own driver story (`packages/lucarne/README.md`): `npm install
lucarne-interact` alone does not pull in a browser driver.

This package does **not** depend on the `lucarne` engine package — it talks
to a session purely through its `cdpUrl` string (or any `{ cdpUrl }`-shaped
object, so a lucarne engine `session` works directly), matching the
platform's dependency graph (interact has no `lucarne` dep).

## Usage

```ts
import { InteractSession } from "lucarne-interact";

const session = new InteractSession(cdpUrl); // or new InteractSession(session)

session.on("action", (e) => console.log(e.verb, e.actionMs, "ms +", e.pacedMs, "ms pace"));

await session.open("https://example.com");
const aria = await session.snap("body", 80);
await session.scroll(2);
await session.activate('a[href="/next"]');
await session.back();
await session.capture("article img", "/tmp/shot.png");
await session.video.clip("video", "/tmp/clip.mp4");

await session.close();
```

## The verbs

| Verb | Ported from | What it does |
|---|---|---|
| `open(url)` | `browser.ts:244-268` (minus the FEEDS map + channel warning — cadence policy) | the single sanctioned bootstrap navigation |
| `snap(selector?, maxLines?)` | `browser.ts:275-279` | ARIA snapshot — the only way to read |
| `scroll(n?)` | `browser.ts:281-285` | real keyboard `PageDown` × n, not JS `scrollBy` |
| `activate(selector)` | `browser.ts:536-537` | keyboard-first activation: focus + Enter, no mouse |
| `back({ inAppSelectors? })` | `browser.ts:270-274` | in-app Back control, else browser history |
| `capture(selector, outPath)` | `browser.ts:287-292` | element-scoped screenshot via CDP, invisible to the page |
| `viewportShot(outPath)` | (new, LS-22b) | viewport-only screenshot via CDP — contrast with `capture`'s element-bounding-box shot; invisible to the page |
| `where()` | (new, LS-22b) | `{ url, title }` of the SAME page the other verbs read — for self-consistent page metadata |
| `type(text, opts?)` | `browser.ts:184-195` | humanized per-keystroke typing into the focused field — **stages only, never Enter**; yields to a live human |
| `send(text, opts)` | `guardrails/enforce.ts:110-132` + `browser.ts:503-534` | the GATED commit: default-refuse; only an explicit approval, or yolo, presses Enter/submits |
| `video.storyboard(selector, { outDir, frames? })` | `browser.ts:294-317` | keyframes across the video's own duration (a fallback view) |
| `video.clip(selector, outPath)` | `browser.ts:333-379` | record a video to completion (hard-capped), assembled to mp4 |
| `video.captions(selector)` | `browser.ts:394-401` | read the caption transcript from DOM cues (the speech channel) |

Every verb call emits one `action` event and pays one enforced pace — success
or failure.

## The gated `send()` (LS-11)

`send` is the **only** code path in this package that presses Enter or
submits — the anti-footgun for acting on logged-in accounts. It composes on
`type`'s staging: `type` enters text; `send` commits whatever the caller
already staged. The default is **REFUSE** — a send only fires on an explicit
approval signal, or yolo mode:

```ts
const result = await session.send(draft, {
  gesture: { key: "Meta+Enter" },       // or { submit: "button[type=submit]" }
  policy: async (text, ctx) => enforce(text, guardrailsConfig, ctx), // CALLER-supplied
  approval: { mode: "ask", approved: true },   // or { mode: "yolo" }; ack: true for always-ask topics
});
// { sent, action, reason, policyResult, gesture, chars, composerCheck? }
```

**`decideSend`** (`src/send-gate.ts`) is ported **byte-identical** from
cadence's `guardrails/enforce.ts:124-132` — `test/decide-send-provenance.mjs`
diffs the ported span against a frozen copy of the original and fails on any
drift. Priority order (strictest first, same in both modes unless noted):

1. **blocked** → never send (a hard guardrail failure). Even in yolo.
2. **always-ask** → needs an explicit `ack`. Even in yolo.
3. **ask mode** → needs an explicit per-send `approved` (or `ack`). yolo skips this.
4. otherwise → send (`send-approved`, or `send-yolo` in yolo mode).

All **policy** is caller-supplied: `policy(text, ctx)` computes the
`GuardrailResult` (`{ blocked?, mustAsk?, ok?, violations? }` — `decideSend`
only ever reads `blocked`/`mustAsk`). This package carries **none** of
cadence's content rules, rate limits, sourcing/assess, or approvals ledger —
those stay cadence policy (LS-18 injects them via `policy`/`ctx`).

On a GO decision, the **composer-verification check**
(`src/composer-check.ts`, ported from `browser.ts:516-525`) runs before the
keypress — skipped for `{ submit }` gestures — and can still refuse
(`action: 'composer-mismatch'`) with a distinct reason if the focused
composer doesn't actually hold the draft:

- `empty` — something is focused, but holds no text.
- `stale` — holds text, but it doesn't match the draft (normalized compare; a
  code-point-safe 16-character probe, so an emoji-leading draft is never
  mis-split).
- `focus-lost` — nothing focusable is focused at all.

**Zero keypress on any refusing branch is structural, not incidental**: the
drive loop (`src/send-flow.ts#runSendFlow`) evaluates `decideSend` first and
returns immediately on a refusal — before the transport (`pressKey`/
`pressSubmit`/`readComposerProbe`) is ever touched. `test/send-gate.mjs`
proves this with a mock transport that records zero dispatches on every
refusing branch of the full decision table, plus an exhaustive matrix over
every `(blocked, mustAsk, mode, approved, ack)` combination.

## Humanized typing (`type`) + yield-to-human

`type(text)` enters text into whatever is focused using a per-keystroke timing
model (ported from cadence's `typeHuman`/`keyDelay`, `browser.ts:132-195`):
inter-keystroke intervals depend on the **bigram class** (same-finger keys are
slowest, same-hand medium, alternating-hand fastest), sampled **log-normal**
(right-skewed, like real typing), with **cognitive pauses** at sentence and
word boundaries. The point isn't to forge human-ness — it's to *not* do the
unnatural instant-paste thing.

```ts
const r = await session.type("hello world");   // { chars, typed, yielded }
// r.yielded === true  → a live human started typing; we ABORTED (typed r.typed of r.chars)
```

**`type` STAGES ONLY — it never presses Enter or submits.** Sending an approved
draft (the gated Enter/submit gesture) is the separate `send` verb (LS-11);
`type` runs no key other than the characters of `text` (`page.keyboard.type`,
which types printable characters and never dispatches Enter/submit).

**Yield-to-human.** While typing, `type` probes every ~12 characters for a live
human at the keyboard and, if one is detected within the threshold (~1500ms),
returns `{ yielded: true }` without finishing. Two probe paths, tried in order:

1. **PREFERRED — lucarne's actor-tagged activity** (`now.lastHumanActionMsAgo`).
   Attributed at the source (porthole = human, `act()`/CDP-driver = agent), so
   it can never mistake our own keystrokes for a human's. Duck-typed (no
   `lucarne` import): pass an accessor via the option `activity`, or on the
   `{ cdpUrl, activity }` constructor object:

   ```ts
   new InteractSession({ cdpUrl, activity: () => client.activity(session.id) });
   // or: new InteractSession(cdpUrl, { activity: () => client.activity(id) });
   ```

2. **FALLBACK — the in-page `window.__lastInputAt` probe** (`browser.ts:186-190`),
   used automatically when no `activity` accessor is available. `type` installs
   a capture-phase input listener that stamps `window.__lastInputAt`, and
   disqualifies the echo of its *own* CDP-dispatched keystrokes (a page-level
   timestamp only counts as a human if it is newer than our last keystroke) —
   otherwise the probe would yield to itself.

### Offline timing stats

`typingStats(text)` is a **pure** function (no browser) returning the model's
stats for a string — handy for validating the cadence stays human without
driving Chrome:

```ts
import { typingStats } from "lucarne-interact";
typingStats("the quick brown fox");
// { chars, seconds, wpm, median_ms, p10_ms, p90_ms, max_ms }
```

## Enforced pacing

After every verb, the session sleeps for a duration sampled from a normal
distribution, floored so it can never go below a configured minimum:

```
dwell = max(min, mean + sd * N(0,1))
```

Four pacing "kinds" exist (`nav`, `scroll`, `read`, `act` — `act` is reserved
for LS-10/11's `type`/`send`), each independently configurable:

```ts
new InteractSession(cdpUrl, {
  pacing: {
    nav: { mean: 2600, sd: 1000, min: 800 },   // cadence's defaults (browser.ts:151-152)
    read: { min: 500 },                          // override just the floor
  },
});
```

**The floor is always positive.** `resolvePacing`/the constructor throws if
any kind's `min` is configured to `0` or negative — there is no way to turn
pacing off. That is the point: "every action is followed by an ENFORCED
human pause" is a law, not an option.

## The shared video assembler

`src/video/assembler.ts` is an **internal** module (not exported from the
package root's stable surface — it's re-exported from `index.ts` for
`lucarne-interact/recall` (LS-13) to import directly, but it is not part of
this issue's public API contract): a CDP screencast → JPEG-frames-on-disk →
`ffmpeg` mp4 assembler. cadence had this exact machinery duplicated
byte-for-byte in `browser.ts:378-379` (the `clip` verb) and `recall.ts:239`
(watched-video capture), and its per-post image crop (`recall.ts:144-157`)
was a THIRD ffmpeg call. This package holds **one** copy of each kind:
`startScreencastToFrames`/`assembleMp4FromFrames` (the one ffmpeg *encoder*
arg-list — `video.clip` and recall's watched-video sensor both call it) and
`cropImageFromScreenshot` (a still-image crop, not an encode — recall's
per-post media crops call this one). There is exactly one `libx264`
reference in this package's `src/`, and ffmpeg is spawned from nowhere else.

## Recall — the OBSERVE half (`lucarne-interact/recall`, LS-13)

A passive, read-only SCREEN sensor: `startRecall(sessionOrCdpUrl, { dataDir,
extractors, observers, toggles })` runs on its **own** `playwright-core`
connection over a session's `cdpUrl` — a second, independent client of the
same CDP endpoint the ACT half connects to (the engine's own tap-sharing
design, `lucarne`'s `cdp.ts:1-3`, is precedent that concurrent CDP consumers
of one target coexist). It never drives the page — no clicks, no
navigation, no typing — only reads: ARIA snapshots, screenshots, DOM
visibility probes, and (for a playing video) its own CDP screencast tap.

```ts
import { InteractSession } from "lucarne-interact";
import { startRecall } from "lucarne-interact/recall";
import { xAriaExtractor } from "lucarne-records/sites";

const interact = new InteractSession(session);
const recall = await startRecall(interact, {
  dataDir: "/path/to/store",
  extractors: [xAriaExtractor], // { match(url), extract(aria, capture) => records }
  observers: [(signal) => console.log(signal.kind, signal)],
});
// ... drive/observe the session ...
await recall.stop();
```

- **Extractors are plugins** (`{ match(url), extract(aria, capture) =>
  records }`) — cadence passes the X ARIA extractor from
  `lucarne-records/sites`. Recall dispatches every matching extractor and
  writes the resulting records through `lucarne-records`'s `appendRecords`.
- **Observers are consumer hooks** — `(signal) => void`, fired for every
  capture/video event. Cadence's intent-bus polling (`window.__cadence`
  picks/approvals/draft-requests, `recall.ts:337-367`) is **not** ported
  here; a caller wanting that reads its own page state separately.
- **Presence/attribution** — pass an `InteractSession` directly (or any
  `{ cdpUrl, presenceSnapshot? }`-shaped object) and every capture is
  stamped `by: 'agent'|'human'` via `presenceSnapshot()` + LS-12's
  `attributeActor`. `InteractSession#presenceSnapshot()` is the read
  accessor recall uses — it never reaches into the session's private state.
- **Viewport honesty** — a virtualized feed's off-screen DOM buffer is
  filtered out; the thread root always survives so no comment is ever
  orphaned.
- **Media crops, never a CDN** — per-post images are cropped out of the
  session's own screenshot (`cropImageFromScreenshot`, above), never
  fetched from a media host.
- **Watched video** — stops on end / loop / look-away / a 5-minute cap,
  assembled to mp4 by the same shared assembler `video.clip` uses.

Safety-law gates: `grep -rn "/eval" src/recall` and
`grep -REn "pbs\.twimg|fetch\(.*http" src/recall` both return zero hits
(`test/recall-readonly-gates.mjs`).

## Recall status + summary (`lucarne-interact/status`, LS-14)

The recording-state contract is FIVE ORTHOGONAL LAYERS (control, liveness,
observability, activity, events), never one flat enum, composed into a
single view-facing label by `displayState(status, now)`. The load-bearing
property is the **staleness law**: a stale or absent snapshot can *only*
ever report `DISPLAY.OFFLINE` — a wedged/dead recorder must never claim it
is live, even if the last thing it published was `activity:
'recording_video'`.

```ts
import { displayState, DISPLAY, RecallStatusHolder } from "lucarne-interact/status";

const status = new RecallStatusHolder();
// ... status.publish({ observe: "ok", activity: "idle" }) on every recall tick ...
const { state, live, progress } = displayState(status.snapshot(), Date.now());
```

`status.ts` is deliberately dependency-free (no `node:fs`/`node:child_process`
import) so it has its own package subpath — a consumer (a widget bundle, a
CLI) can import just the contract without pulling in the rest of `recall/`
(playwright-core, CDP, the wire sensor). **Both sensors are covered**: the
screen sensor (LS-13) publishes its own L3/L4 transitions directly from its
loop; the wire sensor (LS-13W) has no such loop, so its capture counts/
last-activity are threaded in via `RecallStatusHolder#recordSignal`, called
once from `index.ts`'s single observer chokepoint for every `RecallSignal`
(capture/video/wire alike) — `wire.ts` itself never imports `status.ts`.

`recallSummary(signals, opts?)` (exported from `lucarne-interact/recall`)
turns a collected `RecallSignal[]` stream into the small "what have the
sensors seen" shape a view renders: counts (`captures`/`videos`/
`wireCaptures`) + a recent, de-duplicated, thumbnailed timeline covering all
three signal kinds. Thumbnails use **ffmpeg** (`thumbDataUri`/`videoPoster`)
cross-platform; macOS `sips` is used only as a `darwin` fast path.

## CLI

```sh
npx lucarne-interact <cdpUrl> <verb> [args...]
npx lucarne-interact <cdpUrl> --help
```

`click`, `goto`, and `eval` are rejected as commands before a session is even
constructed — see `BANNED_VERBS` in `src/cli.ts`.

## What stays cadence policy

Not ported here, on purpose: the `FEEDS` channel map and the "no reading
guide for this channel" warning (`open` takes a raw URL — channel awareness
is cadence's job), the `.social/log` action-log sink (this package only
emits `on('action', e)`; where that goes is the consumer's choice), and any
per-platform behavior. `grep -REn "FEEDS|x\.com/home|\.social|channels/"
src/` returns zero hits.

Also not ported: `send`'s **content policy** — banned words, the AI-tell/
"cringe" phrase list, the link allow-list, rate limits (flat + per-platform),
the burst/send-interval guard, always-ask topics, source/sourcing gating,
and the human-approval ledger (`.social/approvals.jsonl`) are all cadence's
`enforce()` + surrounding machinery (`guardrails/enforce.ts`), never
duplicated here. This package only knows the two fields `decideSend` reads
off whatever `GuardrailResult` the caller's `policy(text, ctx)` computes —
`blocked` and `mustAsk` — plus the `approval`/`mode` gate itself.

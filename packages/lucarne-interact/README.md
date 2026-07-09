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

This is the **LS-09 scaffold**: the ACT verbs, enforced pacing, and the
shared video assembler. Humanized typing (LS-10), the gated `send` mechanism
(LS-11), the presence contract (LS-12), and recall — the OBSERVE half, at the
`lucarne-interact/recall` subpath (LS-13/13W/14) — land in later issues on
top of this scaffold.

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
| `video.storyboard(selector, { outDir, frames? })` | `browser.ts:294-317` | keyframes across the video's own duration (a fallback view) |
| `video.clip(selector, outPath)` | `browser.ts:333-379` | record a video to completion (hard-capped), assembled to mp4 |
| `video.captions(selector)` | `browser.ts:394-401` | read the caption transcript from DOM cues (the speech channel) |

Every verb call emits one `action` event and pays one enforced pace — success
or failure. There is no `type`/`send` yet (LS-10/LS-11); typing/sending are
out of scope for this issue.

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
(watched-video capture). This package holds **one** copy —
`startScreencastToFrames` + `assembleMp4FromFrames` — and `video.clip` is its
only caller so far. Recall's screen sensor (LS-13) will import the same two
functions instead of re-implementing the ffmpeg arg-list. There is exactly
one `libx264` reference in this package's `src/`.

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

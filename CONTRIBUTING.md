# Contributing to lucarne

Thanks for helping. lucarne has one non-negotiable rule that makes it what it is.

## The rule: every feature lands with a committed, real-behavior proof

No feature is "done" until a re-runnable acceptance proof in `test/acceptance.mjs`
asserts its **real behavior** and passes — **never an HTTP 200**. "Real behavior"
means the thing that actually matters: a rendered JPEG frame, real-Chrome state, a
valid mp4, an RFC test vector — driven against a real browser. If you can't prove
it, it isn't done. (See the "Proof of completion" section in `ROADMAP.md`.)

## Dev setup

```sh
npm install
npm run build        # tsc → dist/
npm test             # build + run the acceptance suite (needs Google Chrome; ffmpeg for the recording proof)
npm run test:acceptance   # run the suite against an existing build
```

The acceptance suite launches the **native** backend, so it needs Google Chrome
installed locally (and `ffmpeg`/`ffprobe` for the recording proof). It runs in CI
on Linux under `xvfb` with `google-chrome-stable` + `ffmpeg`.

## Conventions

- **TypeScript, strict.** Object keys and imports sorted alphabetically.
- **No fallback chains** — resolve optional config to a default in exactly one named
  place, never scattered `??` at use sites.
- **One runtime dependency** (`ws`). Don't add runtime deps without a strong reason;
  the lean install is a feature. `playwright` etc. are devDependencies (tests only).
- Commits are lowercase **conventional** (`feat(scope): …`, `fix(scope): …`).
- The engine drives every backend over **CDP** — `native` and `docker` differ only in
  *isolation*; view/drive/record are shared code. Keep it that way.

## What's in / out of scope

In scope: the operational toolkit for **your own** durable, authenticated browsers
(drive · watch · record · the porthole · profiles · capture · logs).

Out of scope (deliberately — see `ROADMAP.md`): anti-detect / fingerprint spoofing /
stealth / captcha-solving / proxy networks / a managed cloud. lucarne is the
*authentic* lane; that inversion is the product, not a gap.

## Pull requests

1. Add or extend the acceptance proof for your change; `npm test` green.
2. `npm run build` clean (strict tsc).
3. Conventional commit; describe what the proof asserts.

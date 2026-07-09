# PROOF — LS-02: Engine sticky-injection `POST/GET /sessions/:id/inject`

Branch: `cadence-split/ls-02-inject` (base: `cadence-split/integration` @ `0484b9d`, v1.5.2/1.6.0)

This file is the evidence artifact for the three ACs, following the `PROOF-LS-01.md` convention
(no committed-proof-transcript standard was found for this task other than that precedent).

## What was built

- **`packages/lucarne/src/inject.ts`** (new) — `InjectionStore`, ported from cadence's sticky-
  injection store (`cadence/src/browser/server.ts:124-208`) onto the engine's OWN raw CDP client
  (`src/cdp.ts`), with NO Playwright anywhere:
  - `Page.addScriptToEvaluateOnNewDocument` per accepted id (re-runs on every reload/nav — the
    "sticky" part) + `Runtime.evaluate` into the ALREADY-loaded document (so a script registered
    mid-session doesn't sit inert until the next nav).
  - A LIVE per-page CDP session held for as long as the page is open (`pageSessions`), because
    `Page.setBypassCSP` is bound to the *session's* lifetime, not the page's — cadence's own
    comment (`server.ts:126-127`) is the reason this can't be a call-and-forget.
  - **New-tab coverage without Playwright**: cadence rode a Playwright `BrowserContext`'s
    `context.on('page', ...)`. The engine has no `BrowserContext`, so the store opens the
    session's browser-level CDP endpoint and turns on target discovery
    (`Target.setDiscoverTargets`); `Target.targetCreated` fires for every new page target and is
    applied exactly like an already-open one. `Target.targetDestroyed` releases the per-page
    session when a tab closes. (`Target.setAutoAttach` is deliberately NOT used — it emits
    `attachedToTarget`, not `targetCreated`, and would attach a debugger to every target.)
  - `injectPolicy(id) => boolean` hook (default permissive) gates `set()` (throws on rejection) and
    filters `ids()` (a rejected id is never listed even if a since-changed policy once accepted it).
- **`engine.ts` wiring**: `Tracked.inject: InjectionStore`, created + `.start()`ed unconditionally at
  session spawn (so coverage exists from the moment a caller first calls `/inject`), seeded from a
  restored spec's `opts.inject` on boot-restore, closed on `destroy()`. New methods
  `setInjection()`/`injectionIds()`/`persistInject()` (private — syncs a *durable* session's
  registry entry to its live store snapshot after every set/remove). New routes
  `POST/GET /sessions/:id/inject`, wired before the generic `/sessions/:id` fallback, matching the
  router's existing sequential-`if` style exactly. A thrown policy/validation error is caught in the
  route (not left to the generic 500 handler) and turned into a 400.
- **`types.ts`**: `CreateSessionOptions.inject?: Record<string, StickyDef>` (additive — persisted
  into `LUCARNE_HOME/sessions.json` so `restore()` re-applies it), `EngineOptions.injectPolicy?:
  InjectPolicy` (additive).
- **`openapi.ts`** + **`client.ts`**: `/sessions/{id}/inject` documented (get/post, incl. the 400
  response); `LucarneClient.injections()`/`.setInjection()`/`.removeInjection()` added, matching the
  existing typed-client style.
- **`README.md`**: endpoint row next to `/login`/`/act`; a new bullet in the Security section
  (next to the existing CDP-is-full-control / `/login`-is-not-a-confidentiality-boundary bullets)
  spelling out the CSP-bypass posture — see dev/03 below.
- **`CHANGELOG.md`** + version bump `1.5.2` → `1.6.0` (new capability, backward compatible),
  following the project's existing convention of a version bump per notable change.

Out of scope, confirmed untouched: the widget package (LS-15) and any shell-only predicate — the
`injectPolicy` hook here is a generic accept/reject function; it knows nothing about "shell" or
"content" (that doctrine is cadence's, wired in LS-20).

## dev/01 — committed re-runnable proof (reload / new tab / daemon restart), + no-Chrome unit coverage

**Two files, split exactly along the browser/no-browser line:**

1. **`packages/lucarne/test/acceptance.mjs`** — a new `STICKY INJECTION (LS-02)` section appended
   before the file's final summary (same `check()`/`results` harness as every other proof in the
   file), run via the EXISTING `npm run test:acceptance` (no CI wiring changes needed — it fans out
   through the root script unchanged, same as LS-01 found). It asserts, against a LIVE session:
   - the script is applied to the already-open page immediately after `setInjection()`,
   - **(a)** it survives `Page.reload()`,
   - **(b)** it covers a target opened via `Target.createTarget` (a NEWLY OPENED tab) —
     specifically exercising the raw-CDP target-discovery path, not a Playwright `page` event,
   - **(c)** a SECOND, freshly-constructed `Lucarne` engine (same `registryFile`, after the first
     is gracefully `.close()`d — which keeps the persisted spec) calls `restore()` and the marker
     is present on the restored session's page, both immediately (eval-into-loaded-doc) and after a
     fresh navigation (proving `addScriptToEvaluateOnNewDocument` was actually re-registered from
     the restored spec, not just a one-off eval).

2. **`packages/lucarne/test/inject-unit.mjs`** (new) — everything from this AC that does NOT need
   a browser: `InjectionStore` add/replace/remove/list/snapshot bookkeeping, the `injectPolicy`
   hook (unit-level AND over real HTTP against a fake session seeded directly into the engine — see
   dev/02), and the session-spec persistence round-trip on disk (`persistSpec`/`readReg`/
   `writeReg`/`persistInject`, the ACTUAL code paths the engine uses, not a reimplementation).
   Wired as `npm run test:unit` (root + package script) and into `.github/workflows/ci.yml`'s
   Chrome-free `build` job, so it runs on every push regardless of the Chrome-gated `acceptance`
   job's availability.

**Honest split of what ran in THIS sandbox vs. what's CI-gated:**

```
$ npm run build && npm run typecheck        # both clean, 0 errors (see dev/03)

$ npm run test:unit
...
  PASS  store: starts empty
  PASS  store: set() registers an id
  PASS  store: set() on an existing id replaces (still exactly one entry)
  PASS  store: a second id coexists
  PASS  store: snapshot() carries the raw desired state (source + bypassCSP)
  PASS  store: remove() drops just that id
  PASS  store: remove() of an absent id is a no-op (idempotent, doesn't throw)
  PASS  policy(default): with no policy every id is accepted
  PASS  policy(reject): set() on a rejected id throws (route maps this to 4xx)
  PASS  policy(reject): the rejected id was never stored
  PASS  policy(reject): ids() never lists the rejected id
  PASS  http: accepted id -> 200  — status=200
  PASS  http: policy-rejected id -> 4xx  — status=400
  PASS  http: missing id -> 4xx  — status=400
  PASS  http: GET lists the accepted id and NEVER the rejected one
  PASS  http: remove:true drops it
  PASS  http: unknown session -> 404  — status=404
  PASS  persist: registry file on disk carries the additive `inject` field
  PASS  persist: readReg() round-trips it losslessly
  PASS  persist: persistInject() syncs the registry to the live store's snapshot
  PASS  persist: an ephemeral (non-durable) session is never written into the registry

21/21 passed
```

**`test/acceptance.mjs`'s new `STICKY INJECTION` section (and the whole suite, pre-existing) could
NOT be run to completion in this sandbox** — same pre-existing, sandbox-level reason
`PROOF-LS-01.md` already documented for the unmoved base commit (I re-confirmed it, not assuming
it): a real Chrome (Playwright's bundled Chromium, which IS present here) aborts at launch because
this container blocks unprivileged user namespaces, and the engine has no `--no-sandbox` flag
(out of scope, and adding one would be a real behavior/security change dev/03 forbids):

```
$ ~/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome \
    --headless=new --remote-debugging-port=9301 --user-data-dir=/tmp/x --no-first-run about:blank
[FATAL] No usable sandbox! ... unprivileged user namespaces ...
Received signal 6

$ node -e 'import("...dist/index.js").then(async ({Lucarne}) => {
    const e = new Lucarne({port:7999, token:"t", record:false, chromePath:"<that chrome>"});
    await e.listen();
    try { await e.create({backend:"native", profile:"probe"}); }
    catch (e) { console.log("CREATE FAILED:", e.message); }
  })'
CREATE FAILED: lucarne: CDP never came up on 127.0.0.1:9300
```

Identical failure mode/line to `PROOF-LS-01.md`'s finding — confirmed a sandbox property, not
something this task's code broke. **CI's `acceptance` job installs real Google Chrome via apt on an
unsandboxed Ubuntu runner** and will run the new `STICKY INJECTION` section along with the rest of
`test/acceptance.mjs` unmodified; **CI's `build` job now also runs `npm run test:unit`** (no Chrome
needed) on every push, so the store/policy/persistence half is verified on every commit, not only
when the Chrome-gated job is reachable.

## dev/02 — `injectPolicy` hook: reject "X" → 4xx + never listed; default → accepted

Fully proven in-sandbox (no browser needed — see `inject-unit.mjs`, reproduced above):
- **Unit-level** (`policy(reject)` block): `new InjectionStore(url, (id) => id !== "X")` — `.set("X",
  ...)` throws (`lucarne: injection 'X' rejected by policy`), the id is never stored, and `.ids()`
  never lists it while a co-registered accepted id (`"shell"`) is unaffected.
- **Over real HTTP** (`http:` block): a `Lucarne` engine constructed with
  `injectPolicy: (id) => id !== "X"`, with a fake session seeded directly into `engine.sessions`
  (legitimate here — `/inject` only ever touches `session.inject`, and that `InjectionStore`'s
  `.start()` is never called, so nothing dials the network) —
  `POST /sessions/fake-http/inject {id:"X",...}` → **400**; `GET /sessions/fake-http/inject` lists
  `"shell"` (accepted) and never `"X"`. A separate default-permissive `InjectionStore` (no policy
  argument) accepts an arbitrary id, confirming the "no policy" case stays permissive.

## dev/03 — engine stays playwright-free; README documents the CSP-bypass posture

```
$ grep -rn "playwright" packages/lucarne/src
packages/lucarne/src/openapi.ts:23:   ...?format=text|playwright...        (pre-existing, unrelated to my change)
packages/lucarne/src/engine.ts:166:  function activityLine(e, format: "text" | "playwright")   (pre-existing)
packages/lucarne/src/engine.ts:167:  if (format === "playwright") {                             (pre-existing)
packages/lucarne/src/engine.ts:943: if (fmt === "text" || fmt === "playwright") {                (pre-existing)
```

Honest note: this grep is **not** literally zero — but all four hits are the *string literal*
`"playwright"` used as one of two values for the `/sessions/:id/activity?format=` query parameter
(an activity-log rendering style named after Playwright's call syntax for readability), pre-dating
this task and untouched by it (confirmed identical, same 4 lines, on `cadence-split/integration`
before my changes — see below). **Zero of these are an `import`/`require` of the `playwright`
package**, and I added none:

```
$ git stash && grep -rn "playwright" packages/lucarne/src   # base branch, before this task's diff
(same 4 lines)
$ git stash pop
$ grep -rn "^import.*playwright\|require(.playwright.)" packages/lucarne/src
(no output — no import of the playwright package anywhere in src, before or after this task)
```

`packages/lucarne/src/inject.ts` imports only `./cdp.js` (the engine's own raw CDP client);
`playwright` remains a `devDependency` (used only by the acceptance test suite) and a documented
peer for *driving* sessions the caller opts into — exactly as before this task, unchanged by it.

README: the endpoint is documented in the API table (`README.md`, next to `/login`/`/act`), and a
new Security-section bullet sits right after the pre-existing `/login`-is-not-a-confidentiality-
boundary bullet (the section this task's spec pointed at, `README.md:306-314` in the base branch)
spelling out that `/inject` is arbitrary script execution with an optional CSP bypass — "exactly as
strong as running the script with devtools open" — and that the engine enforces no content policy
of its own (`injectPolicy` only gates *which ids*, not *what source*).

## Known sandbox limitations (same as LS-01, re-confirmed for this task)

- No usable Chrome sandbox (unprivileged user namespaces blocked, no `--privileged`/root) —
  `test/acceptance.mjs` (including the new `STICKY INJECTION` section) cannot run to completion
  here; reproduced identically to `PROOF-LS-01.md`'s finding. CI's `acceptance` job (real Google
  Chrome, unsandboxed Ubuntu runner) is expected to run it unmodified.
- No Docker daemon — irrelevant to this task (no docker-backend changes), noted for completeness.
- This sandbox's npm config has a global `omit=dev` — `npm install --include=dev` was used
  throughout, per the task instructions.

## Commands run (clean output, reproduced above in context)

```
$ npm install --include=dev
$ npm run build          # tsc, 0 errors
$ npm run typecheck       # tsc -b, 0 errors
$ npm run test:unit       # 21/21 passed (see dev/01/dev/02 above)
$ grep -rn "playwright" packages/lucarne/src   # 4 pre-existing, non-import hits (see dev/03)
```

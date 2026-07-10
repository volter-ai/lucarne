# PROOF — LS-01: Monorepo-ify the lucarne repo

Branch: `cadence-split/ls-01-monorepo` (base: `cadence-split/integration` @ `69ee86d`, v1.5.1)

This file is the evidence artifact for the three ACs (no `.claude`/`standards` convention for a
committed proof-transcript file was found other than the ztrack GitHub-issue evidence flow, which
does not apply to a repo-shape task with no live issue — so this is the fallback per instructions).

## What moved

`git mv src test docker <path> packages/lucarne/<path>` (rename-detected, zero content diff — see
"dev/03" below). `package.json` and `tsconfig.json` also moved to `packages/lucarne/` and were
edited there (version bump, `extends` the new root `tsconfig.base.json`); the root gets brand-new
`package.json` / `tsconfig.json` / `tsconfig.base.json` for the workspaces shape.

`clients/python`, `examples/`, `standards/`, `scheduler/`, `.claude/`, and the top-level docs
(README/ROADMAP/CHANGELOG/LICENSE/etc.) were **not moved** — they stay at repo root exactly as
before. Because `packages/lucarne/package.json`'s `files` field (unchanged: `clients`, `dist`,
`docker`, `examples`, `LICENSE`, `README.md`) needs those root-only paths inside the package for
`npm pack`/the acceptance suite, `packages/lucarne/{clients,examples,LICENSE,README.md}` are
**symlinks** to the root originals (`../../clients` etc.) — filesystem reads (e.g. the Python-client
smoke test) see them transparently. `npm pack` does **not** follow symlinks, so `prepack`/`postpack`
scripts swap the symlinks for real copies only for the duration of packing, then restore them —
verified below.

## dev/01 — root is a private workspaces package; build/typecheck clean; acceptance suite honesty

Root `package.json`: `"private": true`, `"workspaces": ["packages/*"]`, scripts fan out via
`--workspaces --if-present` (mirrors `claude-socials/package.json`). Root `tsconfig.base.json`
mirrors `claude-socials/tsconfig.base.json`'s shape; `packages/lucarne/tsconfig.json` now
`"extends": "../../tsconfig.base.json"` and re-states its exact original compiler options
(`rootDir`, `outDir`, `verbatimModuleSyntax`, `lib`, `types`) so build behavior is unchanged (only
`composite: true` is newly added, required for `tsc -b` project references — it does not change
emitted JS).

```
$ npm install --include=dev        # NOTE: this sandbox has a *global* npm config `omit=dev`
...
added 304 packages, and audited 306 packages in 4s
found 0 vulnerabilities

$ npm run build
> lucarne-monorepo@0.0.0 build
> npm run build --workspaces --if-present
> lucarne@1.5.2 build
> tsc
(exit 0, no errors)

$ npm run typecheck
> lucarne-monorepo@0.0.0 typecheck
> tsc -b
(exit 0, no errors — project-reference build via root tsconfig.json -> packages/lucarne)
```

**Acceptance suite — HONEST status: could not run to completion in this sandbox, for a
pre-existing reason unrelated to the move.** `packages/lucarne/test/acceptance.mjs` spawns a real
Chrome (native backend) very early (~line 45). Playwright's bundled Chromium-for-Testing IS present
in this sandbox (`~/.cache/ms-playwright/chromium-1223`) and ffmpeg is present too, so I pointed
`LUCARNE_CHROME` at it and ran the suite — it fails immediately:

```
$ export LUCARNE_CHROME=~/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome
$ node test/acceptance.mjs
Error: lucarne: CDP never came up on 127.0.0.1:9300
    at waitForCdp .../dist/backends/types.js:11:11
    at async Object.start .../dist/backends/native.js:70:9
```

Root-caused by launching Chrome directly: `[FATAL] No usable sandbox!` — this container has
unprivileged user namespaces blocked (no CAP_SYS_ADMIN, no `--privileged`, no `sudo` to work
around it), so Chrome's zygote sandbox init aborts. The engine has no `--no-sandbox` flag and
adding one would be an engine-source change (out of scope for LS-01; also a real behavior/security
change dev/03 forbids). **I confirmed this is NOT something the monorepo move broke**: I reproduced
the identical failure against the unmoved base commit in a separate `git worktree` on
`cadence-split/integration` (v1.5.1, pre-move) with the same `LUCARNE_CHROME`:

```
$ git worktree add /tmp/lucarne-base-check2 cadence-split/integration
$ npm install --include=dev && npm run build
$ LUCARNE_CHROME=... node test/acceptance.mjs
Error: lucarne: CDP never came up on 127.0.0.1:9300     # identical failure, identical line
```

`docker` is also unavailable (`docker: command not found`), so `test:docker`
(`docker-smoke.mjs`) cannot run either, for the same category of reason (no privileged
container runtime in this sandbox).

**What I substituted / did run without a browser**, all from `packages/lucarne` post-move:
- `npm install` (root, workspaces-aware) — clean.
- `npm run build` (fans out to `packages/lucarne`) — clean, 0 errors.
- `npm run typecheck` (`tsc -b` over the root project reference) — clean, 0 errors.
- Engine daemon boot + `/health` (no Chrome needed — proves the HTTP/session scaffold itself runs
  correctly from the new location):
  ```
  $ node dist/cli.js serve --port 7900 --host 127.0.0.1
  lucarne engine on http://127.0.0.1:7900
  $ curl -sf http://127.0.0.1:7900/health
  {"ok": true, "sessions": 0, "ids": []}
  ```
- `npm pack --dry-run --json` file-list parity (below) — no browser needed.
- bin resolution via a real pack + fresh install (below) — no browser needed.

**Conclusion for dev/01**: the buildable/typecheckable, no-Chrome-required surface is fully green
and unchanged by the move. The Chrome- and Docker-dependent acceptance suites are blocked by this
sandbox's container restrictions (no user-namespace sandboxing, no Docker), identically on the
pre-move base commit — i.e. a pre-existing environment limitation, not a regression. **CI
(`.github/workflows/ci.yml`) installs real Google Chrome via apt on a normal Ubuntu runner and will
run the full suite** — I did not need to edit `ci.yml` at all (see dev/03 CI notes) because it only
invokes `npm run build` / `npm run test:acceptance`, which now fan out through the new root scripts
unchanged.

## dev/02 — `npm pack` file-list parity + bin resolution

Built the **unmoved** v1.5.1 source in an isolated `git worktree` (so the comparison is apples to
apples, including compiled `dist/`, which the very first pre-move capture — taken before running
`npm run build` once — had missed):

```
$ git worktree add /tmp/lucarne-base-check cadence-split/integration
$ cd /tmp/lucarne-base-check && npm install --include=dev && npm run build
$ npm pack --dry-run --json > /tmp/pack_baseline_v1.5.1.json   # entryCount 112
```

Then, from `packages/lucarne` post-move (also freshly built):

```
$ npm run build
$ npm pack --dry-run --json > /tmp/pack_after_final.json       # entryCount 112
```

Diff of the two file lists (paths, sorted):

```
$ diff baseline_filelist.txt after_filelist.txt
IDENTICAL FILE LISTS
```

**112/112 paths identical**, including `LICENSE`, `README.md`, `clients/python/lucarne.py`,
`clients/python/pyproject.toml`, `clients/python/README.md`, every `examples/*`, every
`docker/*`, `package.json`, and all of `dist/**` (both `.js` and `.d.ts`/`.map`). Per-file size
diff: only `package.json` differs (1693 → 2067 bytes — expected: version bump `1.5.1` → `1.5.2` +
the new `prepack`/`postpack` scripts); every other one of the 111 remaining files matches size
within a few bytes (embedded paths/timestamps only). This is the "file list identical apart from
[content that intentionally changed for the version bump]" the AC asks for.

Bin resolution, proven the way the AC specifies — via a **real pack + fresh install** (not just the
workspace-local `node_modules/.bin`, which had a flaky bin-linking quirk specific to this sandbox
unrelated to the package's own correctness):

```
$ cd packages/lucarne && npm pack                     # lucarne-1.5.2.tgz, 112 files
$ mkdir /tmp/scratch && cd /tmp/scratch && npm init -y
$ npm install --no-save /path/to/lucarne-1.5.2.tgz
added 297 packages
$ ls node_modules/.bin/
lucarne
lucarne-mcp
$ ./node_modules/.bin/lucarne --help
lucarne — self-hostable browser sessions you can drive, watch, and record
...
$ echo $?
0
$ ./node_modules/.bin/lucarne-mcp --help
$ echo $?
0
```

Both bins resolve and `lucarne --help` exits 0 from a genuine pack-install, matching the AC text
exactly.

## dev/03 — engine public API untouched; package still publishes as `lucarne`

```
$ git diff --cached -M --numstat -- packages/lucarne/src packages/lucarne/test packages/lucarne/docker
(no output — every line is 0 added / 0 removed; git's own 100%-similarity rename detection agrees:)

$ git diff --cached -M --summary | grep rename
 rename {docker => packages/lucarne/docker}/Dockerfile (100%)
 rename {docker => packages/lucarne/docker}/start.sh (100%)
 rename {src => packages/lucarne/src}/... (100%)         # all 24 src files
 rename {test => packages/lucarne/test}/... (100%)       # all 3 test files
```

Zero byte changed under `packages/lucarne/src` (or `test`, or `docker`) — pure `git mv`, history
preserved. `packages/lucarne/package.json` still declares `"name": "lucarne"`; version bumped
`1.5.1` → `1.5.2` (a patch — this move is a repo-shape-only change, no API/behavior change, per
SemVer and the CHANGELOG entry added for it).

Engine stays playwright-free at runtime (peer-only, same as before — unchanged by this task):
```
$ grep -rn "^import.*playwright" packages/lucarne/src
(only src/ imports; playwright remains a devDependency for the acceptance suite + a documented
peer for driving sessions, exactly as pre-move — LS-01 does not touch this)
```

## CI paths

`.github/workflows/ci.yml` needed **no changes** — it only invokes `npm ci` / `npm run build` /
`npm run test:acceptance` at the root, which now fan out to `packages/lucarne` via the new root
scripts. `.github/workflows/docker.yml` (`⚠` touches `.github/workflows/**` — human-required per
`standards/risk-and-review.md`, flagging this explicitly) had its trigger `paths:` and its final
step updated:
- `docker/**`, `src/backends/docker.ts`, `test/docker-smoke.mjs` → prefixed `packages/lucarne/`.
- `run: node test/docker-smoke.mjs` → `run: npm run test:docker` (fans out through root, consistent
  with the other lanes).
`pypi.yml` (builds `clients/python`, which never moved) and `merge.yml` needed no changes.

## Final tree shape

```
lucarne/                       (root — private workspaces package)
  package.json                 workspaces:["packages/*"], fan-out scripts
  package-lock.json            unified workspace lockfile (regenerated)
  tsconfig.json                references packages/lucarne (tsc -b)
  tsconfig.base.json           shared compiler options (mirrors claude-socials)
  clients/python/  examples/  standards/  scheduler/  .claude/  .github/
  README.md  ROADMAP.md  CHANGELOG.md  LICENSE  CONTRIBUTING.md  ...   (unmoved)
  packages/
    lucarne/                   the engine (git mv src/test/docker + package.json + tsconfig.json)
      package.json             name:"lucarne" v1.5.2, unchanged bin/files/scripts/deps
      tsconfig.json            extends ../../tsconfig.base.json, same effective options as before
      src/  test/  docker/     byte-identical content, new location only
      clients -> ../../clients          )  symlinks for filesystem access;
      examples -> ../../examples        )  prepack/postpack swap these for
      LICENSE -> ../../LICENSE          )  real copies only while `npm pack`/
      README.md -> ../../README.md      )  `npm publish` is actually running
```

## Known sandbox limitations (for the next task / a reviewer)

- **No usable Chrome sandbox in this container** (unprivileged user namespaces blocked, no root/
  `--privileged` available) — `test/acceptance.mjs` and `test/attach-acceptance.mjs` cannot run to
  completion here even with a real Chromium binary present. Reproduced identically on the unmoved
  base commit, so this is a sandbox property, not a regression. CI's `ci.yml` installs real Google
  Chrome on a normal (unsandboxed) GitHub-hosted runner and is expected to run the full suite there
  unmodified.
- **No Docker daemon in this container** — `test:docker` / `docker-smoke.mjs` likewise cannot run
  here; `docker.yml`'s dedicated CI lane covers it.
- This sandbox's npm config has a **global `omit=dev`** — any local verification here needs
  `npm install --include=dev` (or `npm ci --include=dev`); a stock CI runner has no such override.
- Workspace-local `node_modules/.bin` bin-linking was intermittently flaky in this specific sandbox
  after repeated `rm -rf node_modules` cycles (an npm/environment quirk, not reproduced via a clean
  single install+build+pack-install cycle); dev/02's bin-resolution proof therefore uses the
  AC-specified pack-install method instead of the local workspace `.bin`, and passes cleanly there.

// LS-09 dev/01 — the anti-bot tier-property test (Chrome-free).
//
// Proves `InteractSession` carries every listed ACT verb and, explicitly, carries NONE of the
// bot-like member names (`click`, `goto`, `go`, `eval`) — the tier property ported from
// cadence's "Intentionally NO 'click' ... NO 'go'/goto ... NO 'eval'" (browser.ts:539-540).
// No cdpUrl connection is ever attempted: the constructor is lazy (it only connects on first
// verb call), so this runs entirely offline.
//
// Run with `node test/tier-property.mjs` (after `npm run build`).
import assert from "node:assert/strict";
import { InteractSession } from "../dist/index.js";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// ── construct with a fake, never-dialed cdpUrl — the constructor must not connect ──
const session = new InteractSession("ws://127.0.0.1:1/never-connects");
check("constructor accepts a bare cdpUrl string without connecting", session instanceof InteractSession);

const sessionFromObj = new InteractSession({ cdpUrl: "ws://127.0.0.1:1/never-connects" });
check("constructor also accepts a { cdpUrl } object (a lucarne engine session shape)", sessionFromObj instanceof InteractSession);

check(
  "constructor without a cdpUrl throws",
  (() => {
    try {
      // eslint-disable-next-line no-new
      new InteractSession("");
      return false;
    } catch {
      return true;
    }
  })(),
);

// ── every listed ACT verb exists, as a callable, on the class/instance surface ──
// 'type' (LS-10) stages humanized keystrokes but never presses Enter. 'send' (LS-11) IS the
// gated verb that commits a staged draft — it belongs on this list now that it has landed; see
// test/send-gate.mjs for its default-refuse decision-table proof.
const REQUIRED_VERBS = ["open", "snap", "scroll", "activate", "back", "capture", "type", "send", "close"];
for (const verb of REQUIRED_VERBS) {
  check(`InteractSession.prototype.${verb} is a function`, typeof InteractSession.prototype[verb] === "function");
}

check("session.video exists", typeof session.video === "object" && session.video !== null);
for (const verb of ["storyboard", "clip", "captions"]) {
  check(`session.video.${verb} is a function`, typeof session.video[verb] === "function");
}

// ── the explicit negative: NO click / goto / go / eval ANYWHERE on the class surface ──
const BANNED = ["click", "goto", "go", "eval"];
const prototypeNames = Object.getOwnPropertyNames(InteractSession.prototype);
const instanceNames = Object.getOwnPropertyNames(session).concat(Object.keys(session.video ?? {}));
for (const banned of BANNED) {
  check(`InteractSession.prototype has NO '${banned}' member`, !prototypeNames.includes(banned));
  check(`InteractSession instance has NO '${banned}' member (incl. video.*)`, !instanceNames.includes(banned));
  check(`session.${banned} is undefined`, session[banned] === undefined);
  check(`session.video.${banned} is undefined`, session.video?.[banned] === undefined);
}

// Belt-and-suspenders: assert.strictEqual-style hard failure if any banned name snuck onto the prototype
// (in addition to the soft `check` bookkeeping above, so this file fails loudly under `node --test` too).
for (const banned of BANNED) {
  assert.equal(prototypeNames.includes(banned), false, `InteractSession.prototype must not have '${banned}'`);
}

// `send` is LS-11's gated verb — it now exists, as a legitimate ACT verb (covered by REQUIRED_VERBS
// above). Kept as its own explicit assertion (distinct from the generic loop) so the tier-property
// story is legible in the test output: send is present, but click/goto/eval are still impossible.
check("InteractSession.prototype has a 'send' member (LS-11 landed)", prototypeNames.includes("send"));
check("session.send is a function", typeof session["send"] === "function");

// ── the CLI rejects the banned words as commands (spawn it as a real subprocess) ──
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
for (const banned of BANNED) {
  let stderr = "";
  let code = 0;
  try {
    execFileSync(process.execPath, [CLI, "ws://127.0.0.1:1/never-connects", banned], { encoding: "utf8", stdio: "pipe" });
  } catch (e) {
    code = e.status ?? 1;
    stderr = String(e.stderr || "");
  }
  check(`CLI rejects '${banned}' as a command (non-zero exit)`, code !== 0);
  check(`CLI rejects '${banned}' with an explanatory message`, /not a lucarne-interact verb/i.test(stderr));
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

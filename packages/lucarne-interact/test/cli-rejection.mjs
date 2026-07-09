// LS-09 dev/01 (CLI half) — the CLI rejects the banned bot-like verbs as commands (Chrome-free).
//
// This exercises the CLI as a real subprocess (no browser, since the banned verbs are rejected
// BEFORE an InteractSession is even constructed) and additionally checks a few non-banned,
// unknown-verb and --help paths behave sanely, so the banned-word rejection is proven to be a
// distinct code path rather than "everything errors anyway".
//
// Run with `node test/cli-rejection.mjs` (after `npm run build`).
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const FAKE_CDP = "ws://127.0.0.1:1/never-connects";

function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stdio: "pipe" });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status ?? 1, stdout: String(e.stdout || ""), stderr: String(e.stderr || "") };
  }
}

for (const banned of ["click", "goto", "go", "eval"]) {
  const r = run([FAKE_CDP, banned]);
  check(`'${banned}' exits non-zero`, r.code !== 0, `code=${r.code}`);
  check(`'${banned}' names the anti-bot tier property in its error`, /anti-bot tier property/i.test(r.stderr));
  check(`'${banned}' never reaches a connection attempt (fast, synchronous-style rejection)`, !/ECONNREFUSED|ENOTFOUND|connect/i.test(r.stderr) || /not a lucarne-interact verb/i.test(r.stderr));
}

// an unrecognized-but-not-banned verb should fail differently (not the tier-property message)
{
  const r = run([FAKE_CDP, "definitely-not-a-real-verb"]);
  check("an unknown non-banned verb exits non-zero too", r.code !== 0);
  check("an unknown non-banned verb does NOT claim the tier-property message", !/anti-bot tier property/i.test(r.stderr));
}

// --help works without a cdpUrl at all
{
  const r = run(["--help"]);
  check("--help exits 0", r.code === 0, `code=${r.code}`);
  check("--help lists the real verbs", /open <url>/.test(r.stdout) && /video-clip/.test(r.stdout));
  check("--help documents the banned verbs are absent", /NO click.*NO goto.*NO eval/.test(r.stdout.replace(/\n/g, " ")));
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

// A module-resolution RECORDER, registered into a child process by `mcp-resolve-log-register.mjs`.
// Every specifier the child's module loader resolves — static or dynamic, at any depth — is appended
// to the file named by `RESOLVE_LOG`. `test/mcp-corpus-only.mjs` uses it to MEASURE (rather than
// assert from source text) that `--corpus-only` never loads `playwright-core`.
import { appendFileSync } from "node:fs";

export async function resolve(specifier, context, next) {
  const log = process.env.RESOLVE_LOG;
  if (log) {
    try {
      appendFileSync(log, specifier + "\n");
    } catch {
      // a recorder that can't write must never break the process it's observing
    }
  }
  return next(specifier, context);
}

// The humanized-typing DRIVE loop — the per-keystroke sequencing + mid-type yield checks, factored
// out of `InteractSession#type` so it is drivable WITHOUT a browser (all I/O is injected). This is
// what makes LS-10 dev/02 (yield-to-human) a real Chrome-free unit test: the test passes mock
// `typeChar`/`inPageProbe`/`activityProbe` callbacks and asserts the loop aborts mid-type with
// `{ yielded: true }`. `InteractSession#type` (session.ts) supplies the real page-backed callbacks.
import { humanDelays } from "./typing.js";
import { type ActivityProbe, type InPageInputProbe, checkHumanYield } from "./presence.js";

export interface TypeLoopResult {
  chars: number;
  typed: number;
  yielded: boolean;
}

export interface TypeLoopDeps {
  /** Dispatch ONE character's keystroke (the real impl uses `page.keyboard.type`). */
  typeChar: (ch: string) => Promise<void>;
  /** Sleep the per-keystroke delay. Injectable so tests run instantly. */
  sleep: (ms: number) => Promise<void>;
  /** PREFERRED yield probe (lucarne's actor-tagged activity). Omit when unavailable. */
  activityProbe?: ActivityProbe;
  /** FALLBACK yield probe (in-page `window.__lastInputAt`). Omit only to test path (a) in isolation. */
  inPageProbe?: InPageInputProbe;
  /** Injectable clock (epoch ms), for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface TypeLoopOptions {
  /** Probe for a human takeover every N characters (default 12, browser.ts:187). */
  yieldCheckEvery: number;
  /** ms since the last detected human input under which we yield (default 1500, browser.ts:189). */
  yieldThresholdMs: number;
}

/**
 * Type `text` one code point at a time, sleeping the model's per-keystroke delay after each, and —
 * every `yieldCheckEvery` characters — checking whether a live human has taken the keyboard. If so,
 * ABORT immediately and report `{ yielded: true }` with however many chars were typed. Ported from
 * the origin app's `typeHuman` (browser.ts:184-195), with the two probe paths delegated to `checkHumanYield`.
 */
export async function runTypeLoop(text: string, opts: TypeLoopOptions, deps: TypeLoopDeps): Promise<TypeLoopResult> {
  const now = deps.now ?? Date.now;
  const chars = [...text];
  const delays = humanDelays(text);
  const every = Math.max(1, Math.round(opts.yieldCheckEvery));
  let lastAgentInputAt = 0;
  for (let i = 0; i < chars.length; i++) {
    if (i > 0 && i % every === 0) {
      const check = await checkHumanYield({
        activityProbe: deps.activityProbe,
        inPageProbe: deps.inPageProbe,
        lastAgentInputAt,
        thresholdMs: opts.yieldThresholdMs,
        now,
      });
      if (check.yield) return { chars: chars.length, typed: i, yielded: true };
    }
    await deps.typeChar(chars[i]!);
    lastAgentInputAt = now();
    await deps.sleep(delays[i]!);
  }
  return { chars: chars.length, typed: chars.length, yielded: false };
}

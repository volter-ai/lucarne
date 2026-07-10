// yield.ts — the PUBLIC surface for "is a human present right now", consumed by
// `InteractSession#type` (session.ts, via type-loop.ts) to yield the keyboard the moment a live
// human appears to grab it back (the origin app's `typeHuman`, browser.ts:184-195).
//
// LS-12 moved the actual decision logic into `presence.ts` — the package-internal module that is
// now the SINGLE HOME for "is a human present + which target is agent-driven" (the other half of
// presence being the driven-target marker + actor attribution, which this file does NOT
// re-export — that stays internal; see presence.ts's own doc header and test/presence.mjs /
// test/presence-export-map.mjs). This file is a thin re-export so `checkHumanYield`'s existing
// public name, shape, and behavior (LS-10, 21 typing + 15 yield tests) are unchanged.
export {
  checkHumanYield,
  type ActivityNowLike,
  type ActivityProbe,
  type ActivitySnapshotLike,
  type InPageInputProbe,
  type YieldCheckInput,
  type YieldCheckResult,
  type YieldProbePath,
} from "./presence.js";

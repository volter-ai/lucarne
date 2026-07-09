// LS-12 dev/01 — the presence contract: the ACT half's marker write + the OBSERVE half's actor
// attribution / tab tie-break read. Chrome-free: the pure functions are tested directly with a
// mock marker/clock; "verbs update the marker" is proven by source-inspection of session.ts (the
// real CDP-backed wiring — #targetIdFor's Target.getTargetInfo round trip — needs a live Chrome
// target and is covered by test/acceptance.mjs, CI-gated).
//
// Run with `node test/presence.mjs` (after `npm run build`).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attributeActor, DEFAULT_ATTRIBUTION_STALE_MS, presenceTieBreakBonus, PresenceTracker } from "../dist/presence.js";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// ══ A. PresenceTracker — the ACT half's single-writer marker ════════════════════════════════════

{
  const tracker = new PresenceTracker();
  check("PresenceTracker starts with no marker", tracker.marker === null);

  const clock = () => 1_000_000;
  const m1 = tracker.record("target-A", clock);
  check("record() writes {drivenTargetId, ts}", m1.drivenTargetId === "target-A" && m1.ts === 1_000_000, JSON.stringify(m1));
  check("marker getter reflects the write", tracker.marker?.drivenTargetId === "target-A" && tracker.marker?.ts === 1_000_000);

  // Single writer: a later verb acting on a DIFFERENT target overwrites (no history kept — this is
  // "which target is CURRENTLY driven", not a log).
  const later = () => 1_000_500;
  tracker.record("target-B", later);
  check("a later record() on a different target overwrites the marker (single writer)", tracker.marker?.drivenTargetId === "target-B" && tracker.marker?.ts === 1_000_500);

  // Default clock (no injected `now`) actually calls Date.now — sanity, not a determinism check.
  const t0 = Date.now();
  tracker.record("target-C");
  check("record() defaults to Date.now() when no clock is injected", tracker.marker !== null && tracker.marker.ts >= t0 && tracker.marker.ts <= Date.now());
}

// ══ B. attributeActor — the OBSERVE half's pure attribution read ════════════════════════════════

const THRESH = DEFAULT_ATTRIBUTION_STALE_MS;
const clockAt = (t) => () => t;

{
  // No marker at all (before any verb has acted) -> human, not driven, no age.
  const none = attributeActor(null, "tab-1", { now: clockAt(1_000_000) });
  check("no marker -> by:'human', driven:false, ageMs:null", none.by === "human" && none.driven === false && none.ageMs === null, JSON.stringify(none));
}

{
  // FRESH marker matching the observed tab -> agent (dev/01's core acceptance assertion).
  const marker = { drivenTargetId: "tab-1", ts: 1_000_000 };
  const fresh = attributeActor(marker, "tab-1", { now: clockAt(1_000_000 + THRESH - 1), staleMs: THRESH });
  check(
    "fresh marker matching the observed tab -> by:'agent'",
    fresh.by === "agent" && fresh.driven === true && fresh.ageMs === THRESH - 1,
    JSON.stringify(fresh),
  );
}

{
  // STALE marker (older than the threshold), same target -> human (dev/01's core acceptance assertion).
  const marker = { drivenTargetId: "tab-1", ts: 1_000_000 };
  const stale = attributeActor(marker, "tab-1", { now: clockAt(1_000_000 + THRESH + 1), staleMs: THRESH });
  check(
    "stale marker (older than threshold), same target -> by:'human'",
    stale.by === "human" && stale.driven === true && stale.ageMs === THRESH + 1,
    JSON.stringify(stale),
  );

  // Boundary: exactly at the threshold is NOT fresh (ageMs < staleMs, strict).
  const boundary = attributeActor(marker, "tab-1", { now: clockAt(1_000_000 + THRESH), staleMs: THRESH });
  check("marker age exactly == staleMs is stale (strict <)", boundary.by === "human", JSON.stringify(boundary));
}

{
  // Fresh marker, but a DIFFERENT tab is being observed -> human (the marker doesn't name this tab).
  const marker = { drivenTargetId: "tab-1", ts: 1_000_000 };
  const otherTab = attributeActor(marker, "tab-2", { now: clockAt(1_000_100), staleMs: THRESH });
  check("fresh marker naming a DIFFERENT tab -> by:'human', driven:false", otherTab.by === "human" && otherTab.driven === false, JSON.stringify(otherTab));
}

{
  // Custom staleMs override is honored (not hardcoded to the default).
  const marker = { drivenTargetId: "tab-1", ts: 1_000_000 };
  const customStale = attributeActor(marker, "tab-1", { now: clockAt(1_000_600), staleMs: 500 });
  check("custom staleMs override (500ms): age 600ms -> stale -> by:'human'", customStale.by === "human", JSON.stringify(customStale));
  const customFresh = attributeActor(marker, "tab-1", { now: clockAt(1_000_400), staleMs: 500 });
  check("custom staleMs override (500ms): age 400ms -> fresh -> by:'agent'", customFresh.by === "agent", JSON.stringify(customFresh));
}

// ══ C. presenceTieBreakBonus — recall's active-tab scoring nudge (recall.ts:78's `+0.5`) ═════════

{
  const marker = { drivenTargetId: "tab-1", ts: 1_000_000 };
  const bonusDriven = presenceTieBreakBonus(marker, "tab-1", { now: clockAt(1_000_100), staleMs: THRESH });
  check("presenceTieBreakBonus: fresh + driven tab -> 0.5", bonusDriven === 0.5, String(bonusDriven));

  const bonusOther = presenceTieBreakBonus(marker, "tab-2", { now: clockAt(1_000_100), staleMs: THRESH });
  check("presenceTieBreakBonus: a different tab -> 0", bonusOther === 0, String(bonusOther));

  const bonusStale = presenceTieBreakBonus(marker, "tab-1", { now: clockAt(1_000_000 + THRESH + 1), staleMs: THRESH });
  check("presenceTieBreakBonus: stale marker -> 0 (agrees with attributeActor)", bonusStale === 0, String(bonusStale));
}

// ══ D. "every verb updates the marker" — source-inspection proof (the CDP-backed live wiring itself
//    needs real Chrome; see test/acceptance.mjs) ═══════════════════════════════════════════════════

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sessionSrc = readFileSync(path.join(PKG_ROOT, "src", "session.ts"), "utf8");

check("session.ts imports PresenceTracker from the shared presence.ts module", /import\s*\{[^}]*PresenceTracker[^}]*\}\s*from\s*"\.\/presence\.js"/.test(sessionSrc));
check("session.ts holds exactly one PresenceTracker instance (single writer per session)", (sessionSrc.match(/new PresenceTracker\(\)/g) ?? []).length === 1);
check("#page() marks the resolved page as driven (every verb that calls #page() is covered)", /async #page\(\)[\s\S]*?await this\.#markDriven\(p\)/.test(sessionSrc));
check("open() marks its resolved page as driven (it doesn't call #page())", /async open\([\s\S]*?await this\.#markDriven\(p\)[\s\S]*?await p\.goto\(/.test(sessionSrc));
check("#markDriven writes into the presence tracker", /#markDriven[\s\S]*?this\.#presence\.record\(/.test(sessionSrc));

// Every verb the spec names (open/snap/scroll/activate/back/capture/type/send) resolves a page via
// `this.#page()` (or, for open(), the explicit #markDriven above) — i.e. none of them can act on a
// page without the marker being written first. Sliced by method signature boundaries (robust to
// nested braces, unlike a brace-matching regex) in the file's actual declaration order.
const METHOD_ORDER = [
  "async open(",
  "async snap(",
  "async scroll(",
  "async activate(",
  "async back(",
  "async capture(",
  "async type(",
  "async send(",
  "async #storyboard(",
];
const bodies = {};
for (let i = 0; i < METHOD_ORDER.length - 1; i++) {
  const start = sessionSrc.indexOf(METHOD_ORDER[i]);
  const end = sessionSrc.indexOf(METHOD_ORDER[i + 1]);
  if (start === -1 || end === -1 || end <= start) continue;
  bodies[METHOD_ORDER[i].replace(/^async |\($/g, "")] = sessionSrc.slice(start, end);
}
check(
  "session.ts's methods were found in the expected declaration order (slicing sanity check)",
  Object.keys(bodies).length === METHOD_ORDER.length - 1,
  Object.keys(bodies).join(","),
);
for (const verb of ["snap", "scroll", "activate", "back", "capture", "type", "send"]) {
  const body = bodies[verb];
  check(`${verb}() resolves its page via #page() (routes through the presence write)`, !!body && /this\.#page\(\)/.test(body), body ? "" : "verb body not found");
}
check("open() does not ALSO call #page() (it marks driven explicitly before goto)", !/this\.#page\(\)/.test(bodies["open"] ?? ""));

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

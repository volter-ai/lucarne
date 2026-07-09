// LS-16 dev/01 fixture — the NEUTRAL widget bundle `WidgetHost.selftest` (src/host.ts) drives as ITS OWN
// committed acceptance proof (test/widget-selftest-acceptance.mjs). Two generic panels ("items"/"log") + a
// pill, built with this package's own framework-free iframe runtime (`createWidget`, src/runtime.ts) — zero
// app-specific content of any kind, purely generic panel/pill/list vocabulary. Because it only ever uses the
// SHELL's own generic classes (`.pill`/`.panel`, from src/shell-css.ts) and never a fixture-specific selector,
// `selftest()` opens/reads it the exact same way it would open/read ANY OTHER consumer's bundle built the same
// way (e.g. a downstream consumer's own, LS-20) — this fixture proves the harness works, it does not
// special-case it.
import { createWidget } from "../../src/runtime.js";

// Substituted at bundle time via `buildSrcdoc`'s `define` option (see the acceptance script) — the iframe's
// `ns` must match the one the host (`WidgetHost.attach`) and injector were built with (runtime.ts's own
// contract), and that `ns` is only chosen at selftest-run time, not at fixture-authoring time.
declare const __LW_NS__: string;

interface FixtureState {
  marker?: string;
  items?: string[];
}

const widget = createWidget({ ns: __LW_NS__, version: 1 });

widget.registerPanel({
  id: "items",
  title: "Items",
  default: true,
  render(el, state) {
    const s = (state ?? {}) as FixtureState;
    el.innerHTML = "";
    const list = document.createElement("ul");
    for (const item of s.items ?? []) {
      const li = document.createElement("li");
      li.textContent = item;
      list.appendChild(li);
    }
    el.appendChild(list);
    const note = document.createElement("p");
    note.className = "marker";
    note.textContent = s.marker ?? "";
    el.appendChild(note);
  },
});

widget.registerPanel({
  id: "log",
  title: "Log",
  render(el, state) {
    const s = (state ?? {}) as FixtureState;
    el.textContent = `log: ${s.marker ?? "(nothing yet)"}`;
  },
});

widget.setPill({ label: "Ready", tone: "live" });
widget.onPatch(() => widget.setPill({ label: "Updated", tone: "live" }));

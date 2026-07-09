// The lucarne-widget/preact ADAPTER — the ONLY file in this package allowed to import `preact` (LS-15 dev/03's
// grep gate enforces this: `grep -rn "preact" packages/lucarne-widget/src --include=*.ts --exclude-dir=preact`
// must be empty). `preact` is an OPTIONAL peer dependency of the package as a whole — importing this subpath is
// what actually requires it to be installed; a consumer who wants a framework-free panel never touches this file.
//
// `mountPanel(Component)` wraps a Preact component as a `PanelDef`/`SheetDef` `render(el, state)` function (see
// `runtime.ts`) — the shape `createWidget`'s registry expects, so wiring a Preact-based panel is mechanical:
//
//   import { createWidget } from "lucarne-widget/runtime";
//   import { mountPanel } from "lucarne-widget/preact";
//   const w = createWidget({ ns: "myapp", version: 1 });
//   w.registerPanel({ id: "capture", title: "Sense", render: mountPanel(CaptureFace) });
//
// `render()` is called again by the runtime every time a new patch merges into `state` — Preact's own diffing
// (not this package's) is what makes that cheap.
import { h, render } from "preact";
import type { ComponentType } from "preact";

/** Adapt a Preact component (receiving `state` as its sole prop) into a `(el, state) => void` panel/sheet renderer. */
export function mountPanel<TState = unknown>(Component: ComponentType<{ state: TState }>): (el: HTMLElement, state: TState) => void {
  return (el: HTMLElement, state: TState): void => {
    render(h(Component, { state }), el);
  };
}

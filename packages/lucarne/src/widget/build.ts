// The srcdoc BUILD HELPER — ported from the prior single-app implementation's `web/app/build.mjs`, generalized:
// any consumer's entrypoint(s) + CSS bundle into ONE self-contained artifact (JS + CSS inlined, no external
// loads) suitable as an `<iframe srcdoc="...">` value — the injector (`injector.ts`) hands this HTML straight
// to the iframe it mounts. `</script>` escaping is the one correctness-critical detail (a literal `</script>`
// inside bundled string content would otherwise terminate the inline `<script>` early and corrupt the page) —
// see `escapeScriptClose` below.
//
// Uses `esbuild` — an OPTIONAL peer dependency, loaded LAZILY (a dynamic `import()` inside `buildSrcdoc`) so
// that installing the engine never pulls a bundler into a consumer that only mints/drives sessions. A consumer
// builds their OWN bundle entrypoint with this at THEIR build time (e.g. their own `web/app/src/entry.tsx`,
// LS-20) and installs `esbuild` alongside; a missing peer surfaces as the named error below, not a module-load
// crash at import time.
import type { build as esbuildBuild } from "esbuild";

/** Load the optional `esbuild` peer, or throw an error that NAMES the missing peer and how to install it. */
async function loadEsbuild(): Promise<typeof esbuildBuild> {
  try {
    return (await import("esbuild")).build;
  } catch (e) {
    throw new Error(
      "lucarne/widget/build: the optional peer dependency 'esbuild' is not installed — " +
        `run \`npm install esbuild\` to use buildSrcdoc (${(e as Error)?.message ?? String(e)})`,
    );
  }
}

export interface BuildSrcdocOptions {
  /** One or more bundle entrypoints (paths), bundled together — matches esbuild's own `entryPoints`. */
  entryPoints: string | string[];
  /** Already-assembled CSS text (e.g. this package's shell chrome + the consumer's own panel/organ styles). */
  css?: string;
  /** `<title>` of the built document. Defaults to `"widget"`. */
  title?: string;
  /** Minify the JS bundle. Defaults to `true` (this ships inline in every page it's injected into). */
  minify?: boolean;
  /** `jsxImportSource` for `.tsx`/`.jsx` entrypoints using the automatic JSX runtime. This package stays framework-neutral: unset by default (esbuild's own default applies); a consumer using a UI library (e.g. via the dedicated adapter subpath) passes its own import source explicitly. */
  jsxImportSource?: string;
  /** `esbuild`'s `define` map, passed through unchanged (e.g. build-time flags/version stamps). */
  define?: Record<string, string>;
}

export interface BuildSrcdocResult {
  /** The one self-contained `<!doctype html>` document — hand this straight to `WidgetHost.attach({ html })`. */
  html: string;
  /** The bundled (minified, `</script>`-escaped) JS, before HTML-wrapping — exposed for a consumer's own diagnostics/tests. */
  js: string;
  /** The CSS text as given (echoed back for convenience/tests). */
  css: string;
}

/** A literal `</script>` (any case) inside bundled JS would terminate the inline `<script>` tag early — escape the slash so the browser still executes the identical program text (`<\/script>` parses to the same JS string). */
function escapeScriptClose(js: string): string {
  return js.replace(/<\/script>/gi, "<\\/script>");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

/** Bundle `entryPoints` + `css` into one self-contained srcdoc HTML document. */
export async function buildSrcdoc(opts: BuildSrcdocOptions): Promise<BuildSrcdocResult> {
  const entryPoints = Array.isArray(opts.entryPoints) ? opts.entryPoints : [opts.entryPoints];
  const esbuild = await loadEsbuild();
  const result = await esbuild({
    entryPoints,
    bundle: true,
    minify: opts.minify ?? true,
    format: "iife",
    write: false,
    jsx: "automatic",
    jsxImportSource: opts.jsxImportSource,
    loader: { ".tsx": "tsx", ".ts": "ts", ".jsx": "jsx" },
    define: opts.define,
  });
  const outputFile = result.outputFiles?.[0];
  if (!outputFile) throw new Error("lucarne/widget: esbuild produced no output file");
  const js = escapeScriptClose(outputFile.text);
  const css = opts.css ?? "";
  const title = escapeHtml(opts.title ?? "widget");
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
    `<style>${css}</style></head><body><div id="app"></div><script>${js}</script></body></html>`;
  return { html, js, css };
}

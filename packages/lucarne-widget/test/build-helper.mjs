// LS-15 dev/01 — the build-helper acceptance proof (Chrome-free): a neutral sample entrypoint + CSS bundle into
// ONE self-contained srcdoc HTML — no external URLs, and a literal `</script>` in bundled content survives
// escaping (does not terminate the wrapping <script> tag early).
//
// Run with `node test/build-helper.mjs` (after `npm run build`).
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSrcdoc } from "../dist/build.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const CSS = ".sample { color: red; background: rgba(0,0,0,.2) }";
const { html, js, css } = await buildSrcdoc({
  entryPoints: [resolve(__dirname, "fixtures/sample-entry.js")],
  css: CSS,
  title: "Sample Widget",
  minify: false, // keep the marker string trivially greppable in the assertions below
});

check("produced a doctype HTML document", html.trim().toLowerCase().startsWith("<!doctype html>"));
check("echoes the CSS text back unchanged", css === CSS);
check("embeds the given CSS inline (a <style> tag, not a <link>)", html.includes(`<style>${CSS}</style>`) && !/<link\b/i.test(html));
check("embeds the bundled JS inline (no external <script src=…>)", html.includes("<script>") && !/<script[^>]+src=/i.test(html));
check("no external URLs anywhere in the document", !/https?:\/\//i.test(html));
check("the bundled JS still carries the fixture's marker string", js.includes("contains a literal"));
check(
  "a literal </script> inside bundled content is ESCAPED in the JS (not left to terminate the tag early)",
  !/<\/script>/i.test(js) && /<\\\/script>/i.test(js),
);
// Cross-check on the assembled document: exactly one un-escaped `</script>` should survive — the wrapper's own
// closing tag. If the fixture's literal leaked through unescaped, this count would be 2 (and the document would
// be truncated mid-bundle by the browser's HTML parser).
const literalCloses = (html.match(/<\/script>/gi) || []).length;
check("exactly one literal </script> in the final HTML (the wrapper's own closing tag)", literalCloses === 1, `found ${literalCloses}`);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

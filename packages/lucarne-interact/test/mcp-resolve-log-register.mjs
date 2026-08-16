// `node --import ./test/mcp-resolve-log-register.mjs <script>` installs the resolution recorder
// (see mcp-resolve-log-hooks.mjs) before the script's own module graph is loaded.
import { register } from "node:module";

register("./mcp-resolve-log-hooks.mjs", import.meta.url);

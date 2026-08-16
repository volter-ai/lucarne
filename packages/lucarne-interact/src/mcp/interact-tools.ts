/**
 * The INTERACT-VERB half of the one platform MCP: every tool here is a thin wrapper over an
 * `InteractSession` verb, taking the session's `cdpUrl` as its first argument.
 *
 * The charter is inviolable and STRUCTURAL, exactly as it is on the class itself (session.ts's
 * header): there is no `click` tool, no `goto` tool, and no `eval` tool — a bot-like action that
 * isn't one of the verbs below physically cannot be issued through this server. `type` STAGES text
 * and never presses Enter; `send` is the single code path that can submit, and it runs the same
 * `decideSend` gate (send-gate.ts, a byte-identical port of the origin app's own) that the library
 * does — default REFUSE, with zero keypress dispatched on any refusing branch.
 *
 * Every verb is followed by this package's enforced human-paced dwell (pacing.ts) because the pause
 * lives inside `InteractSession` itself, not in this wrapper: an MCP client cannot pace-skip by
 * calling the tool in a loop.
 *
 * `test/mcp-charter-gate.mjs` is the standing proof of the two structural properties (no banned
 * verb name is registered; the registered set is exactly the reviewed allowlist).
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InteractSession } from "../session.js";
import type { SendApproval } from "../send-flow.js";

/** Every interact tool's first argument: which session (by its raw CDP endpoint) to act in. */
const cdpUrlSchema = z
  .string()
  .min(1)
  .describe("The lucarne session's CDP endpoint (`cdpUrl`, e.g. from lucarne_create/lucarne_list). Every verb acts inside THAT already-open session — this server never mints a browser of its own.");

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

function fail(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return `lucarne-mcp error: ${(e as { message: string }).message}`;
  return `lucarne-mcp error: ${String(e)}`;
}

/**
 * Run one verb against a fresh `InteractSession` bound to `cdpUrl`, then release the playwright
 * connection (never the lucarne session itself — `close()` only drops this process's CDP
 * connection, see session.ts). One connection per call is what makes each tool call independent:
 * an MCP client's calls may be minutes apart, and a held connection would be the thing that breaks.
 */
async function withSession<T>(cdpUrl: string, fn: (session: InteractSession) => Promise<T>): Promise<T> {
  const session = new InteractSession(cdpUrl);
  try {
    return await fn(session);
  } finally {
    await session.close().catch(() => {});
  }
}

/** Wrap a verb body so a thrown error becomes an MCP tool error rather than a transport failure. */
async function run<T>(fn: () => Promise<T>) {
  try {
    return ok(await fn());
  } catch (e) {
    return fail(errorMessage(e));
  }
}

/**
 * `send()`'s standing MODE is the SERVER OPERATOR's, not the agent's: an agent argument for "am I
 * in yolo mode" would be a gate that gates nothing. `LUCARNE_SEND_MODE=yolo` (set by whoever
 * launches the bin) is the only way to leave the default `ask` posture; `approved`/`ack` stay
 * per-call signals, exactly as `--approved`/`--ack` are per-send flags on a CLI. Everything else
 * about the decision — the priority order, the refusal actions, the zero-keypress-on-refuse
 * property — is `decideSend`'s, untouched.
 */
function resolveSendMode(env: NodeJS.ProcessEnv | Record<string, string | undefined>): "ask" | "yolo" {
  return env.LUCARNE_SEND_MODE?.trim().toLowerCase() === "yolo" ? "yolo" : "ask";
}

export interface InteractToolsOptions {
  /** Env source for the send mode (defaults to `process.env`; pass a plain object in tests). */
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

export function registerInteractTools(server: McpServer, opts: InteractToolsOptions = {}): void {
  const env = opts.env ?? process.env;

  server.registerTool(
    "lucarne_open",
    {
      description:
        "The single sanctioned bootstrap navigation: open a URL in the session. This is the ONLY " +
        "way to reach a page through this server — there is deliberately no deep-linking `goto` " +
        "verb for arbitrary in-app jumps. Returns the landed URL and the tab's CDP targetId.",
      inputSchema: {
        cdpUrl: cdpUrlSchema,
        url: z.string().min(1).describe("Absolute URL to open."),
        newTab: z.boolean().optional().describe("Force a genuinely new tab instead of navigating the session's current one."),
      },
    },
    async ({ cdpUrl, url, newTab }) => run(() => withSession(cdpUrl, (s) => s.open(url, { newTab }))),
  );

  server.registerTool(
    "lucarne_snap",
    {
      description:
        "READ the page as an ARIA snapshot — the accessibility tree a screen reader would see. " +
        "This is the only read verb for page structure (there is no HTML-dump or DOM-query tool). " +
        "Scope it with a selector and bound the output with maxLines.",
      inputSchema: {
        cdpUrl: cdpUrlSchema,
        selector: z.string().optional().describe("CSS selector to scope the snapshot. Defaults to 'body'."),
        maxLines: z.number().int().min(1).max(2000).optional().describe("Max lines of snapshot text to return. Default 120."),
      },
    },
    async ({ cdpUrl, selector, maxLines }) => run(() => withSession(cdpUrl, (s) => s.snap(selector, maxLines))),
  );

  server.registerTool(
    "lucarne_scroll",
    {
      description: "Scroll the page by keyboard (PageDown x n) — the same gesture a human at the keyboard makes. Returns how many pages were scrolled.",
      inputSchema: {
        cdpUrl: cdpUrlSchema,
        n: z.number().int().min(1).max(50).optional().describe("How many PageDown presses. Default 1."),
      },
    },
    async ({ cdpUrl, n }) => run(() => withSession(cdpUrl, (s) => s.scroll(n))),
  );

  server.registerTool(
    "lucarne_activate",
    {
      description:
        "Keyboard-activate a NAVIGATION-shaped control (focus + Enter) — links, tabs, disclosure " +
        "toggles, textareas. A structural default-REFUSE classifier runs first: a form-submit, " +
        "publish, or otherwise state-changing control is refused, and no consumer policy can " +
        "allowlist a submit control. This verb navigates; it can never publish. Submitting is " +
        "lucarne_send's job alone.",
      inputSchema: {
        cdpUrl: cdpUrlSchema,
        selector: z.string().min(1).describe("CSS selector of the control to focus and activate."),
      },
    },
    async ({ cdpUrl, selector }) => run(() => withSession(cdpUrl, (s) => s.activate(selector))),
  );

  server.registerTool(
    "lucarne_back",
    {
      description:
        "Go back: an in-app Back control when one matches (and passes the same activation gate), " +
        "else browser history. Returns which path it took and whether the URL actually changed.",
      inputSchema: {
        cdpUrl: cdpUrlSchema,
        inAppSelectors: z.array(z.string().min(1)).optional().describe("Selectors tried, in order, for an in-app Back control before falling back to history. Overrides the generic ARIA default."),
      },
    },
    async ({ cdpUrl, inAppSelectors }) => run(() => withSession(cdpUrl, (s) => s.back(inAppSelectors ? { inAppSelectors } : {}))),
  );

  server.registerTool(
    "lucarne_capture",
    {
      description: "Screenshot one element (by selector) to a file via CDP — invisible to the page. Returns the written path.",
      inputSchema: {
        cdpUrl: cdpUrlSchema,
        selector: z.string().min(1).describe("CSS selector of the element to capture."),
        outPath: z.string().min(1).describe("Filesystem path to write the PNG to (parent directories are created)."),
      },
    },
    async ({ cdpUrl, selector, outPath }) => run(() => withSession(cdpUrl, (s) => s.capture(selector, outPath))),
  );

  server.registerTool(
    "lucarne_type",
    {
      description:
        "STAGE text into whatever is focused, with humanized per-keystroke timing. NEVER presses " +
        "Enter and never submits — staging and sending are separate by construction. Yields (stops " +
        "mid-text) the moment a live human appears to be typing. Submitting a staged draft is " +
        "lucarne_send.",
      inputSchema: {
        cdpUrl: cdpUrlSchema,
        text: z.string().min(1).describe("The text to type into the focused element."),
      },
    },
    async ({ cdpUrl, text }) => run(() => withSession(cdpUrl, (s) => s.type(text))),
  );

  server.registerTool(
    "lucarne_send",
    {
      description:
        "The ONE path that can submit. DEFAULT-REFUSES: without an explicit approval the call " +
        "returns action:'needs-approval' and dispatches ZERO keystrokes. An always-ask policy " +
        "result needs `ack` even when approved; a blocked policy result refuses unconditionally. " +
        "After a GO it still verifies the focused composer actually holds this exact draft before " +
        "the gesture fires (action:'composer-mismatch' otherwise, again with no keypress). The " +
        "standing mode is the server operator's (LUCARNE_SEND_MODE), never an agent argument.",
      inputSchema: {
        cdpUrl: cdpUrlSchema,
        text: z.string().min(1).describe("The draft to submit — must already be staged in the focused composer (see lucarne_type)."),
        key: z.string().optional().describe("Keyboard gesture that submits in this composer, e.g. 'Meta+Enter'. Exactly one of key/submit must be given."),
        submit: z.string().optional().describe("Selector of a submit control to keyboard-activate instead of a key gesture. Exactly one of key/submit must be given."),
        approved: z.boolean().optional().describe("The human's explicit per-send approval. Without it (or `ack`), an ask-mode send refuses."),
        ack: z.boolean().optional().describe("Explicit acknowledgement of an always-ask topic. Also counts as an approval."),
      },
    },
    async ({ cdpUrl, text, key, submit, approved, ack }) => {
      if ((key === undefined) === (submit === undefined)) {
        return fail("lucarne-mcp error: lucarne_send needs exactly one of `key` (a keyboard gesture) or `submit` (a submit-control selector)");
      }
      const approval: SendApproval = { mode: resolveSendMode(env), approved, ack };
      return run(() =>
        withSession(cdpUrl, (s) =>
          s.send(text, {
            gesture: key !== undefined ? { key } : { submit: submit as string },
            // No content rules are computed here — policy is the CALLER's, exactly as it is in the
            // library (send-flow.ts). A neutral result means the decision rests entirely on the
            // approval signals above, which is the same default-refuse posture `decideSend` encodes.
            policy: () => ({}),
            approval,
          }),
        ),
      );
    },
  );

  server.registerTool(
    "lucarne_video_storyboard",
    {
      description: "WATCH a video as a storyboard: seek across its own duration and write keyframe PNGs. Returns the duration and each frame's timestamp + path.",
      inputSchema: {
        cdpUrl: cdpUrlSchema,
        selector: z.string().min(1).describe("CSS selector of the video (or a container holding one)."),
        outDir: z.string().min(1).describe("Directory to write the keyframe PNGs into."),
        frames: z.number().int().min(2).max(60).optional().describe("How many keyframes across the video's duration. Default 9."),
      },
    },
    async ({ cdpUrl, selector, outDir, frames }) => run(() => withSession(cdpUrl, (s) => s.video.storyboard(selector, { outDir, frames }))),
  );

  server.registerTool(
    "lucarne_video_clip",
    {
      description: "WATCH a video to completion (under a hard time cap) and assemble what played into an mp4. Returns the mp4 path, frame count, and whether it watched to completion.",
      inputSchema: {
        cdpUrl: cdpUrlSchema,
        selector: z.string().min(1).describe("CSS selector of the video (or a container holding one)."),
        outPath: z.string().min(1).describe("Filesystem path to write the mp4 to."),
      },
    },
    async ({ cdpUrl, selector, outPath }) => run(() => withSession(cdpUrl, (s) => s.video.clip(selector, outPath))),
  );

  server.registerTool(
    "lucarne_video_captions",
    {
      description: "Read a video's caption transcript — the speech channel — from its own track cues, falling back to an on-screen caption overlay.",
      inputSchema: {
        cdpUrl: cdpUrlSchema,
        selector: z.string().min(1).describe("CSS selector of the video (or a container holding one)."),
        overlaySelectors: z.array(z.string().min(1)).optional().describe("Selectors for a caption OVERLAY, tried only when the video carries no track cues. Overrides the generic defaults."),
      },
    },
    async ({ cdpUrl, selector, overlaySelectors }) =>
      run(() => withSession(cdpUrl, (s) => s.video.captions(selector, overlaySelectors ? { overlaySelectors } : {}))),
  );
}

/** The tool names this module registers — the reviewed allowlist `test/mcp-charter-gate.mjs` pins. */
export const INTERACT_TOOL_NAMES = [
  "lucarne_open",
  "lucarne_snap",
  "lucarne_scroll",
  "lucarne_activate",
  "lucarne_back",
  "lucarne_capture",
  "lucarne_type",
  "lucarne_send",
  "lucarne_video_storyboard",
  "lucarne_video_clip",
  "lucarne_video_captions",
] as const;

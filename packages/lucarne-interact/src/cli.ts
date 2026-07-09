#!/usr/bin/env node
// Thin CLI for the ACT verbs — a debugging/scripting convenience over InteractSession.
// The anti-bot tier property is enforced here too: click/goto/eval are refused BEFORE a
// session is even constructed (they are not verbs — see session.ts's closing comment).
import { InteractSession } from "./session.js";

// Bot-like actions that are not, and will never be, verbs on InteractSession (browser.ts:539-540).
export const BANNED_VERBS = new Set(["click", "goto", "go", "eval"]);

const HELP = `lucarne-interact — the non-bot-like interaction plane (act verbs + enforced pacing)

Usage: lucarne-interact <cdpUrl> <verb> [args...]

Verbs:
  open <url>                              the single sanctioned bootstrap navigation
  snap [selector] [maxLines]              ARIA snapshot (read-only; default selector "body")
  scroll [n]                              keyboard PageDown x n (default 1)
  activate <selector>                     keyboard-first activation (focus + Enter)
  back                                    in-app Back control, else browser history
  capture <selector> <outPath>            element screenshot via CDP (invisible to the page)
  video-storyboard <selector> <outDir> [frames]   keyframe storyboard across the video's own duration
  video-clip <selector> <outPath>         record a video to completion (hard cap) -> mp4
  video-captions <selector>               read a video's caption transcript (the speech channel)

NO click - NO goto - NO eval - those are not verbs here (bot-like actions physically cannot be issued).
Every verb is followed by an ENFORCED human pause (normal distribution, always-positive floor).
Set LUCARNE_INTERACT_DEBUG=1 to print each 'action' event (verb, timing, paced dwell) to stderr.
`;

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function main(): Promise<void> {
  const [cdpUrl, verb, ...rest] = process.argv.slice(2);

  const askedForHelp = cdpUrl === "--help" || cdpUrl === "-h" || verb === "--help" || verb === "-h";
  if (askedForHelp) {
    console.log(HELP);
    process.exit(0);
  }
  if (!cdpUrl || !verb) {
    console.log(HELP);
    process.exit(1);
  }

  if (BANNED_VERBS.has(verb)) {
    die(
      `✗ '${verb}' is not a lucarne-interact verb — click/goto/eval do not exist on InteractSession ` +
        `(the anti-bot tier property). See --help for the actual verb list.`,
    );
  }

  const session = new InteractSession(cdpUrl);
  if (process.env.LUCARNE_INTERACT_DEBUG) {
    session.on("action", (e) => console.error("[action]", JSON.stringify(e)));
  }

  try {
    switch (verb) {
      case "open":
        console.log(JSON.stringify(await session.open(rest[0] ?? die("usage: open <url>"))));
        break;
      case "snap":
        console.log(await session.snap(rest[0], rest[1] !== undefined ? Number(rest[1]) : undefined));
        break;
      case "scroll":
        console.log(JSON.stringify(await session.scroll(rest[0] !== undefined ? Number(rest[0]) : undefined)));
        break;
      case "activate":
        console.log(JSON.stringify(await session.activate(rest[0] ?? die("usage: activate <selector>"))));
        break;
      case "back":
        console.log(JSON.stringify(await session.back()));
        break;
      case "capture":
        console.log(
          JSON.stringify(
            await session.capture(
              rest[0] ?? die("usage: capture <selector> <outPath>"),
              rest[1] ?? die("usage: capture <selector> <outPath>"),
            ),
          ),
        );
        break;
      case "video-storyboard":
        console.log(
          JSON.stringify(
            await session.video.storyboard(rest[0] ?? die("usage: video-storyboard <selector> <outDir> [frames]"), {
              outDir: rest[1] ?? die("usage: video-storyboard <selector> <outDir> [frames]"),
              frames: rest[2] !== undefined ? Number(rest[2]) : undefined,
            }),
          ),
        );
        break;
      case "video-clip":
        console.log(
          JSON.stringify(
            await session.video.clip(
              rest[0] ?? die("usage: video-clip <selector> <outPath>"),
              rest[1] ?? die("usage: video-clip <selector> <outPath>"),
            ),
          ),
        );
        break;
      case "video-captions":
        console.log(JSON.stringify(await session.video.captions(rest[0] ?? die("usage: video-captions <selector>"))));
        break;
      default:
        die(`unknown verb: ${verb}\n\n${HELP}`);
    }
  } finally {
    await session.close();
  }
}

main().catch((e) => {
  console.error("ERROR:", e && e.message ? e.message : e);
  process.exit(1);
});

# lucarne examples

Each runs against a local daemon — start one first:

```sh
npx lucarne serve
```

| file | what it shows |
|---|---|
| [`drive.ts`](./drive.ts) | mint a session, drive it with vanilla Playwright over `cdpUrl` |
| [`computer-use.ts`](./computer-use.ts) | high-level actions (click/type/scroll/screenshot) + the activity feed — the agent path |
| [`record-and-replay.ts`](./record-and-replay.ts) | pull recording segments / bytes, or open the built-in replay player |
| [`supervised-login.ts`](./supervised-login.ts) | store a credential, inject it server-side (the agent never sees the password/TOTP) |
| [`embed-porthole.html`](./embed-porthole.html) | `<iframe>` a session's porthole into your own page (read-only / with controls) |
| [`python_drive.py`](./python_drive.py) | drive from Python via the stdlib client + Playwright |
| [`mcp-config.json`](./mcp-config.json) | wire the `lucarne-mcp` server into an MCP client |

The `.ts` files run on Node 22+ with `node --experimental-strip-types examples/<file>.ts`.

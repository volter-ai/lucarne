# Security policy

## The trust model (read this before exposing lucarne)

lucarne runs **real browsers logged into real accounts**. Treat access to a lucarne
daemon as access to those accounts.

- **CDP is full, unauthenticated control of the browser.** The `cdpUrl` lucarne
  returns lets any client navigate, read cookies, and act as the logged-in user.
  It stays on `127.0.0.1`; **never expose a `cdpUrl`** to another host. Drivers and
  agents run on the same machine.
- **The daemon binds to loopback by default.** If you bind to a non-loopback host,
  you **must** set a token (`LUCARNE_TOKEN` / `new Lucarne({ token })`). The token
  gates the control API **and** the porthole (HTTP + WebSocket). lucarne does not
  ship tunneling or a fleet UI — those belong to whatever consumes it, which is
  also where the network auth boundary lives.
- **Credentials at rest** (the credentials API) are AES-256-GCM encrypted under a
  machine-local `0600` key; the HTTP layer only ever returns *blurred* views and
  injects secrets server-side, so the secret never leaves the host.
- **The native backend is *you*** — your real Chrome profile, fingerprint, and
  residential IP. That is the point (the authentic lane), and it is also why a
  lucarne host is as sensitive as your logged-in browser.

## Supported versions

Pre-1.0: only the latest published `0.x` receives fixes. Pin a version and read the
CHANGELOG before upgrading — the API may change between minor releases until 1.0.

## Reporting a vulnerability

Please **do not** open a public issue for a security problem. Report it privately
via GitHub Security Advisories (the "Report a vulnerability" button on the
repository's Security tab), or open a minimal private channel with the maintainer.
Include a repro and the impact. You'll get an acknowledgement; fixes for confirmed
issues ship in a patch release with credit unless you prefer otherwise.

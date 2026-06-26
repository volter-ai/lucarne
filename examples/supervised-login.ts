// Supervised login: store a credential (encrypted at rest), then have the daemon
// inject it into a page server-side — the agent logs in WITHOUT ever seeing the
// password or TOTP. RFC-6238 TOTP is computed by the daemon at fill time.
// Run a daemon first:  npx lucarne serve
// then:  node --experimental-strip-types examples/supervised-login.ts   (Node 22+)
const base = process.env.LUCARNE_URL ?? "http://127.0.0.1:7800";
const token = process.env.LUCARNE_TOKEN;
const h: Record<string, string> = { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };

// 1. store the secret once (it never leaves the daemon after this)
await fetch(`${base}/credentials/acme`, {
  method: "PUT",
  headers: h,
  body: JSON.stringify({ username: "me@example.com", password: "s3cr3t", totp: "JBSWY3DPEHPK3PXP" }),
});

// 2. create a session and point it at the login page
const s = await (await fetch(`${base}/sessions`, { method: "POST", headers: h, body: JSON.stringify({ profile: "demo-login", backend: "native" }) })).json();
console.log("watch the login happen:", s.viewUrl);
// (navigate s.cdpUrl to your login page with Playwright, or via the porthole…)

// 3. fill + submit from the store — the agent supplies only selectors, never the secret
const filled = await (await fetch(`${base}/sessions/${s.id}/login`, {
  method: "POST",
  headers: h,
  body: JSON.stringify({
    credential: "acme",
    userSelector: "#email",
    passSelector: "#password",
    totpSelector: "#otp",
    submitSelector: "button[type=submit]",
  }),
})).json();
console.log("filled fields:", filled); // e.g. { filled: ["username","password","totp"] }

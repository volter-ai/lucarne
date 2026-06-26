// Computer-use: drive a session with high-level actions (no CDP), the same way
// an agent would over the porthole input plane. Run a daemon first: npx lucarne serve
// then:  node --experimental-strip-types examples/computer-use.ts   (Node 22+)
import { LucarneClient } from "lucarne";

const lucarne = new LucarneClient({ baseUrl: process.env.LUCARNE_URL, token: process.env.LUCARNE_TOKEN });

const s = await lucarne.create({ profile: "demo-cu", backend: "native" });
console.log("watch live:", s.viewUrl);

// click, type, scroll, and grab a screenshot — all over the same input plane the
// human porthole uses, so a watcher sees every action as it happens.
await lucarne.act(s.id, { action: "move", x: 200, y: 200 });
await lucarne.act(s.id, { action: "click", x: 200, y: 200 });
await lucarne.act(s.id, { action: "type", text: "hello from an agent" });
await lucarne.act(s.id, { action: "scroll", x: 200, y: 200, dy: 400 });

const png = await lucarne.screenshot(s.id); // Uint8Array of PNG bytes
console.log("screenshot bytes:", png.length);

// What did the human/agent just do? An agent-readable feed (actor-tagged).
const { now, recent } = await lucarne.activity(s.id);
console.log("now:", now);
console.log("recent:", recent.slice(-3));

import { VERSION } from "./version.js";

/** A hand-maintained OpenAPI 3.1 description of the lucarne control API. */
export const openApiSpec = {
  openapi: "3.1.0",
  info: { title: "lucarne", version: VERSION, description: "Self-hostable browser sessions you can drive, watch, and record." },
  paths: {
    "/health": { get: { summary: "Liveness + session count", responses: { "200": { description: "ok" } } } },
    "/sessions": {
      get: { summary: "List sessions (filter by ?meta.key=val)", responses: { "200": { description: "Session[]" } } },
      post: { summary: "Create a session", responses: { "200": { description: "Session" } } },
      delete: { summary: "Release all sessions", responses: { "200": { description: "{released}" } } },
    },
    "/sessions/{id}": {
      get: { summary: "Get a session", responses: { "200": { description: "Session" } } },
      delete: { summary: "Destroy a session", responses: { "200": { description: "{ok}" } } },
    },
    "/sessions/{id}/status": { get: { summary: "Rich status (uptime/idle/dims/stats)", responses: { "200": { description: "SessionStatus" } } } },
    "/sessions/{id}/touch": { post: { summary: "Reset the inactivity clock", responses: { "200": { description: "{ok}" } } } },
    "/sessions/{id}/tabs": { get: { summary: "List tabs", responses: { "200": { description: "{active,tabs}" } } } },
    "/sessions/{id}/tabs/{targetId}": { post: { summary: "Switch active tab", responses: { "200": { description: "{ok}" } } } },
    "/sessions/{id}/logs": { get: { summary: "Logs (network/console/browser); ?stream=1 for SSE", responses: { "200": { description: "LogEntry[]" } } } },
    "/sessions/{id}/activity": { get: { summary: "Agent-readable activity feed (what human/agent did); ?format=text|playwright, ?stream=1 for SSE", responses: { "200": { description: "{now,recent}" } } } },
    "/sessions/{id}/content": { get: { summary: "Rendered HTML", responses: { "200": { description: "text/html" } } } },
    "/sessions/{id}/act": { post: { summary: "Computer-use action (click/move/type/key/scroll/screenshot)", responses: { "200": { description: "{ok,screenshot?}" } } } },
    "/sessions/{id}/context": {
      get: { summary: "Export auth/state (cookies + local/session storage)", responses: { "200": { description: "{cookies,localStorage,sessionStorage,origin}" } } },
      post: { summary: "Import auth/state into the session", responses: { "200": { description: "{ok}" } } },
    },
    "/sessions/{id}/screenshot": { get: { summary: "PNG screenshot", responses: { "200": { description: "image/png" } } } },
    "/sessions/{id}/pdf": { get: { summary: "PDF render", responses: { "200": { description: "application/pdf" } } } },
    "/sessions/{id}/upload": { post: { summary: "Inject a host file into <input type=file>", responses: { "200": { description: "{ok}" } } } },
    "/sessions/{id}/downloads": { get: { summary: "List captured downloads", responses: { "200": { description: "string[]" } } } },
    "/sessions/{id}/downloads/{file}": {
      get: { summary: "Fetch a captured download", responses: { "200": { description: "application/octet-stream" } } },
      delete: { summary: "Delete a captured download", responses: { "200": { description: "{ok}" } } },
    },
    "/sessions/{id}/recordings": { get: { summary: "List recording segments", responses: { "200": { description: "string[]" } } } },
    "/sessions/{id}/recordings/{file}": { get: { summary: "Fetch a recording segment (mp4)", responses: { "200": { description: "video/mp4" } } } },
    "/sessions/{id}/files/{name}": {
      get: { summary: "Per-session scratch workspace file", responses: { "200": { description: "bytes" } } },
      put: { summary: "Write a per-session workspace file", responses: { "200": { description: "{ok}" } } },
      delete: { summary: "Delete a per-session workspace file", responses: { "200": { description: "{ok}" } } },
    },
    "/sessions/{id}/login": { post: { summary: "Auto-inject a stored credential", responses: { "200": { description: "{filled}" } } } },
    "/sessions/{id}/inject": {
      get: { summary: "List sticky script-injection ids (survives reload/new tab/daemon restart)", responses: { "200": { description: "{ids}" } } },
      post: { summary: "Register/replace ({id,source,bypassCSP?}) or remove ({id,remove:true}) a sticky script injection", responses: { "200": { description: "{ok,id|removed}" }, "400": { description: "missing id, or rejected by injectPolicy" } } },
    },
    "/sessions/{id}/replay": { get: { summary: "Recording replay player (HTML)", responses: { "200": { description: "text/html" } } } },
    "/sessions/{id}/view": { get: { summary: "Porthole (watch + control); ?interactable=0 read-only, ?controls=1 URL bar", responses: { "200": { description: "text/html" } } } },
    "/sessions/{id}/files": { get: { summary: "List per-session scratch workspace files", responses: { "200": { description: "string[]" } } } },
    "/profiles": { get: { summary: "List durable profiles", responses: { "200": { description: "[{name,active}]" } } } },
    "/profiles/{name}": { delete: { summary: "Delete a durable profile (refused while live)", responses: { "200": { description: "{ok,reason?}" } } } },
    "/files": { get: { summary: "List global workspace files", responses: { "200": { description: "string[]" } } } },
    "/extensions": { get: { summary: "List managed extensions", responses: { "200": { description: "string[]" } } } },
    "/extensions/{name}": {
      get: { summary: "List/serve a managed extension's files", responses: { "200": { description: "string[] | bytes" } } },
      delete: { summary: "Delete a managed extension", responses: { "200": { description: "{ok}" } } },
    },
    "/credentials": { get: { summary: "List stored credentials (blurred)", responses: { "200": { description: "BlurredCredential[]" } } } },
    "/credentials/{name}": {
      put: { summary: "Store a credential", responses: { "200": { description: "{ok}" } } },
      get: { summary: "Blurred credential view", responses: { "200": { description: "BlurredCredential" } } },
      delete: { summary: "Delete a credential", responses: { "200": { description: "{ok}" } } },
    },
    "/credentials/{name}/totp": { get: { summary: "Current RFC 6238 TOTP code", responses: { "200": { description: "{code}" } } } },
    "/files/{name}": {
      get: { summary: "Read a global workspace file", responses: { "200": { description: "bytes" } } },
      put: { summary: "Write a global workspace file", responses: { "200": { description: "{ok}" } } },
      delete: { summary: "Delete a global workspace file", responses: { "200": { description: "{ok}" } } },
    },
  },
} as const;

/** Minimal /docs page — Swagger UI from CDN, pointed at /openapi.json. */
export function docsHtml(): string {
  return `<!doctype html><html><head><meta charset=utf-8><title>lucarne API</title>
<link rel=stylesheet href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"></head>
<body><div id=ui></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>window.onload=()=>SwaggerUIBundle({url:'./openapi.json',dom_id:'#ui'})</script>
</body></html>`;
}

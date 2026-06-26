/** A hand-maintained OpenAPI 3.1 description of the lucarne control API. */
export const openApiSpec = {
  openapi: "3.1.0",
  info: { title: "lucarne", version: "0.9.1", description: "Self-hostable browser sessions you can drive, watch, and record." },
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
    "/sessions/{id}/tabs": { get: { summary: "List tabs", responses: { "200": { description: "{active,tabs}" } } } },
    "/sessions/{id}/tabs/{targetId}": { post: { summary: "Switch active tab", responses: { "200": { description: "{ok}" } } } },
    "/sessions/{id}/logs": { get: { summary: "Logs (network/console/browser); ?stream=1 for SSE", responses: { "200": { description: "LogEntry[]" } } } },
    "/sessions/{id}/content": { get: { summary: "Rendered HTML", responses: { "200": { description: "text/html" } } } },
    "/sessions/{id}/screenshot": { get: { summary: "PNG screenshot", responses: { "200": { description: "image/png" } } } },
    "/sessions/{id}/pdf": { get: { summary: "PDF render", responses: { "200": { description: "application/pdf" } } } },
    "/sessions/{id}/upload": { post: { summary: "Inject a host file into <input type=file>", responses: { "200": { description: "{ok}" } } } },
    "/sessions/{id}/downloads": { get: { summary: "List captured downloads", responses: { "200": { description: "string[]" } } } },
    "/sessions/{id}/login": { post: { summary: "Auto-inject a stored credential", responses: { "200": { description: "{filled}" } } } },
    "/sessions/{id}/replay": { get: { summary: "Recording replay player (HTML)", responses: { "200": { description: "text/html" } } } },
    "/profiles": { get: { summary: "List durable profiles", responses: { "200": { description: "[{name,active}]" } } } },
    "/credentials": { get: { summary: "List stored credentials (blurred)", responses: { "200": { description: "BlurredCredential[]" } } } },
    "/credentials/{name}": {
      put: { summary: "Store a credential", responses: { "200": { description: "{ok}" } } },
      get: { summary: "Blurred credential view", responses: { "200": { description: "BlurredCredential" } } },
      delete: { summary: "Delete a credential", responses: { "200": { description: "{ok}" } } },
    },
    "/credentials/{name}/totp": { get: { summary: "Current RFC 6238 TOTP code", responses: { "200": { description: "{code}" } } } },
    "/files/{name}": { get: { summary: "Global workspace file", responses: { "200": { description: "bytes" } } } },
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

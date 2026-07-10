/**
 * Opaque pagination cursors.
 *
 * Ported verbatim from `claude-socials/packages/shared/src/cursor.ts` (LS-03).
 *
 * Callers that need structured continuation state (an offset into a filtered
 * result set, a remaining BFS queue, `more`-stub children) encode it here into a
 * single opaque string. The consumer treats the cursor as a black box and passes
 * it back verbatim.
 *
 * Base64 of UTF-8 JSON, using only globals available in both a browser-hosted
 * extension context and Node (btoa/atob, TextEncoder/TextDecoder) — kept exactly
 * as claude-socials wrote it so this module stays dependency-free everywhere.
 */

export function encodeCursor(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function decodeCursor<T = unknown>(cursor: string): T {
  const bin = atob(cursor);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

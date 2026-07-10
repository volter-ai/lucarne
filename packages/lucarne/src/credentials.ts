import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { lucarneHome } from "./profiles.js";

/**
 * Credentials at rest: a per-name {username, password, totp} store, encrypted
 * with AES-256-GCM under a machine-local key, and a RFC 6238 TOTP generator.
 * The HTTP layer only ever returns BLURRED views (never secret values) — the
 * agent/viewer logs in or reads a code without seeing the secret.
 */
export interface Credential { username?: string; password?: string; totp?: string }
export interface BlurredCredential { name: string; username?: string; hasPassword: boolean; hasTotp: boolean }

// ── RFC 4648 base32 + RFC 4226 HOTP + RFC 6238 TOTP ──
function base32Decode(s: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = s.replace(/=+$/, "").toUpperCase().replace(/\s/g, "");
  let bits = 0, value = 0; const out: number[] = [];
  for (const c of clean) {
    const idx = alphabet.indexOf(c);
    if (idx === -1) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

function hotp(secret: Buffer, counter: number, digits: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", secret).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const code = ((hmac[offset]! & 0x7f) << 24) | ((hmac[offset + 1]! & 0xff) << 16)
    | ((hmac[offset + 2]! & 0xff) << 8) | (hmac[offset + 3]! & 0xff);
  return (code % 10 ** digits).toString().padStart(digits, "0");
}

/** TOTP code for a base32 secret at a given time (default now). Pure — testable. */
export function totpCode(secretBase32: string, atMs: number = Date.now(), step = 30, digits = 6): string {
  return hotp(base32Decode(secretBase32), Math.floor(atMs / 1000 / step), digits);
}

// ── encrypted-at-rest store ──
function keyPath(): string { return path.join(lucarneHome(), ".cred-key"); }
function storePath(): string { return path.join(lucarneHome(), "credentials.json"); }

function loadKey(): Buffer {
  try { return fs.readFileSync(keyPath()); } catch { /* generate below */ }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(keyPath()), { recursive: true });
  fs.writeFileSync(keyPath(), key, { mode: 0o600 });
  return key;
}

function encrypt(obj: unknown): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", loadKey(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return JSON.stringify({ iv: iv.toString("base64"), ct: ct.toString("base64"), tag: c.getAuthTag().toString("base64") });
}

function decrypt(s: string): Record<string, Credential> {
  const { iv, ct, tag } = JSON.parse(s) as { iv: string; ct: string; tag: string };
  const d = crypto.createDecipheriv("aes-256-gcm", loadKey(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8"));
}

function readAll(): Record<string, Credential> {
  try { return decrypt(fs.readFileSync(storePath(), "utf8")); } catch { return {}; }
}
function writeAll(all: Record<string, Credential>): void {
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  fs.writeFileSync(storePath(), encrypt(all), { mode: 0o600 });
}

export function putCredential(name: string, cred: Credential): void {
  const all = readAll(); all[name] = { ...all[name], ...cred }; writeAll(all);
}
/** INTERNAL — returns secrets (for login injection / TOTP). Never serve over HTTP. */
export function getCredential(name: string): Credential | undefined { return readAll()[name]; }
export function listCredentials(): BlurredCredential[] {
  return Object.entries(readAll()).map(([name, c]) => ({ name, username: c.username, hasPassword: !!c.password, hasTotp: !!c.totp }));
}
export function blurCredential(name: string): BlurredCredential | undefined {
  const c = readAll()[name];
  return c ? { name, username: c.username, hasPassword: !!c.password, hasTotp: !!c.totp } : undefined;
}
export function deleteCredential(name: string): boolean {
  const all = readAll(); const had = name in all; delete all[name]; writeAll(all); return had;
}

/**
 * Pluggable credential backend. lucarne ships the encrypted-file store as the
 * default, but a host can supply its own (a vault, 1Password, a KMS) — the engine
 * only ever calls this interface, so the secret store is not baked into the engine.
 * `get` returns secrets (for server-side login injection); never serve it over HTTP.
 */
export interface CredentialProvider {
  put(name: string, cred: Credential): void;
  get(name: string): Credential | undefined;
  list(): BlurredCredential[];
  blur(name: string): BlurredCredential | undefined;
  delete(name: string): boolean;
}

/** The default provider: the AES-256-GCM encrypted-at-rest file store above. */
export class FileCredentialStore implements CredentialProvider {
  put(name: string, cred: Credential): void { putCredential(name, cred); }
  get(name: string): Credential | undefined { return getCredential(name); }
  list(): BlurredCredential[] { return listCredentials(); }
  blur(name: string): BlurredCredential | undefined { return blurCredential(name); }
  delete(name: string): boolean { return deleteCredential(name); }
}

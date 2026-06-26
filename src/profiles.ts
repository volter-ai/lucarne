import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Profile & directory policy — the ONE place that decides where a session's
 * user-data-dir and recordings live, and whether the profile survives the
 * session. A *named* profile is durable (kept across sessions so you stay
 * logged in); an *anonymous* session is ephemeral (cleaned up on stop).
 *
 * Override the durable root with `LUCARNE_HOME` (tests use a temp dir for
 * deterministic isolation).
 */
export interface SessionDirs {
  /** Chrome `--user-data-dir`. */
  profileDir: string;
  /** Where this session's recordings land (always ephemeral). */
  recDir: string;
  /** Where this session's browser downloads land (retrievable via the API). */
  downloadDir: string;
  /** Preserve `profileDir` on stop (durable named profile). */
  persist: boolean;
}

export function profilesRoot(): string {
  const home = process.env.LUCARNE_HOME ?? path.join(os.homedir(), ".lucarne");
  return path.join(home, "profiles");
}

export function sessionDirs(id: string, persist: boolean): SessionDirs {
  const profileDir = persist
    ? path.join(profilesRoot(), id)
    : path.join(os.tmpdir(), "lucarne", "ephemeral-" + id);
  const recDir = path.join(os.tmpdir(), "lucarne", "rec-" + id);
  const downloadDir = path.join(os.tmpdir(), "lucarne", "dl-" + id);
  return { profileDir, recDir, downloadDir, persist };
}

/** A persisted profile exists once Chrome has written its `Default` subdir. */
export function profileExists(profileDir: string): boolean {
  return fs.existsSync(path.join(profileDir, "Default"));
}

/** The real local Chrome user-data-dir for this platform (parent of `Default`). */
export function realChromeUserDataDir(): string | null {
  const home = os.homedir();
  switch (process.platform) {
    case "darwin": return path.join(home, "Library", "Application Support", "Google", "Chrome");
    case "linux": return path.join(home, ".config", "google-chrome");
    case "win32": return path.join(home, "AppData", "Local", "Google", "Chrome", "User Data");
    default: return null;
  }
}

// The auth-bearing state copied when seeding a fresh profile from an existing
// Chrome user-data-dir. On the SAME machine+user the OS-keychain encryption key
// ("Chrome Safe Storage" on macOS) is shared across profiles, so copied cookies
// decrypt in the seeded profile. Best-effort: a live source Chrome may hold a
// SQLite write lock — close it (or accept a slightly stale copy) for a clean seed.
const SEED_ENTRIES = ["Cookies", "Network", "Local Storage", "IndexedDB", "Login Data", "Web Data", "Preferences"];

function cpIfExists(src: string, dest: string): void {
  try {
    if (fs.existsSync(src)) fs.cpSync(src, dest, { recursive: true });
  } catch { /* best-effort: a locked/partial file is skipped, not fatal */ }
}

/**
 * Seed a fresh profile's `Default` from a source Chrome user-data-dir's
 * `Default`, plus the user-data-dir-level `Local State`. Used to start a profile
 * already authenticated — `seedFromChrome` points this at your real Chrome.
 */
export function seedProfile(sourceUserDataDir: string, destProfileDir: string): void {
  const srcDefault = path.join(sourceUserDataDir, "Default");
  if (!fs.existsSync(srcDefault)) throw new Error(`lucarne: seed source has no Default profile: ${sourceUserDataDir}`);
  const destDefault = path.join(destProfileDir, "Default");
  fs.mkdirSync(destDefault, { recursive: true });
  for (const entry of SEED_ENTRIES) cpIfExists(path.join(srcDefault, entry), path.join(destDefault, entry));
  cpIfExists(path.join(sourceUserDataDir, "Local State"), path.join(destProfileDir, "Local State"));
}

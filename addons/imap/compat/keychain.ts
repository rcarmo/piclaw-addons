/**
 * compat/keychain.ts — runtime keychain shim for the IMAP addon.
 *
 * Reads secrets from piclaw's injected environment variables first, then from
 * the runtime interop bridge when running inside piclaw. It deliberately avoids
 * importing piclaw runtime internals or spawning the piclaw CLI from inside the
 * running process.
 */

export interface KeychainEntry {
  name: string;
  type: "token" | "password" | "basic" | "secret" | string;
  secret: string;
  username?: string;
}

export interface KeychainEntryMetadata {
  name: string;
  type?: string;
  createdAt?: string | null;
  updatedAt?: string | null;
}

type RuntimeKeychainInterop = {
  getKeychainEntry?: (name: string) => Promise<KeychainEntry>;
  setKeychainEntry?: (entry: KeychainEntry) => Promise<void>;
  deleteKeychainEntry?: (name: string) => boolean | Promise<boolean>;
  listKeychainEntries?: () => KeychainEntryMetadata[] | Promise<KeychainEntryMetadata[]>;
};

function sanitizeEnvName(name: string): string {
  return name.replace(/[/\-.]/g, "_").toUpperCase();
}

function getRuntimeInterop(): RuntimeKeychainInterop | null {
  return ((globalThis as any).__piclawRuntimeInterop || null) as RuntimeKeychainInterop | null;
}

function resolveFromEnv(name: string): KeychainEntry | null {
  const envValue = process.env[sanitizeEnvName(name)];
  if (!envValue) return null;
  return { name, type: "secret", secret: envValue };
}

export async function getKeychainEntry(name: string): Promise<KeychainEntry> {
  const fromEnv = resolveFromEnv(name);
  if (fromEnv) return fromEnv;

  const interop = getRuntimeInterop();
  if (typeof interop?.getKeychainEntry === "function") {
    const entry = await interop.getKeychainEntry(name);
    if (entry?.secret) {
      return {
        name,
        type: entry.type || "secret",
        secret: String(entry.secret),
        username: entry.username || undefined,
      };
    }
  }

  throw new Error(`Keychain entry not found: ${name}`);
}

export async function setKeychainEntry(entry: KeychainEntry): Promise<void> {
  const interop = getRuntimeInterop();
  if (typeof interop?.setKeychainEntry === "function") {
    await interop.setKeychainEntry(entry);
    return;
  }

  throw new Error("Runtime keychain write API is not available. Save secrets from the settings pane via /agent/keychain.");
}

export async function deleteKeychainEntry(name: string): Promise<boolean> {
  const interop = getRuntimeInterop();
  if (typeof interop?.deleteKeychainEntry === "function") {
    return Boolean(await interop.deleteKeychainEntry(name));
  }

  return false;
}

export async function listKeychainEntries(): Promise<KeychainEntryMetadata[]> {
  const interop = getRuntimeInterop();
  if (typeof interop?.listKeychainEntries === "function") {
    return await interop.listKeychainEntries();
  }

  return Object.entries(process.env)
    .filter(([, value]) => Boolean(value))
    .map(([name]) => ({ name, type: "secret" }));
}

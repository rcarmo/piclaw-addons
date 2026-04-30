/**
 * compat/keychain.ts — runtime keychain shim for the IMAP addon.
 *
 * Avoids spawning `piclaw keychain ...` from inside the running piclaw process.
 * A nested CLI launch trips the live-DB guard, so add-ons must use the runtime
 * keychain module/interop directly when available.
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

function getRuntimeModule(): RuntimeKeychainInterop | null {
  try {
    return require("piclaw/runtime/src/secure/keychain.js") as RuntimeKeychainInterop;
  } catch {
    return null;
  }
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
    return await interop.getKeychainEntry(name);
  }

  const mod = getRuntimeModule();
  if (typeof mod?.getKeychainEntry === "function") {
    return await mod.getKeychainEntry(name);
  }

  throw new Error(`Keychain entry not found: ${name}`);
}

export async function setKeychainEntry(entry: KeychainEntry): Promise<void> {
  const interop = getRuntimeInterop();
  if (typeof interop?.setKeychainEntry === "function") {
    await interop.setKeychainEntry(entry);
    return;
  }

  const mod = getRuntimeModule();
  if (typeof mod?.setKeychainEntry === "function") {
    await mod.setKeychainEntry(entry);
    return;
  }

  throw new Error("Runtime keychain write API is not available.");
}

export async function deleteKeychainEntry(name: string): Promise<boolean> {
  const interop = getRuntimeInterop();
  if (typeof interop?.deleteKeychainEntry === "function") {
    return Boolean(await interop.deleteKeychainEntry(name));
  }

  const mod = getRuntimeModule();
  if (typeof mod?.deleteKeychainEntry === "function") {
    return Boolean(await mod.deleteKeychainEntry(name));
  }

  return false;
}

export async function listKeychainEntries(): Promise<KeychainEntryMetadata[]> {
  const interop = getRuntimeInterop();
  if (typeof interop?.listKeychainEntries === "function") {
    return await interop.listKeychainEntries();
  }

  const mod = getRuntimeModule();
  if (typeof mod?.listKeychainEntries === "function") {
    return await mod.listKeychainEntries();
  }

  return Object.entries(process.env)
    .filter(([, value]) => Boolean(value))
    .map(([name]) => ({ name, type: "secret" }));
}

import { createExtensionStorage, type ExtensionStorage } from "./compat/extension-kv.ts";
import {
  deleteKeychainEntry,
  getKeychainEntry,
  listKeychainEntries,
  setKeychainEntry,
} from "./compat/keychain.ts";

export interface ImapAccountConfig {
  host: string;
  port: number;
  user: string;
  from?: string;
  tls: boolean;
  starttls?: boolean;
  allowInsecureTls?: boolean;
}

export interface ImapStoredAccount extends ImapAccountConfig {
  name: string;
  hasPassword: boolean;
  source: "kv" | "legacy-keychain";
}

const ACCOUNT_PREFIX = "accounts/";
const DEFAULT_ACCOUNT_KEY = "default_account";
const PASSWORD_KEY_PREFIX = "imap/";
let storage: ExtensionStorage | null = null;

function getStorage(): ExtensionStorage {
  if (!storage) storage = createExtensionStorage("imap");
  return storage;
}

function accountKvKey(name: string): string {
  return `${ACCOUNT_PREFIX}${name}`;
}

function passwordKeychainName(name: string): string {
  return `${PASSWORD_KEY_PREFIX}${name}/password`;
}

function legacyKeychainName(name: string): string {
  return `${PASSWORD_KEY_PREFIX}${name}`;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function sanitizeConfig(config: Record<string, unknown>): ImapAccountConfig {
  const host = typeof config.host === "string" ? config.host.trim() : "";
  const user = typeof config.user === "string" ? config.user.trim() : "";
  if (!host || !user) throw new Error("host and user are required");
  const port = Number.isFinite(config.port) ? Number(config.port) : Number.parseInt(String(config.port ?? "993"), 10);
  const tls = typeof config.tls === "boolean" ? config.tls : config.tls !== "false";
  const starttls = typeof config.starttls === "boolean" ? config.starttls : config.starttls === "true";
  const allowInsecureTls = typeof config.allowInsecureTls === "boolean" ? config.allowInsecureTls : config.allowInsecureTls === "true";
  const from = typeof config.from === "string" && config.from.trim() ? config.from.trim() : user;
  return {
    host,
    port: Number.isFinite(port) && port > 0 ? port : (tls ? 993 : 143),
    user,
    from,
    tls,
    starttls,
    allowInsecureTls,
  };
}

async function keychainSet(name: string, secret: string): Promise<void> {
  await setKeychainEntry({ name, type: "password", secret });
}

async function keychainDelete(name: string): Promise<void> {
  await deleteKeychainEntry(name);
}

async function keychainGetSecret(name: string): Promise<string | null> {
  try {
    const entry = await getKeychainEntry(name);
    return typeof entry.secret === "string" ? entry.secret : null;
  } catch {
    return null;
  }
}

async function keychainGetJson(name: string): Promise<Record<string, unknown> | null> {
  const secret = await keychainGetSecret(name);
  if (!secret) return null;
  try {
    const parsed = JSON.parse(secret) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function keychainList(): Promise<Array<{ name: string; type?: string }>> {
  return await listKeychainEntries();
}

export async function listAccounts(): Promise<{ accounts: ImapStoredAccount[]; defaultAccount: string | null }> {
  const kv = getStorage();
  const accounts = new Map<string, ImapStoredAccount>();

  for (const key of kv.list(ACCOUNT_PREFIX, "global")) {
    const name = key.slice(ACCOUNT_PREFIX.length);
    const stored = kv.get<ImapAccountConfig>(key, "global");
    if (!stored) continue;
    const config = sanitizeConfig(stored as Record<string, unknown>);
    const password = await keychainGetSecret(passwordKeychainName(name));
    accounts.set(name, { name, ...config, hasPassword: typeof password === "string" && password.length > 0, source: "kv" });
  }

  const entries = await keychainList();
  for (const entry of entries) {
    const name = String(entry.name || "");
    const legacy = name.match(/^imap\/([^/]+)$/);
    if (!legacy?.[1]) continue;
    const accountName = legacy[1];
    if (accounts.has(accountName)) continue;
    const raw = await keychainGetJson(name);
    if (!raw) continue;
    try {
      const config = sanitizeConfig(raw);
      accounts.set(accountName, { name: accountName, ...config, hasPassword: true, source: "legacy-keychain" });
    } catch {}
  }

  const defaultAccount = kv.get<string>(DEFAULT_ACCOUNT_KEY, "global") ?? process.env.IMAP_DEFAULT_ACCOUNT ?? null;
  return { accounts: [...accounts.values()].sort((a, b) => a.name.localeCompare(b.name)), defaultAccount };
}

export async function getAccount(name: string): Promise<(ImapStoredAccount & { password?: string }) | null> {
  const normalized = normalizeName(name);
  if (!normalized) throw new Error("account name required");
  const kv = getStorage();
  const stored = kv.get<ImapAccountConfig>(accountKvKey(normalized), "global");
  if (stored) {
    const config = sanitizeConfig(stored as Record<string, unknown>);
    const password = await keychainGetSecret(passwordKeychainName(normalized));
    return { name: normalized, ...config, hasPassword: typeof password === "string" && password.length > 0, password: typeof password === "string" ? password : undefined, source: "kv" };
  }
  const legacy = await keychainGetJson(legacyKeychainName(normalized));
  if (legacy) {
    const config = sanitizeConfig(legacy);
    return { name: normalized, ...config, hasPassword: typeof (legacy as any).pass === "string", password: typeof (legacy as any).pass === "string" ? (legacy as any).pass : undefined, source: "legacy-keychain" };
  }
  return null;
}

export async function saveAccount(
  name: string,
  input: Record<string, unknown>,
  password?: string,
  setDefault = false,
): Promise<ImapStoredAccount> {
  const normalized = normalizeName(name);
  if (!normalized) throw new Error("account name required");
  const config = sanitizeConfig(input);
  if (typeof password === "string" && password.length > 0) {
    await keychainSet(passwordKeychainName(normalized), password);
  }
  getStorage().set(accountKvKey(normalized), config, "global");
  if (setDefault) {
    getStorage().set(DEFAULT_ACCOUNT_KEY, normalized, "global");
  }
  const savedPassword = await keychainGetSecret(passwordKeychainName(normalized));
  return { name: normalized, ...config, hasPassword: typeof savedPassword === "string" && savedPassword.length > 0, source: "kv" };
}

export async function deleteAccount(name: string): Promise<boolean> {
  const normalized = normalizeName(name);
  if (!normalized) throw new Error("account name required");
  const kv = getStorage();
  const deleted = kv.delete(accountKvKey(normalized), "global");
  await keychainDelete(passwordKeychainName(normalized));
  const currentDefault = kv.get<string>(DEFAULT_ACCOUNT_KEY, "global");
  if (currentDefault === normalized) kv.delete(DEFAULT_ACCOUNT_KEY, "global");
  return deleted;
}

export function setDefaultAccount(name: string | null): void {
  const kv = getStorage();
  if (!name) kv.delete(DEFAULT_ACCOUNT_KEY, "global");
  else kv.set(DEFAULT_ACCOUNT_KEY, normalizeName(name), "global");
}

export function getDefaultAccount(): string | null {
  return getStorage().get<string>(DEFAULT_ACCOUNT_KEY, "global") ?? process.env.IMAP_DEFAULT_ACCOUNT ?? null;
}

export async function resolveAccountForRuntime(name?: string): Promise<{ name: string; config: ImapAccountConfig & { pass: string } }> {
  const lookupOrder: string[] = [];
  if (name) lookupOrder.push(name);
  else {
    const defaultAccount = getDefaultAccount();
    if (defaultAccount) lookupOrder.push(defaultAccount);
    const listed = await listAccounts();
    for (const account of listed.accounts) {
      if (!lookupOrder.includes(account.name)) lookupOrder.push(account.name);
    }
    const envAccount = Object.keys(process.env).find((key) => key.startsWith("IMAP_") && key !== "IMAP_DEFAULT_ACCOUNT");
    if (envAccount) lookupOrder.push(envAccount.replace("IMAP_", "").toLowerCase());
  }

  for (const candidate of lookupOrder) {
    const account = await getAccount(candidate);
    if (account?.password) {
      const { password, ...rest } = account;
      return { name: account.name, config: { ...rest, pass: password } };
    }
  }

  throw new Error("No IMAP accounts found. Add one in the IMAP settings pane or store a legacy keychain entry.");
}

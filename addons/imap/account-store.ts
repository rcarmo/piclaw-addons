import { createExtensionStorage, type ExtensionStorage } from "./compat/extension-kv.ts";
import {
  deleteKeychainEntry,
  getKeychainEntry,
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
}

const unchecked = () => {};
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

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function sanitizeConfig(config: Record<string, unknown> | ImapAccountConfig): ImapAccountConfig {
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

async function keychainGetSecret(name: string, check: () => void = unchecked): Promise<string | null> {
  try {
    check();
    const entry = await getKeychainEntry(name);
    check();
    return typeof entry.secret === "string" ? entry.secret : null;
  } catch {
    check();
    return null;
  }
}

export async function listAccounts(check: () => void = unchecked): Promise<{ accounts: ImapStoredAccount[]; defaultAccount: string | null }> {
  check();
  const kv = getStorage();
  const accounts = new Map<string, ImapStoredAccount>();

  for (const key of kv.list(ACCOUNT_PREFIX, "global")) {
    const name = key.slice(ACCOUNT_PREFIX.length);
    const stored = kv.get<ImapAccountConfig>(key, "global");
    if (!stored) continue;
    const config = sanitizeConfig(stored);
    const password = await keychainGetSecret(passwordKeychainName(name), check);
    accounts.set(name, { name, ...config, hasPassword: typeof password === "string" && password.length > 0 });
  }

  const defaultAccount = kv.get<string>(DEFAULT_ACCOUNT_KEY, "global") ?? process.env.IMAP_DEFAULT_ACCOUNT ?? null;
  return { accounts: [...accounts.values()].sort((a, b) => a.name.localeCompare(b.name)), defaultAccount };
}

export async function getAccount(name: string, check: () => void = unchecked): Promise<(ImapStoredAccount & { password?: string }) | null> {
  const normalized = normalizeName(name);
  if (!normalized) throw new Error("account name required");
  check();
  const kv = getStorage();
  const stored = kv.get<ImapAccountConfig>(accountKvKey(normalized), "global");
  if (stored) {
    const config = sanitizeConfig(stored);
    const password = await keychainGetSecret(passwordKeychainName(normalized), check);
    return { name: normalized, ...config, hasPassword: typeof password === "string" && password.length > 0, password: typeof password === "string" ? password : undefined };
  }
  return null;
}

export async function saveAccount(
  name: string,
  input: Record<string, unknown>,
  password?: string,
  setDefault = false,
  check: () => void = unchecked,
): Promise<ImapStoredAccount> {
  const normalized = normalizeName(name);
  if (!normalized) throw new Error("account name required");
  const config = sanitizeConfig(input);
  if (typeof password === "string" && password.length > 0) {
    check();
    await keychainSet(passwordKeychainName(normalized), password);
  }
  check();
  await getStorage().write(() => {
    check(); getStorage().set(accountKvKey(normalized), config, "global");
    if (setDefault) getStorage().set(DEFAULT_ACCOUNT_KEY, normalized, "global");
    check();
  });
  const savedPassword = await keychainGetSecret(passwordKeychainName(normalized), check);
  return { name: normalized, ...config, hasPassword: typeof savedPassword === "string" && savedPassword.length > 0 };
}

export async function deleteAccount(name: string, check: () => void = unchecked): Promise<boolean> {
  const normalized = normalizeName(name);
  if (!normalized) throw new Error("account name required");
  check();
  const kv = getStorage();
  const deleted = await kv.write(() => { check(); const result = kv.delete(accountKvKey(normalized), "global"); check(); return result; });
  check();
  await keychainDelete(passwordKeychainName(normalized));
  check();
  await kv.write(() => {
    check(); const currentDefault = kv.get<string>(DEFAULT_ACCOUNT_KEY, "global");
    if (currentDefault === normalized) kv.delete(DEFAULT_ACCOUNT_KEY, "global");
    check();
  });
  return deleted;
}

export async function setDefaultAccount(name: string | null, check: () => void = unchecked): Promise<void> {
  check();
  const kv = getStorage(), normalized = name ? normalizeName(name) : null;
  await kv.write(() => {
    check();
    if (normalized && !kv.get(accountKvKey(normalized), "global")) throw new Error(`Account not found: ${normalized}`);
    if (!normalized) kv.delete(DEFAULT_ACCOUNT_KEY, "global");
    else kv.set(DEFAULT_ACCOUNT_KEY, normalized, "global");
    check();
  });
}

export function getDefaultAccount(): string | null {
  return getStorage().get<string>(DEFAULT_ACCOUNT_KEY, "global") ?? process.env.IMAP_DEFAULT_ACCOUNT ?? null;
}

export async function resolveAccountForRuntime(name?: string, check: () => void = unchecked): Promise<{ name: string; config: ImapAccountConfig & { pass: string } }> {
  check();
  const lookupOrder: string[] = [];
  if (name) lookupOrder.push(name);
  else {
    const defaultAccount = getDefaultAccount();
    if (defaultAccount) lookupOrder.push(defaultAccount);
    const listed = await listAccounts(check);
    check();
    for (const account of listed.accounts) {
      if (!lookupOrder.includes(account.name)) lookupOrder.push(account.name);
    }
    const envAccount = Object.keys(process.env).find((key) => key.startsWith("IMAP_") && key !== "IMAP_DEFAULT_ACCOUNT");
    if (envAccount) lookupOrder.push(envAccount.replace("IMAP_", "").toLowerCase());
  }

  for (const candidate of lookupOrder) {
    const account = await getAccount(candidate, check);
    check();
    if (account?.password) {
      const { password, ...rest } = account;
      return { name: account.name, config: { ...rest, pass: password } };
    }
  }

  throw new Error("No IMAP accounts found. Add one in the IMAP settings pane.");
}

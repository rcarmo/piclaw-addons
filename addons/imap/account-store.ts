import { createExtensionStorage, type ExtensionStorage } from "./compat/extension-kv.ts";

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

function parseJsonFromMixedOutput(text: string): any {
  const lines = text.trim().split("\n");
  for (let i = 0; i < lines.length; i++) {
    const candidate = lines.slice(i).join("\n").trim();
    if (!candidate.startsWith("[") && !candidate.startsWith("{")) continue;
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  throw new Error("Could not parse CLI JSON output");
}

async function runPiclaw(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["piclaw", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function keychainSet(name: string, secret: string): Promise<void> {
  const result = await runPiclaw(["keychain", "set", name, "--secret", secret, "--type", "password"]);
  if (result.exitCode !== 0) throw new Error(result.stderr || `Failed to set keychain entry ${name}`);
}

async function keychainDelete(name: string): Promise<void> {
  const result = await runPiclaw(["keychain", "delete", name]);
  if (result.exitCode !== 0 && !/not found/i.test(result.stderr || result.stdout)) {
    throw new Error(result.stderr || `Failed to delete keychain entry ${name}`);
  }
}

async function keychainGetRaw(name: string): Promise<any | null> {
  const result = await runPiclaw(["keychain", "get", name]);
  if (result.exitCode !== 0) return null;
  try {
    const parsed = parseJsonFromMixedOutput(result.stdout);
    if (parsed?.secret && typeof parsed.secret === "string") {
      try { return JSON.parse(parsed.secret); } catch { return parsed.secret; }
    }
    return parsed?.secret ?? parsed;
  } catch {
    return null;
  }
}

async function keychainList(): Promise<Array<{ name: string; type?: string }>> {
  const result = await runPiclaw(["keychain", "list"]);
  if (result.exitCode !== 0) return [];
  try {
    const parsed = parseJsonFromMixedOutput(result.stdout);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function listAccounts(): Promise<{ accounts: ImapStoredAccount[]; defaultAccount: string | null }> {
  const kv = getStorage();
  const accounts = new Map<string, ImapStoredAccount>();

  for (const key of kv.list(ACCOUNT_PREFIX, "global")) {
    const name = key.slice(ACCOUNT_PREFIX.length);
    const stored = kv.get<ImapAccountConfig>(key, "global");
    if (!stored) continue;
    const config = sanitizeConfig(stored as Record<string, unknown>);
    accounts.set(name, { name, ...config, hasPassword: Boolean(await keychainGetRaw(passwordKeychainName(name))), source: "kv" });
  }

  const entries = await keychainList();
  for (const entry of entries) {
    const name = String(entry.name || "");
    const legacy = name.match(/^imap\/([^/]+)$/);
    if (!legacy?.[1]) continue;
    const accountName = legacy[1];
    if (accounts.has(accountName)) continue;
    const raw = await keychainGetRaw(name);
    if (!raw || typeof raw !== "object") continue;
    try {
      const config = sanitizeConfig(raw as Record<string, unknown>);
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
    const password = await keychainGetRaw(passwordKeychainName(normalized));
    return { name: normalized, ...config, hasPassword: typeof password === "string" && password.length > 0, password: typeof password === "string" ? password : undefined, source: "kv" };
  }
  const legacy = await keychainGetRaw(legacyKeychainName(normalized));
  if (legacy && typeof legacy === "object") {
    const config = sanitizeConfig(legacy as Record<string, unknown>);
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
  getStorage().set(accountKvKey(normalized), config, "global");
  if (typeof password === "string" && password.length > 0) {
    await keychainSet(passwordKeychainName(normalized), password);
  }
  if (setDefault) {
    getStorage().set(DEFAULT_ACCOUNT_KEY, normalized, "global");
  }
  const savedPassword = await keychainGetRaw(passwordKeychainName(normalized));
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

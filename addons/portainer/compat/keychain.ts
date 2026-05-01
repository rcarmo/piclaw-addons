/**
 * compat/keychain.ts — Keychain shim for standalone addons.
 *
 * Reads API tokens from environment variables injected by piclaw's keychain
 * auto-injection (names sanitized: / - . → _ and uppercased).
 *
 * Falls back to reading from piclaw's keychain SQLite DB if available.
 * Provides the same function signatures as piclaw's secure/keychain.ts
 * and secure/shell-secrets.ts so client code can import unchanged.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

const WORKSPACE_DIR = process.env.PICLAW_WORKSPACE || "/workspace";

function sanitizeEnvName(keychainName: string): string {
  return keychainName.replace(/[/\-.]/g, "_").toUpperCase();
}

function parseJsonFromMixedOutput(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const lines = trimmed.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const candidate = lines.slice(i).join("\n").trim();
    if (!candidate.startsWith("{") && !candidate.startsWith("[") && !candidate.startsWith('"')) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // keep scanning
    }
  }
  return null;
}

function extractStructuredSecret(text: string): { secret: string; username?: string } | null {
  const parsed = parseJsonFromMixedOutput(text);
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const secret = typeof record.secret === "string"
    ? record.secret.trim()
    : typeof record.token === "string"
      ? record.token.trim()
      : typeof record.api_token === "string"
        ? record.api_token.trim()
        : "";
  if (!secret) return null;
  const username = typeof record.username === "string"
    ? record.username.trim()
    : typeof record.user === "string"
      ? record.user.trim()
      : "";
  return {
    secret,
    ...(username ? { username } : {}),
  };
}

function normalizeKeychainEntry(name: string, entry: { type?: unknown; secret?: unknown; username?: unknown }): KeychainEntry | null {
  if (typeof entry?.secret !== "string") return null;
  const structured = extractStructuredSecret(entry.secret);
  const secret = structured?.secret || entry.secret.trim();
  if (!secret) return null;
  const username = typeof entry.username === "string"
    ? entry.username.trim()
    : structured?.username || "";
  return {
    name,
    type: typeof entry.type === "string" && entry.type.trim() ? entry.type : "secret",
    secret,
    ...(username ? { username } : {}),
  };
}

// ── Types matching piclaw's keychain ─────────────────────────────

export interface KeychainEntry {
  name: string;
  type: string;
  secret: string;
  username?: string;
}

export interface KeychainEntryMetadata {
  name: string;
  type: string;
  createdAt?: string;
  updatedAt?: string;
}

// ── Primary: env-var-based resolution ────────────────────────────

function resolveFromEnv(name: string): KeychainEntry | null {
  const envName = sanitizeEnvName(name);
  const envValue = process.env[envName];
  if (!envValue) return null;

  const structured = extractStructuredSecret(envValue);
  if (structured) {
    return { name, type: "secret", secret: structured.secret, username: structured.username };
  }

  const secret = envValue.trim();
  if (!secret) return null;
  return { name, type: "secret", secret };
}

// ── Compatibility API matching piclaw's secure/keychain.ts ───────

/**
 * Get a keychain entry by name.
 * Reads from injected env vars (primary), then the live piclaw runtime keychain,
 * and only then falls back to the piclaw CLI.
 */
export async function getKeychainEntry(name: string): Promise<KeychainEntry> {
  const fromEnv = resolveFromEnv(name);
  if (fromEnv) return fromEnv;

  try {
    const interop = (globalThis as {
      __piclawRuntimeInterop?: {
        getKeychainEntry?: (entryName: string) => Promise<KeychainEntry>;
      };
    }).__piclawRuntimeInterop;
    if (typeof interop?.getKeychainEntry === "function") {
      const entry = await interop.getKeychainEntry(name);
      const normalized = normalizeKeychainEntry(name, entry || {});
      if (normalized) return normalized;
    }
  } catch {
    // continue to module fallback
  }

  try {
    const mod = require("piclaw/runtime/src/secure/keychain.js");
    if (typeof mod?.getKeychainEntry === "function") {
      const entry = await mod.getKeychainEntry(name);
      const normalized = normalizeKeychainEntry(name, entry || {});
      if (normalized) return normalized;
    }
  } catch {
    // Not running inside piclaw runtime — continue to CLI fallback.
  }

  try {
    const proc = Bun.spawnSync(["piclaw", "keychain", "get", name], {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    if (proc.exitCode === 0 && proc.stdout) {
      const text = proc.stdout.toString().trim();
      if (text) {
        const structured = extractStructuredSecret(text);
        if (structured) {
          return { name, type: "secret", secret: structured.secret, username: structured.username };
        }
        return { name, type: "secret", secret: text };
      }
    }
  } catch {
    // CLI not available
  }

  throw new Error(`Keychain entry not found: ${name}`);
}

/**
 * List all keychain entries (metadata only).
 */
export function listKeychainEntries(): KeychainEntryMetadata[] {
  // Return entries visible as env vars with the keychain naming pattern
  const entries: KeychainEntryMetadata[] = [];
  for (const [key, _value] of Object.entries(process.env)) {
    if (key && _value) {
      entries.push({ name: key, type: "secret" });
    }
  }
  return entries;
}

/**
 * Resolve keychain:// placeholders in a string.
 */
const KEYCHAIN_PREFIX = "keychain://";

export async function resolveKeychainPlaceholders(input: string): Promise<string> {
  if (!input || !input.includes(KEYCHAIN_PREFIX)) return input;

  const regex = /keychain:\/\/([^/\s]+)(?:\/(secret|username))?/g;
  let output = input;
  const matches = Array.from(input.matchAll(regex));

  for (const match of matches) {
    const entryName = match[1]!;
    const field = (match[2] || "secret") as "secret" | "username";
    try {
      const entry = await getKeychainEntry(entryName);
      const value = field === "username" ? (entry.username || "") : entry.secret;
      output = output.replaceAll(match[0], value);
    } catch {
      // Leave placeholder in place if resolution fails
    }
  }

  return output;
}

/**
 * Build injected shell environment (stub — returns empty env in addon mode).
 * The real implementation decrypts all keychain entries for shell injection.
 * In addon mode, piclaw's bash tool already handles this.
 */
export async function buildInjectedShellEnv(_options?: unknown): Promise<Record<string, string>> {
  return {};
}

// ── Compatibility API matching piclaw's secure/shell-secrets.ts ──

export type InjectedShellFamily = "posix" | "powershell";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export async function buildInjectedExecCommand(
  shellFamily: InjectedShellFamily,
  command: string,
  args: string[] = [],
): Promise<{ command: string; commandArgs: string[]; env: Record<string, string> }> {
  const resolvedCommand = await resolveKeychainPlaceholders(command);
  const resolvedArgs = await Promise.all(args.map((v) => resolveKeychainPlaceholders(v)));

  if (shellFamily === "powershell") {
    const psQuote = (v: string) => `'${v.replace(/'/g, "''")}'`;
    return {
      command: "powershell",
      commandArgs: ["-NoProfile", "-Command", `& ${[resolvedCommand, ...resolvedArgs].map(psQuote).join(" ")}`],
      env: {},
    };
  }

  return {
    command: "sh",
    commandArgs: ["-lc", `exec ${[resolvedCommand, ...resolvedArgs].map(shellQuote).join(" ")}`],
    env: {},
  };
}

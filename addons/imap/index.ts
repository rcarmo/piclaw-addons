/**
 * IMAP extension for piclaw.
 *
 * Tool actions:
 * - list_folders, search, fetch, move, copy, flag
 * - create_draft, file_message, create_folder, delete_folder
 * - list_accounts, get_account, save_account, delete_account, set_default_account
 *
 * Account storage model:
 * - non-secret settings in extension SQLite KV (global scope)
 * - password in keychain at imap/<name>/password
 * - legacy single-secret keychain entries imap/<name> still read as fallback
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { ImapClient, buildSearchCriteria, type ImapConfig } from "./imap-client.ts";
import { createMimeMessage } from "./mime.ts";
import {
  deleteAccount,
  getAccount,
  getDefaultAccount,
  listAccounts,
  resolveAccountForRuntime,
  saveAccount,
  setDefaultAccount,
} from "./account-store.ts";

const ADDON_ID = "imap";

interface ImapAccount extends ImapConfig {
  from: string;
  name: string;
  allowSend: boolean;
}

interface PoolEntry {
  client: ImapClient;
  account: ImapAccount;
  lastUsed: number;
}

const pool = new Map<string, PoolEntry>();
const IDLE_MS = 5 * 60 * 1000;
let cleanupTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setTimeout(async () => {
    cleanupTimer = null;
    const now = Date.now();
    for (const [key, entry] of pool) {
      if (now - entry.lastUsed <= IDLE_MS) continue;
      try { await entry.client.logout(); } catch {}
      pool.delete(key);
    }
    if (pool.size > 0) scheduleCleanup();
  }, 60_000);
}

async function getClient(account: ImapAccount): Promise<ImapClient> {
  const key = `${account.user}@${account.host}:${account.port}:${account.tls ? "tls" : account.starttls ? "starttls" : "plain"}`;
  const existing = pool.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    try {
      await existing.client.noop();
      return existing.client;
    } catch {
      pool.delete(key);
      try { await existing.client.logout(); } catch {}
    }
  }
  const client = new ImapClient(account);
  await client.connect();
  await client.login();
  pool.set(key, { client, account, lastUsed: Date.now() });
  scheduleCleanup();
  return client;
}

function parseBoolean(value: unknown): boolean {
  return value === true || (typeof value === "string" && value.toLowerCase() === "true");
}

function parseUidList(value: string): string {
  const uids = value.split(",").map((part) => Number.parseInt(part.trim(), 10)).filter((uid) => Number.isFinite(uid) && uid > 0);
  if (uids.length === 0) throw new Error("uids must contain at least one positive integer");
  return [...new Set(uids)].join(",");
}

function truncate(text: string, max = 8000): string {
  return text.length > max ? `${text.slice(0, max)}\n…(truncated)` : text;
}

async function resolveAccount(pi: ExtensionAPI, accountName?: string): Promise<ImapAccount> {
  const resolved = await resolveAccountForRuntime(pi, accountName);
  return {
    ...resolved.config,
    from: resolved.config.from ?? resolved.config.user,
    name: resolved.name,
    allowSend: false,
  };
}

function commandJson(pi: ExtensionAPI, payload: unknown): void {
  pi.sendMessage({
    customType: ADDON_ID,
    content: JSON.stringify(payload),
    display: false,
  });
}

async function handleAccountsSet(pi: ExtensionAPI, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const action = String(input.action ?? input.op ?? "").toLowerCase().trim();
  const name = typeof input.name === "string" ? input.name.trim() : "";

  if (action === "save") {
    if (!name) throw new Error("account name required");
    const account = (input.account && typeof input.account === "object" ? input.account : input) as Record<string, unknown>;
    const saved = await saveAccount(
      pi,
      name,
      account,
      typeof account.password === "string" ? account.password : typeof input.password === "string" ? input.password : undefined,
      parseBoolean(account.setDefault ?? input.setDefault),
    );
    return { ok: true, account: saved, defaultAccount: getDefaultAccount() };
  }

  if (action === "delete") {
    if (!name) throw new Error("account name required");
    const deleted = await deleteAccount(pi, name);
    return { ok: true, deleted, defaultAccount: getDefaultAccount() };
  }

  if (action === "set_default" || action === "set-default") {
    const nextDefault = name || null;
    setDefaultAccount(nextDefault);
    return { ok: true, defaultAccount: getDefaultAccount() };
  }

  throw new Error("Unsupported IMAP accounts action");
}

function registerSettingsCommands(pi: ExtensionAPI): void {
  pi.registerCommand("imap-accounts-get", {
    description: "Get IMAP accounts for the settings pane (internal)",
    handler: async () => {
      try {
        const payload = await listAccounts(pi);
        commandJson(pi, { ok: true, ...payload });
      } catch (error) {
        commandJson(pi, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  });

  pi.registerCommand("imap-accounts-set", {
    description: "Update IMAP account settings (internal)",
    handler: async (args: string) => {
      try {
        const input = JSON.parse(args || "{}") as Record<string, unknown>;
        commandJson(pi, await handleAccountsSet(pi, input));
      } catch (error) {
        commandJson(pi, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  });
}

export default function imapExtension(pi: ExtensionAPI) {
  registerSettingsCommands(pi);

  pi.on("session_shutdown", async () => {
    if (cleanupTimer) {
      clearTimeout(cleanupTimer);
      cleanupTimer = null;
    }
    for (const [, entry] of pool) {
      try { await entry.client.logout(); } catch {}
    }
    pool.clear();
  });

  pi.registerTool({
    name: "imap",
    label: "IMAP Email",
    description: "Manage email via IMAP and administer IMAP accounts stored in SQLite KV + keychain.",
    promptSnippet: "Email: list folders, search, fetch, move, copy, flag, draft, file via IMAP, plus account management.",
    promptGuidelines: [
      "Use action=list_accounts/get_account/save_account/delete_account/set_default_account to manage account settings.",
      "Use action=list_folders/search/fetch/move/copy/flag/create_draft/file_message/create_folder/delete_folder for mailbox operations.",
      "Passwords are stored in keychain; per-account non-secret settings are stored in SQLite KV.",
      "This tool cannot send email via SMTP.",
    ],
    parameters: Type.Object({
      action: Type.String({ description: "list_accounts|get_account|save_account|delete_account|set_default_account|list_folders|search|fetch|move|copy|flag|create_draft|file_message|create_folder|delete_folder" }),
      account: Type.Optional(Type.String({ description: "Account name" })),
      folder: Type.Optional(Type.String({ description: "Mailbox folder (default: INBOX)" })),
      from: Type.Optional(Type.String()),
      to: Type.Optional(Type.String()),
      subject: Type.Optional(Type.String()),
      text: Type.Optional(Type.String()),
      since: Type.Optional(Type.String({ description: "YYYY-MM-DD" })),
      before: Type.Optional(Type.String({ description: "YYYY-MM-DD" })),
      seen: Type.Optional(Type.String({ description: "true|false" })),
      flagged: Type.Optional(Type.String({ description: "true|false" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 20)" })),
      uids: Type.Optional(Type.String({ description: "Comma-separated UIDs" })),
      withBody: Type.Optional(Type.String({ description: "true to fetch full source" })),
      targetFolder: Type.Optional(Type.String()),
      flagAction: Type.Optional(Type.String({ description: "add|remove" })),
      flags: Type.Optional(Type.String({ description: "\\Seen,\\Flagged,..." })),
      draftTo: Type.Optional(Type.String()),
      draftCc: Type.Optional(Type.String()),
      draftSubject: Type.Optional(Type.String()),
      draftBody: Type.Optional(Type.String()),
      draftIsHtml: Type.Optional(Type.String()),
      draftInReplyTo: Type.Optional(Type.String()),
      draftDate: Type.Optional(Type.String()),
      confirm: Type.Optional(Type.String()),
      dryRun: Type.Optional(Type.String()),
      host: Type.Optional(Type.String()),
      port: Type.Optional(Type.Number()),
      user: Type.Optional(Type.String()),
      pass: Type.Optional(Type.String()),
      starttls: Type.Optional(Type.String()),
      tls: Type.Optional(Type.String()),
      allowInsecureTls: Type.Optional(Type.String()),
      setDefault: Type.Optional(Type.String()),
    }),

    async execute(_id: string, params: any) {
      const action = String(params.action ?? "").toLowerCase().trim();
      const text = "text" as const;
      try {
        if (action === "list_accounts") {
          const payload = await listAccounts(pi);
          return {
            content: [{ type: text, text: truncate(JSON.stringify(payload, null, 2)) }],
            details: payload,
          };
        }

        if (action === "get_account") {
          if (!params.account) throw new Error("account required");
          const payload = await getAccount(pi, params.account);
          if (!payload) throw new Error(`Account not found: ${params.account}`);
          return {
            content: [{ type: text, text: truncate(JSON.stringify({ ...payload, password: undefined }, null, 2)) }],
            details: { ...payload, password: undefined },
          };
        }

        if (action === "save_account") {
          if (!params.account) throw new Error("account required");
          const saved = await saveAccount(pi, params.account, {
            host: params.host,
            port: params.port,
            user: params.user,
            from: params.from,
            tls: parseBoolean(params.tls),
            starttls: parseBoolean(params.starttls),
            allowInsecureTls: parseBoolean(params.allowInsecureTls),
          }, typeof params.pass === "string" ? params.pass : undefined, parseBoolean(params.setDefault));
          return {
            content: [{ type: text, text: `Saved IMAP account ${saved.name}.` }],
            details: { account: saved, defaultAccount: getDefaultAccount() },
          };
        }

        if (action === "delete_account") {
          if (!params.account) throw new Error("account required");
          const deleted = await deleteAccount(pi, params.account);
          return {
            content: [{ type: text, text: deleted ? `Deleted IMAP account ${params.account}.` : `No IMAP KV config existed for ${params.account}; password key was removed if present.` }],
            details: { deleted, defaultAccount: getDefaultAccount() },
          };
        }

        if (action === "set_default_account") {
          if (!params.account) throw new Error("account required");
          setDefaultAccount(params.account);
          return {
            content: [{ type: text, text: `Set default IMAP account to ${params.account}.` }],
            details: { defaultAccount: getDefaultAccount() },
          };
        }

        const dryRun = parseBoolean(params.dryRun);
        const confirmed = parseBoolean(params.confirm);
        const account = await resolveAccount(pi, params.account);
        const client = await getClient(account);

        if (action === "list_folders") {
          const folders = await client.list();
          return {
            content: [{ type: text, text: truncate(JSON.stringify(folders, null, 2)) }],
            details: { action, account: account.name, count: folders.length },
          };
        }

        if (action === "search") {
          const folder = params.folder ?? "INBOX";
          const limit = Math.min(params.limit ?? 20, 100);
          const criteria = buildSearchCriteria(params);
          const envelopes = await client.searchAndFetch(folder, criteria, limit);
          return {
            content: [{ type: text, text: truncate(JSON.stringify(envelopes, null, 2)) }],
            details: { action, folder, criteria, count: envelopes.length },
          };
        }

        if (action === "fetch") {
          if (!params.uids) throw new Error("uids required");
          const folder = params.folder ?? "INBOX";
          const uids = parseUidList(params.uids);
          const withBody = parseBoolean(params.withBody);
          await client.select(folder);
          if (withBody) {
            const results: Array<{ uid: number; body: string }> = [];
            for (const uid of uids.split(",").map((value) => Number.parseInt(value, 10))) {
              results.push({ uid, body: (await client.fetchSource(folder, uid)).slice(0, 50_000) });
            }
            return { content: [{ type: text, text: truncate(JSON.stringify(results, null, 2)) }], details: { action, folder, count: results.length, withBody } };
          }
          const raw = await client.fetch(uids, "UID FLAGS RFC822.SIZE ENVELOPE");
          return { content: [{ type: text, text: truncate(JSON.stringify(raw, null, 2)) }], details: { action, folder, count: raw.length } };
        }

        if (action === "move") {
          if (!params.uids) throw new Error("uids required");
          if (!params.targetFolder) throw new Error("targetFolder required");
          const folder = params.folder ?? "INBOX";
          const uids = parseUidList(params.uids);
          if (dryRun) return { content: [{ type: text, text: `Dry run: move [${uids}] ${folder} → ${params.targetFolder}` }], details: { action, dryRun: true } };
          await client.select(folder);
          await client.move(uids, params.targetFolder);
          return { content: [{ type: text, text: `Moved [${uids}] ${folder} → ${params.targetFolder}` }], details: { action, from: folder, to: params.targetFolder } };
        }

        if (action === "copy") {
          if (!params.uids) throw new Error("uids required");
          if (!params.targetFolder) throw new Error("targetFolder required");
          const folder = params.folder ?? "INBOX";
          const uids = parseUidList(params.uids);
          if (dryRun) return { content: [{ type: text, text: `Dry run: copy [${uids}] ${folder} → ${params.targetFolder}` }], details: { action, dryRun: true } };
          await client.select(folder);
          await client.copy(uids, params.targetFolder);
          return { content: [{ type: text, text: `Copied [${uids}] ${folder} → ${params.targetFolder}` }], details: { action, from: folder, to: params.targetFolder } };
        }

        if (action === "flag") {
          if (!params.uids) throw new Error("uids required");
          if (!params.flags) throw new Error("flags required");
          const folder = params.folder ?? "INBOX";
          const uids = parseUidList(params.uids);
          const flagAction = (params.flagAction ?? "add").toLowerCase();
          const flags = params.flags.split(",").map((flag: string) => flag.trim()).filter(Boolean);
          if (flags.length === 0) throw new Error("flags required");
          const storeAction = flagAction === "remove" ? "-FLAGS.SILENT" : "+FLAGS.SILENT";
          if (dryRun) return { content: [{ type: text, text: `Dry run: ${flagAction} [${flags}] on [${uids}] in ${folder}` }], details: { action, dryRun: true } };
          await client.select(folder);
          await client.store(uids, storeAction, flags);
          return { content: [{ type: text, text: `${flagAction === "remove" ? "Removed" : "Added"} [${flags}] on [${uids}] in ${folder}` }], details: { action, flagAction, flags } };
        }

        if (action === "create_draft") {
          if (!params.draftSubject) throw new Error("draftSubject required");
          if (!params.draftBody) throw new Error("draftBody required");
          const target = params.folder ?? "Drafts";
          const mime = createMimeMessage({
            from: account.from,
            to: params.draftTo ?? "",
            cc: params.draftCc,
            subject: params.draftSubject,
            body: params.draftBody,
            isHtml: parseBoolean(params.draftIsHtml),
            inReplyTo: params.draftInReplyTo,
            isDraft: true,
          });
          if (dryRun) return { content: [{ type: text, text: `Dry run: draft "${params.draftSubject}" → ${target}\nFrom: ${account.from}` }], details: { action, dryRun: true } };
          await client.append(target, mime, ["\\Seen", "\\Draft"]);
          return { content: [{ type: text, text: `Draft saved: "${params.draftSubject}" → ${target}\nFrom: ${account.from}` }], details: { action, folder: target, from: account.from } };
        }

        if (action === "file_message") {
          if (!params.draftSubject) throw new Error("draftSubject required");
          if (!params.draftBody) throw new Error("draftBody required");
          if (!params.targetFolder) throw new Error("targetFolder required");
          const mime = createMimeMessage({
            from: account.from,
            to: params.draftTo ?? "",
            cc: params.draftCc,
            subject: params.draftSubject,
            body: params.draftBody,
            isHtml: parseBoolean(params.draftIsHtml),
            inReplyTo: params.draftInReplyTo,
            date: params.draftDate ? new Date(params.draftDate) : new Date(),
          });
          if (dryRun) return { content: [{ type: text, text: `Dry run: file "${params.draftSubject}" → ${params.targetFolder}\nFrom: ${account.from}` }], details: { action, dryRun: true } };
          await client.append(params.targetFolder, mime, ["\\Seen"]);
          return { content: [{ type: text, text: `Filed: "${params.draftSubject}" → ${params.targetFolder}\nFrom: ${account.from}` }], details: { action, folder: params.targetFolder, from: account.from } };
        }

        if (action === "create_folder") {
          const folder = params.folder ?? params.targetFolder;
          if (!folder) throw new Error("folder required");
          if (dryRun) return { content: [{ type: text, text: `Dry run: create "${folder}"` }], details: { action, dryRun: true } };
          await client.create(folder);
          return { content: [{ type: text, text: `Created: ${folder}` }], details: { action, folder } };
        }

        if (action === "delete_folder") {
          const folder = params.folder ?? params.targetFolder;
          if (!folder) throw new Error("folder required");
          if (!confirmed) throw new Error("delete_folder requires confirm=true");
          if (dryRun) return { content: [{ type: text, text: `Dry run: delete "${folder}"` }], details: { action, dryRun: true } };
          await client.delete(folder);
          return { content: [{ type: text, text: `Deleted: ${folder}` }], details: { action, folder } };
        }

        throw new Error(`Unknown action: "${action}"`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`IMAP ${action || "operation"} failed: ${message}`);
      }
    },
  });
}

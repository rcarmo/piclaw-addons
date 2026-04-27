/**
 * IMAP extension for pi/piclaw.
 *
 * Provides an `imap` tool: list folders, search/fetch, move/copy,
 * flag, create drafts, file messages. Zero external dependencies.
 *
 * Credentials from piclaw keychain:
 *   keychain set imap/personal '{"host":"...","port":993,"user":"...","pass":"...","tls":true,"from":"Name <email>"}'
 *
 * SAFETY: No SMTP. Cannot send email. Only IMAP read/organise/draft.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { ImapClient, buildSearchCriteria, type ImapConfig } from "./imap-client.ts";
import { createMimeMessage } from "./mime.ts";

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
			try {
				await entry.client.logout();
			} catch {}
			pool.delete(key);
		}
		if (pool.size > 0) scheduleCleanup();
	}, 60_000);
}

async function getClient(account: ImapAccount): Promise<ImapClient> {
	const key = `${account.user}@${account.host}:${account.port}`;
	const existing = pool.get(key);

	if (existing) {
		existing.lastUsed = Date.now();
		try {
			await existing.client.noop();
			return existing.client;
		} catch {
			pool.delete(key);
			try {
				await existing.client.logout();
			} catch {}
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
	return typeof value === "string" && value.toLowerCase() === "true";
}

function parseUidList(value: string): string {
	const uids = value
		.split(",")
		.map((part) => Number.parseInt(part.trim(), 10))
		.filter((uid) => Number.isFinite(uid) && uid > 0);
	if (uids.length === 0) throw new Error("uids must contain at least one positive integer");
	return [...new Set(uids)].join(",");
}

function sanitizeConfig(config: Record<string, unknown>, name: string): ImapAccount {
	const host = typeof config.host === "string" ? config.host.trim() : "";
	const user = typeof config.user === "string" ? config.user.trim() : "";
	const pass = typeof config.pass === "string" ? config.pass : "";
	if (!host || !user || !pass) {
		throw new Error(`IMAP account "${name}" missing required fields (host, user, pass).`);
	}

	const port = Number.isFinite(config.port) ? Number(config.port) : Number.parseInt(String(config.port ?? "993"), 10);
	const tls = typeof config.tls === "boolean" ? config.tls : config.tls !== "false";
	const starttls = typeof config.starttls === "boolean" ? config.starttls : config.starttls === "true";
	const from = typeof config.from === "string" && config.from.trim() ? config.from.trim() : user;
	return {
		host,
		port: Number.isFinite(port) && port > 0 ? port : 993,
		tls,
		starttls,
		user,
		pass,
		from,
		name,
		allowSend: Boolean(config.allowSend),
		allowInsecureTls: Boolean(config.allowInsecureTls),
	};
}

async function resolveAccount(pi: ExtensionAPI, accountName?: string): Promise<ImapAccount> {
	if (accountName) {
		return sanitizeConfig(await loadConfig(pi, accountName), accountName);
	}

	if (process.env.IMAP_DEFAULT_ACCOUNT) {
		const name = process.env.IMAP_DEFAULT_ACCOUNT;
		return sanitizeConfig(await loadConfig(pi, name), name);
	}

	const envKey = Object.keys(process.env)
		.filter((key) => key.startsWith("IMAP_") && key !== "IMAP_DEFAULT_ACCOUNT")
		.sort()[0];
	if (!envKey) {
		throw new Error(
			"No IMAP accounts found. Set one up with:\n" +
			'  keychain set imap/personal \'{"host":"imap.example.com","port":993,"user":"...","pass":"...","tls":true,"from":"Name <email>"}\'',
		);
	}

	const envValue = process.env[envKey];
	if (!envValue) throw new Error(`Env var ${envKey} is empty.`);
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(envValue);
	} catch {
		throw new Error(`Env var ${envKey} is not valid JSON.`);
	}
	return sanitizeConfig(parsed, envKey.replace("IMAP_", "").toLowerCase());
}

async function loadConfig(pi: ExtensionAPI, name: string): Promise<Record<string, unknown>> {
	const envKey = `IMAP_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
	const envVal = process.env[envKey];
	if (envVal) {
		try {
			return JSON.parse(envVal);
		} catch {
			throw new Error(`Env var ${envKey} is not valid JSON.`);
		}
	}

	const kcName = name.startsWith("imap/") ? name : `imap/${name}`;
	const result = await pi.exec("piclaw", ["keychain", "get", kcName], { timeout: 5000 });
	if (result.exitCode !== 0) throw new Error(`Keychain entry "${kcName}" not found.`);

	for (const line of result.stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		try {
			const parsed = JSON.parse(trimmed);
			if (typeof parsed.secret === "string") return JSON.parse(parsed.secret);
			if (parsed.secret && typeof parsed.secret === "object") return parsed.secret;
		} catch {}
	}

	throw new Error(`Could not parse keychain output for "${kcName}"`);
}

function truncate(text: string, max = 8000): string {
	return text.length > max ? `${text.slice(0, max)}\n…(truncated)` : text;
}

export default function imapExtension(pi: ExtensionAPI) {
	pi.on("session_shutdown", async () => {
		if (cleanupTimer) {
			clearTimeout(cleanupTimer);
			cleanupTimer = null;
		}
		for (const [, entry] of pool) {
			try {
				await entry.client.logout();
			} catch {}
		}
		pool.clear();
	});

	pi.registerTool({
		name: "imap",
		label: "IMAP Email",
		description:
			"Manage email via IMAP: list folders, search/fetch messages, move/copy, flag, create drafts, file messages. Cannot send email.",
		promptSnippet: "Email: list folders, search, fetch, move, copy, flag, draft, file via IMAP",
		promptGuidelines: [
			"action=list_folders: list all mailbox folders.",
			"action=search: search by from/to/subject/text/since/before/seen/flagged.",
			"action=fetch: fetch details by UID. withBody=true for full source.",
			"action=move: move UIDs to targetFolder.",
			"action=copy: copy UIDs to targetFolder.",
			"action=flag: add/remove flags (\\Seen, \\Flagged, \\Draft, etc.).",
			"action=create_draft: save draft to Drafts folder.",
			"action=file_message: append composed message to targetFolder.",
			"action=create_folder / delete_folder: manage folders.",
			"All mutating actions support dryRun=true. delete_folder needs confirm=true.",
			"This tool CANNOT send email.",
		],
		parameters: Type.Object({
			action: Type.String({ description: "list_folders|search|fetch|move|copy|flag|create_draft|file_message|create_folder|delete_folder" }),
			account: Type.Optional(Type.String({ description: "Account name (default: first available)" })),
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
		}),

		async execute(_id: string, params: any) {
			const action = (params.action ?? "").toLowerCase().trim();
			try {
				const dryRun = parseBoolean(params.dryRun);
				const confirmed = parseBoolean(params.confirm);
				const account = await resolveAccount(pi, params.account);
				const client = await getClient(account);
				const text = "text" as const;

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
						const results = [] as Array<{ uid: number; body: string }>;
						for (const uid of uids.split(",").map((value) => Number.parseInt(value, 10))) {
							results.push({ uid, body: (await client.fetchSource(folder, uid)).slice(0, 50_000) });
						}
						return {
							content: [{ type: text, text: truncate(JSON.stringify(results, null, 2)) }],
							details: { action, folder, count: results.length, withBody },
						};
					}

					const raw = await client.fetch(uids, "UID FLAGS RFC822.SIZE ENVELOPE");
					return {
						content: [{ type: text, text: truncate(JSON.stringify(raw, null, 2)) }],
						details: { action, folder, count: raw.length },
					};
				}

				if (action === "move") {
					if (!params.uids) throw new Error("uids required");
					if (!params.targetFolder) throw new Error("targetFolder required");
					const folder = params.folder ?? "INBOX";
					const uids = parseUidList(params.uids);
					if (dryRun) {
						return { content: [{ type: text, text: `Dry run: move [${uids}] ${folder} → ${params.targetFolder}` }], details: { action, dryRun: true } };
					}
					await client.select(folder);
					await client.move(uids, params.targetFolder);
					return { content: [{ type: text, text: `Moved [${uids}] ${folder} → ${params.targetFolder}` }], details: { action, from: folder, to: params.targetFolder } };
				}

				if (action === "copy") {
					if (!params.uids) throw new Error("uids required");
					if (!params.targetFolder) throw new Error("targetFolder required");
					const folder = params.folder ?? "INBOX";
					const uids = parseUidList(params.uids);
					if (dryRun) {
						return { content: [{ type: text, text: `Dry run: copy [${uids}] ${folder} → ${params.targetFolder}` }], details: { action, dryRun: true } };
					}
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
					if (dryRun) {
						return { content: [{ type: text, text: `Dry run: ${flagAction} [${flags}] on [${uids}] in ${folder}` }], details: { action, dryRun: true } };
					}
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
					if (dryRun) {
						return { content: [{ type: text, text: `Dry run: draft "${params.draftSubject}" → ${target}\nFrom: ${account.from}` }], details: { action, dryRun: true } };
					}
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
					if (dryRun) {
						return { content: [{ type: text, text: `Dry run: file "${params.draftSubject}" → ${params.targetFolder}\nFrom: ${account.from}` }], details: { action, dryRun: true } };
					}
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

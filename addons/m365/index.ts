/**
 * Public / redistributable M365 extension entry point.
 *
 * This file is intentionally the "safe to ship" half of the Microsoft 365 tooling.
 * It contains the normal day-to-day tools for:
 *
 * - Teams chat read/send operations
 * - Graph queries and profile lookups
 * - mail, people, calendar, OneDrive, SharePoint
 * - file-card helpers that upload/share documents before sending them to Teams
 *
 * It does **not** contain the private recording features anymore. Those live in the
 * separate `m365-transcripts` extension so transcript/filmstrip logic can be kept out
 * of the redistributable package if needed.
 *
 * Design pattern used throughout this file:
 * - user-facing tool registrations live here
 * - the hard platform work (auth, CDP, HTTP wrappers, OneDrive helpers) lives in
 *   `shared.ts`
 * - each tool is intentionally thin: validate params, call the shared helper layer,
 *   then shape a concise response for the model/user
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import { createLogger, debugSuppressedError } from "./compat/logger.js";
import { registerToolStatusHintProvider } from "./compat/tool-status-hints.js";

// Re-export shared infra (used by this file and available to transcripts.ts)
export * from "./shared.ts";

import {
  auth, graphFetch, chatsvcFetch, spoFetch, spoDownload, downloadDriveItem,
  edgeFetch, sleep, truncate,
  ensureOneDriveFolder, uploadBufferToOneDrive, uploadFileToOneDrive,
  ensureReadOnlyShareUrl, getExistingReadOnlyShareLink, createOneDriveShareLink,
  resolveDriveItemFromDocumentUrl, sendReferenceCardForItem,
  requireEnterprise, requireTeams,
  markdownToTeamsHtml, buildReferenceAttachmentMessageBody, uploadMarkdownToAttachments,
  getDocumentLinkMetadata,
} from "./shared.ts";

const log = createLogger("addon.m365.index");
const M365_STATUS_ICON_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><rect x="3" y="3" width="8" height="8" rx="1.2"></rect><rect x="13" y="3" width="8" height="8" rx="1.2"></rect><rect x="3" y="13" width="8" height="8" rx="1.2"></rect><rect x="13" y="13" width="8" height="8" rx="1.2"></rect></svg>`;

export function compileM365SyncPattern(pattern: string): RegExp {
	const escaped = String(pattern)
		.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&")
		.replace(/\\\*/g, ".*")
		.replace(/\\\?/g, ".");
	return new RegExp(`^${escaped}$`, "i");
}

function readTrimmedString(...values: unknown[]): string | null {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return null;
}

function extractHostLabelFromUrl(value: unknown): string | null {
	const raw = readTrimmedString(value);
	if (!raw) return null;
	try {
		return new URL(raw).host || null;
	} catch {
		const withoutProtocol = raw.replace(/^[a-z]+:\/\//i, "");
		return withoutProtocol.split("/")[0]?.trim() || null;
	}
}

registerToolStatusHintProvider({
	id: "m365",
	buildHints: ({ toolName, args }) => {
		if (!toolName.startsWith("m365_")) return null;
		const record = args && typeof args === "object" ? args as Record<string, unknown> : null;
		const host = extractHostLabelFromUrl(readTrimmedString(
			record?.siteUrl,
			record?.site_url,
			record?.webUrl,
			record?.web_url,
			record?.shareUrl,
			record?.share_url,
			record?.folderUrl,
			record?.folder_url,
			record?.attachmentUrl,
			record?.attachment_url,
			record?.documentUrl,
			record?.document_url,
			record?.fileUrl,
			record?.file_url,
			record?.linkUrl,
			record?.link_url,
			record?.base_url,
			record?.baseUrl,
			record?.url,
			record?.endpoint,
		)) || (
			toolName.startsWith("m365_teams_")
				? "teams.cloud.microsoft"
				: (toolName.startsWith("m365_spo_") || toolName.startsWith("m365_onedrive_")
					? "sharepoint.microsoft.com"
					: "graph.microsoft.com")
		);
		return {
			key: "m365",
			icon_svg: M365_STATUS_ICON_SVG,
			label: host,
			title: "Microsoft 365 target",
			kind: "service",
		};
	},
});

function logSuppressedM365Index(message: string, error: unknown, fields: Record<string, unknown> = {}): void {
  debugSuppressedError(log, message, error, fields);
}

/**
 * Register the public M365 tools.
 *
 * The extension keeps a tiny amount of UI state (the session status badge and two
 * commands for inspecting/clearing cached auth), then mostly exposes tool wrappers on
 * top of the shared helper layer.
 */
const __m365ExtDir = path.dirname(fileURLToPath(import.meta.url));

export default function (pi: ExtensionAPI) {
	// ── Skills ──
	pi.on("resources_discover", () => ({
		skillPaths: [
			path.join(__m365ExtDir, "skills", "m365-graph-query", "SKILL.md"),
			path.join(__m365ExtDir, "skills", "m365-profile", "SKILL.md"),
			path.join(__m365ExtDir, "skills", "m365-mail", "SKILL.md"),
			path.join(__m365ExtDir, "skills", "m365-teams-chats", "SKILL.md"),
			path.join(__m365ExtDir, "skills", "m365-teams-messages", "SKILL.md"),
			path.join(__m365ExtDir, "skills", "m365-teams-send", "SKILL.md"),
			path.join(__m365ExtDir, "skills", "m365-spo-search", "SKILL.md"),
			path.join(__m365ExtDir, "skills", "m365-spo-browse", "SKILL.md"),
			path.join(__m365ExtDir, "skills", "m365-spo-download", "SKILL.md"),
			path.join(__m365ExtDir, "skills", "m365-document-link-metadata", "SKILL.md"),
			path.join(__m365ExtDir, "skills", "m365-onedrive-share-local-file", "SKILL.md"),
		],
	}));

	// ── Status bar ──
	pi.on("session_start", async (_event, ctx) => {
		try {
			const s = await Promise.race([
				Promise.resolve(auth.getCacheStatus()),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("session_start timeout")), 3000)),
			]);
			const parts: string[] = [];
			if (s.graph) parts.push("Graph");
			if (s.chatsvc) parts.push("Teams");
			if (s.spoSites > 0) parts.push(`SPO(${s.spoSites})`);
			ctx.ui.setStatus("m365", `M365: ${parts.length > 0 ? parts.join("+") : "none"}`);
		} catch {
			ctx.ui.setStatus("m365", "M365: init timeout");
		}
	});

	// ── Commands ──
	pi.registerCommand("m365-status", {
		description: "Show M365 auth cache status",
		handler: async (_args, ctx) => {
			const s = auth.getCacheStatus();
			ctx.ui.notify(
				`Graph: ${s.graph ? `${s.graphMinutes}min` : "—"} | Teams: ${s.chatsvc ? `${s.chatsvcMinutes}min` : "—"} | SPO: ${s.spoSites} site(s)`,
				"info",
			);
		},
	});

	pi.registerCommand("m365-clear", {
		description: "Clear all M365 cached credentials",
		handler: async (_args, ctx) => {
			auth.clearAll();
			ctx.ui.notify("M365 credentials cleared.", "info");
			ctx.ui.setStatus("m365", "M365: none");
		},
	});

	const isTrue = (value?: string) => /^(1|true|yes|on)$/i.test((value ?? "").trim());
	const getDryRun = (params: { dryRun?: string; dry_run?: string }) => isTrue(params?.dryRun) || isTrue(params?.dry_run);
	const requireConfirmed = (actionLabel: string, params: { confirm?: string; confirmed?: string; dryRun?: string; dry_run?: string }) => {
		if (getDryRun(params)) return;
		if (isTrue(params?.confirm) || isTrue(params?.confirmed)) return;
		throw new Error(`${actionLabel} requires confirm='true'. Use dryRun='true' to preview without changing anything.`);
	};

	// ── Mail attachment helpers ──────────────────────────────────────────

	function guessMimeType(filename: string): string {
		const ext = path.extname(filename).toLowerCase();
		const map: Record<string, string> = {
			".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
			".pdf": "application/pdf",
			".png": "image/png",
			".jpg": "image/jpeg",
			".jpeg": "image/jpeg",
			".gif": "image/gif",
			".webp": "image/webp",
			".svg": "image/svg+xml",
			".txt": "text/plain",
			".md": "text/markdown",
			".csv": "text/csv",
			".json": "application/json",
			".zip": "application/zip",
			".html": "text/html",
			".htm": "text/html",
		};
		return map[ext] || "application/octet-stream";
	}

	async function attachFilesToDraft(
		messageId: string,
		attachmentPaths: string,
	): Promise<Array<{ name: string; ok: boolean; error?: string }>> {
		const paths = attachmentPaths.split(";").map((p) => p.trim()).filter(Boolean);
		const results: Array<{ name: string; ok: boolean; error?: string }> = [];

		for (const filePath of paths) {
			const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
			const name = path.basename(resolved);

			try {
				const bytes = fs.readFileSync(resolved);

				// Graph inline attachment limit is 3MB
				if (bytes.length > 3 * 1024 * 1024) {
					results.push({ name, ok: false, error: `File too large (${(bytes.length / 1024 / 1024).toFixed(1)}MB). Graph inline limit is 3MB.` });
					continue;
				}

				const contentBytes = bytes.toString("base64");
				const contentType = guessMimeType(name);

				await graphFetch(`me/messages/${messageId}/attachments`, {
					method: "POST",
					body: {
						"@odata.type": "#microsoft.graph.fileAttachment",
						name,
						contentType,
						contentBytes,
					},
				});

				results.push({ name, ok: true });
			} catch (err: any) {
				results.push({ name, ok: false, error: (err.message || String(err)).substring(0, 200) });
			}
		}

		return results;
	}

	function formatAttachmentSummary(results: Array<{ name: string; ok: boolean; error?: string }>): string {
		if (!results.length) return "";
		return "\nAttachments: " + results.map((a) => a.ok ? `✅ ${a.name}` : `❌ ${a.name}: ${a.error}`).join(", ");
	}


	// =======================================================================
	// TEAMS CHATSVC TOOLS
	// =======================================================================

	// ═══════════════════════════════════════════════════════════════════════
	// TEAMS CHATSVC TOOLS
	// ═══════════════════════════════════════════════════════════════════════

	pi.registerTool({
	name: "m365_teams_chats",
	label: "M365 Teams Chats",
	description: "List Teams chat conversations (DMs, group chats, meetings).",
	promptSnippet: "List Teams chat conversations",
	parameters: Type.Object({
		top: Type.Optional(Type.Number({ description: "Number of conversations (default 25)" })),
	}),
	async execute(_id, params): Promise<any> {
		requireTeams("m365_teams_chats");
		const result = await chatsvcFetch("/users/ME/conversations", {
			params: { view: "msnp24Equivalent", pageSize: String(params.top ?? 25), startTime: "0" },
		});
		const convs = (result.conversations ?? []).map((c: any) => ({
			id: c.id,
			topic: c.threadProperties?.topic || "(unnamed)",
			type: c.threadProperties?.threadType,
			memberCount: c.threadProperties?.memberCount,
		}));
		return { content: [{ type: "text", text: truncate(JSON.stringify(convs, null, 2)) }], details: { count: convs.length } };
	},
	});

	pi.registerTool({
	name: "m365_teams_messages",
	label: "M365 Teams Messages",
	description: "Read messages from a Teams chat thread.",
	promptSnippet: "Read messages from a Teams chat thread",
	parameters: Type.Object({
		chatId: Type.String({ description: "Chat thread ID (from m365_teams_chats)" }),
		top: Type.Optional(Type.Number({ description: "Number of messages (default 20)" })),
	}),
	async execute(_id, params): Promise<any> {
		requireTeams("m365_teams_messages");
		const maxMessages = params.top ?? 20;
		const pageSize = Math.min(maxMessages, 200);
		const contentTypes = ["Text", "RichText/Html", "RichText/Markdown"];
		const allMsgs: any[] = [];

		let nextUrl: string | null = null;
		let firstPage = true;
		while (allMsgs.length < maxMessages) {
			const result: any = firstPage
				? await chatsvcFetch(`/users/ME/conversations/${params.chatId}/messages`, {
					params: { pageSize: String(pageSize) },
				})
				: await chatsvcFetch(nextUrl!, {});

			firstPage = false;
			const batch = (result.messages ?? [])
				.filter((m: any) => contentTypes.includes(m.messagetype))
				.map((m: any) => ({
					from: m.imdisplayname || m.fromDisplayNameInToken || "Unknown",
					content: (m.content ?? "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim().substring(0, 300),
					date: m.originalarrivaltime || m.composetime || "",
				}));
			allMsgs.push(...batch);

			// Check for continuation — chatsvc uses _metadata.backwardLink
			nextUrl = result._metadata?.backwardLink ?? null;
			if (!nextUrl || batch.length === 0) break;
		}

		const msgs = allMsgs.slice(0, maxMessages);
		return { content: [{ type: "text", text: truncate(JSON.stringify(msgs, null, 2)) }], details: { chatId: params.chatId, count: msgs.length } };
	},
	});

	pi.registerTool({
	name: "m365_teams_send",
	label: "M365 Teams Send",
	description: "Send a message to a Teams chat thread, optionally with a file attachment card.",
	promptSnippet: "Send a message to a Teams chat",
	promptGuidelines: ["Always confirm with the user before sending a Teams message."],
	parameters: Type.Object({
		chatId: Type.String({ description: "Chat thread ID" }),
		message: Type.String({ description: "Message text to send" }),
		attachmentUrl: Type.Optional(Type.String({ description: "Optional share URL to render as a Teams attachment card" })),
		attachmentName: Type.Optional(Type.String({ description: "Optional attachment display name" })),
		dryRun: Type.Optional(Type.String({ description: "Set to 'true' to preview without sending" })),
		confirm: Type.Optional(Type.String({ description: "Set to 'true' to confirm sending" })),
	}),
	async execute(_id, params): Promise<any> {
		requireTeams("m365_teams_send");
		if (getDryRun(params)) {
			return {
				content: [{ type: "text", text: truncate(JSON.stringify({ dryRun: true, chatId: params.chatId, message: params.message, attachmentUrl: params.attachmentUrl ?? null, attachmentName: params.attachmentName ?? null }, null, 2)) }],
				details: { dryRun: true, chatId: params.chatId, attachmentUrl: params.attachmentUrl ?? null, attachmentName: params.attachmentName ?? null },
			};
		}
		requireConfirmed("Sending a Teams message", params);
		if (params.attachmentUrl) {
			await graphFetch(`chats/${encodeURIComponent(params.chatId)}/messages`, {
				method: "POST",
				body: buildReferenceAttachmentMessageBody(params.attachmentUrl, params.attachmentName ?? "attachment", params.message),
			});
			return {
				content: [{ type: "text", text: `Message with attachment card sent to ${params.chatId}` }],
				details: { chatId: params.chatId, attachmentUrl: params.attachmentUrl, attachmentName: params.attachmentName ?? null },
			};
		}
		await chatsvcFetch(`/users/ME/conversations/${params.chatId}/messages`, {
			method: "POST",
			body: { content: params.message, messagetype: "RichText/Html", contenttype: "text" },
		});
		return { content: [{ type: "text", text: `Message sent to ${params.chatId}` }], details: { chatId: params.chatId } };
	},
	});

	/**
	 * Convenience wrappers for Teams attachment-card flows.
	 *
	 * These are intentionally separate from the lower-level `m365_teams_send` tool:
	 * - `m365_teams_send_rich_text` focuses on markdown → Teams-safe HTML conversion
	 * - `m365_teams_send_markdown_card` / `m365_teams_upload_file_card` generate OneDrive-backed reference cards
	 * - `m365_teams_send_link_card` reuses an existing SharePoint/OneDrive URL without re-uploading
	 * - `m365_teams_send_file_card` is the convenience dispatcher that accepts either a local file path or an existing URL
	 */
	pi.registerTool({
	name: "m365_teams_send_rich_text",
	label: "M365 Teams Send Rich Text",
	description: "Send a richly formatted Teams chat message by converting Markdown to Teams-safe HTML.",
	promptSnippet: "Send rich formatted message to a Teams chat from Markdown",
	promptGuidelines: ["Always confirm with the user before sending a Teams message."],
	parameters: Type.Object({
		chatId: Type.String({ description: "Chat thread ID" }),
		markdown: Type.String({ description: "Markdown text to convert and send" }),
		dryRun: Type.Optional(Type.String({ description: "Set to 'true' to preview without sending" })),
		confirm: Type.Optional(Type.String({ description: "Set to 'true' to confirm sending" })),
	}),
	async execute(_id, params): Promise<any> {
		requireTeams("m365_teams_send_rich_text");
		const html = markdownToTeamsHtml(params.markdown ?? "");
		if (getDryRun(params)) {
			return {
				content: [{ type: "text", text: truncate(JSON.stringify({ dryRun: true, chatId: params.chatId, html }, null, 2)) }],
				details: { dryRun: true, chatId: params.chatId },
			};
		}
		requireConfirmed("Sending a Teams rich-text message", params);
		const msg = await graphFetch(`chats/${encodeURIComponent(params.chatId)}/messages`, {
			method: "POST",
			body: {
				body: {
					contentType: "html",
					content: html,
				},
			},
		});
		return {
			content: [{ type: "text", text: `Rich text message sent to ${params.chatId}` }],
			details: { chatId: params.chatId, messageId: msg?.id ?? null },
		};
	},
	});

	pi.registerTool({
	name: "m365_teams_send_markdown_card",
	label: "M365 Teams Send Markdown Card",
	description: "Upload Markdown to OneDrive Attachments and send it as a Teams reference attachment card.",
	promptSnippet: "Send markdown file as a Teams attachment card",
	promptGuidelines: ["Always confirm with the user before sending a Teams message."],
	parameters: Type.Object({
		chatId: Type.String({ description: "Chat thread ID" }),
		markdown: Type.String({ description: "Markdown file content" }),
		fileName: Type.Optional(Type.String({ description: "Target markdown filename (default autogenerated)" })),
		message: Type.Optional(Type.String({ description: "Optional message text shown above attachment" })),
		dryRun: Type.Optional(Type.String({ description: "Set to 'true' to preview without uploading or sending" })),
		confirm: Type.Optional(Type.String({ description: "Set to 'true' to confirm upload/send" })),
	}),
	async execute(_id, params): Promise<any> {
		requireTeams("m365_teams_send_markdown_card");
		const ts = new Date().toISOString().replace(/[:.]/g, "-");
		const defaultName = `notes-${ts}.md`;
		const fileName = (params.fileName?.trim() || defaultName).replace(/[<>:"/\\|?*]/g, "_");
		if (getDryRun(params)) {
			return {
				content: [{ type: "text", text: truncate(JSON.stringify({ dryRun: true, chatId: params.chatId, fileName, message: params.message ?? null }, null, 2)) }],
				details: { dryRun: true, chatId: params.chatId, fileName },
			};
		}
		requireConfirmed("Sending a Teams markdown attachment card", params);
		const uploaded = await uploadMarkdownToAttachments(params.markdown ?? "", fileName);
		const sent = await sendReferenceCardForItem({
			chatId: params.chatId,
			itemId: uploaded.id,
			driveId: uploaded.parentReference?.driveId,
			attachmentName: fileName,
			message: params.message,
			scope: "organization",
		});

		return {
			content: [{ type: "text", text: `Markdown attachment card sent to ${params.chatId}` }],
			details: {
				chatId: params.chatId,
				messageId: sent.messageId,
				itemId: uploaded.id,
				fileName,
				shareUrl: sent.shareUrl,
				reusedExistingFile: !!uploaded.reusedExistingFile,
				dedupeMode: uploaded.dedupeMode ?? null,
				reusedExistingLink: sent.reusedExistingLink,
			},
		};
	},
	});

	pi.registerTool({
	name: "m365_teams_upload_file_card",
	label: "M365 Teams Upload File Card",
	description: "Upload a local file to OneDrive (strict content dedupe) and send it to Teams as a preview card with a read-only link.",
	promptSnippet: "Upload local file and send Teams preview card",
	promptGuidelines: ["Always confirm with the user before sending a Teams message."],
	parameters: Type.Object({
		chatId: Type.String({ description: "Chat thread ID" }),
		localPath: Type.String({ description: "Local file path to upload" }),
		fileName: Type.Optional(Type.String({ description: "Optional target filename override" })),
		message: Type.Optional(Type.String({ description: "Optional message text shown above attachment" })),
		folderPath: Type.Optional(Type.String({ description: "OneDrive folder path (default: Attachments)" })),
		scope: Type.Optional(Type.String({ description: "Share link scope (default: organization)" })),
		dryRun: Type.Optional(Type.String({ description: "Set to 'true' to preview without uploading or sending" })),
		confirm: Type.Optional(Type.String({ description: "Set to 'true' to confirm upload/send" })),
	}),
	async execute(_id, params): Promise<any> {
		requireTeams("m365_teams_upload_file_card");
		if (!fs.existsSync(path.resolve(params.localPath))) throw new Error(`File not found: ${path.resolve(params.localPath)}`);
		if (getDryRun(params)) {
			return {
				content: [{ type: "text", text: truncate(JSON.stringify({ dryRun: true, chatId: params.chatId, localPath: path.resolve(params.localPath), fileName: params.fileName ?? null, folderPath: params.folderPath ?? "Attachments", scope: params.scope ?? "organization", message: params.message ?? null }, null, 2)) }],
				details: { dryRun: true, chatId: params.chatId, localPath: path.resolve(params.localPath) },
			};
		}
		requireConfirmed("Uploading a file and sending a Teams card", params);
		const uploaded = await uploadFileToOneDrive(params.localPath, params.folderPath ?? "Attachments", params.fileName, true, true);
		const attachmentName = uploaded.name ?? params.fileName ?? path.basename(params.localPath);
		const sent = await sendReferenceCardForItem({
			chatId: params.chatId,
			itemId: uploaded.id,
			driveId: uploaded.parentReference?.driveId,
			attachmentName,
			message: params.message,
			scope: params.scope ?? "organization",
		});
		return {
			content: [{ type: "text", text: `File card sent to ${params.chatId}` }],
			details: {
				chatId: params.chatId,
				messageId: sent.messageId,
				itemId: uploaded.id,
				driveId: uploaded.parentReference?.driveId ?? null,
				fileName: attachmentName,
				shareUrl: sent.shareUrl,
				reusedExistingFile: !!uploaded.reusedExistingFile,
				dedupeMode: uploaded.dedupeMode ?? null,
				reusedExistingLink: sent.reusedExistingLink,
			},
		};
	},
	});

	pi.registerTool({
	name: "m365_teams_send_link_card",
	label: "M365 Teams Send Link Card",
	description: "Send a SharePoint/Teams/OneDrive document as a Teams preview card using its existing link (no upload). Always enforces read-only sharing.",
	promptSnippet: "Send existing document link to Teams as preview card",
	promptGuidelines: ["Always confirm with the user before sending a Teams message."],
	parameters: Type.Object({
		chatId: Type.String({ description: "Chat thread ID" }),
		url: Type.String({ description: "Existing SharePoint/Teams/OneDrive document URL" }),
		attachmentName: Type.Optional(Type.String({ description: "Optional attachment display name" })),
		message: Type.Optional(Type.String({ description: "Optional message text shown above attachment" })),
		scope: Type.Optional(Type.String({ description: "Share link scope (default: organization)" })),
		dryRun: Type.Optional(Type.String({ description: "Set to 'true' to preview without sending" })),
		confirm: Type.Optional(Type.String({ description: "Set to 'true' to confirm sending" })),
	}),
	async execute(_id, params): Promise<any> {
		requireTeams("m365_teams_send_link_card");
		const resolved = await resolveDriveItemFromDocumentUrl(params.url);
		if (getDryRun(params)) {
			return {
				content: [{ type: "text", text: truncate(JSON.stringify({ dryRun: true, chatId: params.chatId, url: params.url, itemId: resolved.itemId, driveId: resolved.driveId ?? null, fileName: params.attachmentName?.trim() || resolved.fileName || "attachment", message: params.message ?? null, scope: params.scope ?? "organization" }, null, 2)) }],
				details: { dryRun: true, chatId: params.chatId, itemId: resolved.itemId, driveId: resolved.driveId ?? null },
			};
		}
		requireConfirmed("Sending a Teams link card", params);
		const attachmentName = params.attachmentName?.trim() || resolved.fileName || "attachment";
		const sent = await sendReferenceCardForItem({
			chatId: params.chatId,
			itemId: resolved.itemId,
			driveId: resolved.driveId,
			attachmentName,
			message: params.message,
			scope: params.scope ?? "organization",
		});
		return {
			content: [{ type: "text", text: `Link card sent to ${params.chatId}` }],
			details: {
				chatId: params.chatId,
				messageId: sent.messageId,
				itemId: resolved.itemId,
				driveId: resolved.driveId ?? null,
				fileName: attachmentName,
				shareUrl: sent.shareUrl,
				sourceUrl: params.url,
				reusedExistingLink: sent.reusedExistingLink,
			},
		};
	},
	});

	pi.registerTool({
	name: "m365_teams_send_file_card",
	label: "M365 Teams Send File Card",
	description: "Send a Teams file card from either a local file path or an existing SharePoint/Teams/OneDrive URL.",
	promptSnippet: "Send Teams file card from a local file or existing document URL",
	promptGuidelines: ["Always confirm with the user before sending a Teams message.", "Uses upload for local files and link-card sending for existing URLs."],
	parameters: Type.Object({
		chatId: Type.String({ description: "Chat thread ID" }),
		localPath: Type.String({ description: "Local file path or existing SharePoint/Teams document URL" }),
		fileName: Type.Optional(Type.String({ description: "Optional target filename override" })),
		message: Type.Optional(Type.String({ description: "Optional message text shown above attachment" })),
		folderPath: Type.Optional(Type.String({ description: "OneDrive folder path (default: Attachments)" })),
		scope: Type.Optional(Type.String({ description: "Share link scope (default: organization)" })),
		dryRun: Type.Optional(Type.String({ description: "Set to 'true' to preview without uploading or sending" })),
		confirm: Type.Optional(Type.String({ description: "Set to 'true' to confirm upload/send" })),
	}),
	async execute(_id, params): Promise<any> {
		requireTeams("m365_teams_send_file_card");
		const input = (params.localPath ?? "").trim();
		if (!input) throw new Error("localPath is required");
		if (getDryRun(params)) {
			const source = /^https?:\/\//i.test(input) ? "existing-document-url" : "uploaded-local-file";
			if (source === "uploaded-local-file" && !fs.existsSync(path.resolve(input))) throw new Error(`File not found: ${path.resolve(input)}`);
			return {
				content: [{ type: "text", text: truncate(JSON.stringify({ dryRun: true, chatId: params.chatId, source, input: source === "existing-document-url" ? input : path.resolve(input), fileName: params.fileName ?? null, folderPath: params.folderPath ?? "Attachments", scope: params.scope ?? "organization", message: params.message ?? null }, null, 2)) }],
				details: { dryRun: true, chatId: params.chatId, source },
			};
		}
		requireConfirmed("Sending a Teams file card", params);
		// Dispatch by input shape:
		// - URL  -> reuse existing document and send a link card
		// - path -> upload local file to OneDrive first, then send the card
		if (/^https?:\/\//i.test(input)) {
			const resolved = await resolveDriveItemFromDocumentUrl(input);
			const attachmentName = params.fileName?.trim() || resolved.fileName || "attachment";
			const sent = await sendReferenceCardForItem({
				chatId: params.chatId,
				itemId: resolved.itemId,
				driveId: resolved.driveId,
				attachmentName,
				message: params.message,
				scope: params.scope ?? "organization",
			});
			return {
				content: [{ type: "text", text: `File card sent to ${params.chatId}` }],
				details: {
					chatId: params.chatId,
					messageId: sent.messageId,
					itemId: resolved.itemId,
					driveId: resolved.driveId ?? null,
					fileName: attachmentName,
					shareUrl: sent.shareUrl,
					source: "existing-document-url",
					reusedExistingFile: true,
					dedupeMode: "n/a",
					reusedExistingLink: sent.reusedExistingLink,
				},
			};
		}

		const uploaded = await uploadFileToOneDrive(input, params.folderPath ?? "Attachments", params.fileName, true, true);
		const attachmentName = uploaded.name ?? params.fileName ?? path.basename(input);
		const sent = await sendReferenceCardForItem({
			chatId: params.chatId,
			itemId: uploaded.id,
			driveId: uploaded.parentReference?.driveId,
			attachmentName,
			message: params.message,
			scope: params.scope ?? "organization",
		});
		return {
			content: [{ type: "text", text: `File card sent to ${params.chatId}` }],
			details: {
				chatId: params.chatId,
				messageId: sent.messageId,
				itemId: uploaded.id,
				driveId: uploaded.parentReference?.driveId ?? null,
				fileName: attachmentName,
				shareUrl: sent.shareUrl,
				source: "uploaded-local-file",
				reusedExistingFile: !!uploaded.reusedExistingFile,
				dedupeMode: uploaded.dedupeMode ?? null,
				reusedExistingLink: sent.reusedExistingLink,
			},
		};
	},
	});


	// ═══════════════════════════════════════════════════════════════════════
	// GRAPH API TOOLS
	//
	// This section deliberately mixes one generic escape hatch (`m365_graph_query`)
	// with higher-level task-oriented tools. The generic tool is useful when a new
	// Graph shape is needed quickly; the specialised tools encode the stable everyday
	// workflows so prompts do not have to build raw REST paths every time.
	// ═══════════════════════════════════════════════════════════════════════


	pi.registerTool({
		name: "m365_graph_query",
		label: "M365 Graph Query",
		description:
			"Query Microsoft Graph REST API. Supports any endpoint: me, users, groups, mail, calendar, drive, sites, teams. " +
			"Returns JSON. Use OData params ($select, $filter, $search, $top, $expand, $orderby) in the path.",
		promptSnippet: "Query Microsoft Graph API (me, users, groups, mail, calendar, teams, drive, sites)",
		promptGuidelines: [
			"Use m365_graph_query for any Microsoft 365 data: user profiles, mail, calendar, groups, teams, files.",
			"Always use $select to limit fields and $top to limit results.",
			"For search, use $search=\"displayName:query\" with ConsistencyLevel:eventual (already set).",
		],
		parameters: Type.Object({
			path: Type.String({ description: "Graph API path, e.g. 'me', 'users?$top=5&$select=displayName,mail', 'me/messages?$top=10'" }),
			method: Type.Optional(Type.String({ description: "HTTP method: GET, POST, PATCH, DELETE (default GET)" })),
			body: Type.Optional(Type.String({ description: "JSON request body for POST/PATCH" })),
			version: Type.Optional(Type.String({ description: "API version: v1.0 or beta (default v1.0)" })),
		}),
		async execute(_id, params): Promise<any> {
			const body = params.body ? JSON.parse(params.body) : undefined;
			const result = await graphFetch(params.path, { method: params.method, body, version: params.version });
			return { content: [{ type: "text", text: truncate(JSON.stringify(result, null, 2)) }], details: { path: params.path } };
		},
	});

	pi.registerTool({
		name: "m365_profile",
		label: "M365 Profile",
		description: "Get current user profile, manager, or calendar events.",
		promptSnippet: "Get M365 user profile, org, manager, or calendar",
		parameters: Type.Object({
			action: Type.String({ description: "One of: profile, manager, calendar_today, calendar_upcoming" }),
		}),
		async execute(_id, params): Promise<any> {
			let result: any;
			switch (params.action) {
				case "profile":
					result = await graphFetch("me?$select=displayName,mail,userPrincipalName,jobTitle,department,officeLocation,companyName");
					break;
				case "manager":
					result = await graphFetch("me/manager?$select=displayName,mail,jobTitle,department");
					break;
				case "calendar_today": {
					const now = new Date();
					const s = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
					const e = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
					result = await graphFetch(`me/calendarView?startDateTime=${s}&endDateTime=${e}&$select=subject,start,end,location,organizer,showAs,onlineMeeting&$top=30&$orderby=start/dateTime`);
					break;
				}
				case "calendar_upcoming": {
					const s = new Date().toISOString();
					const e = new Date(Date.now() + 7 * 86400000).toISOString();
					result = await graphFetch(`me/calendarView?startDateTime=${s}&endDateTime=${e}&$select=subject,start,end,location,organizer,showAs,onlineMeeting&$top=20&$orderby=start/dateTime`);
					break;
				}
				default:
					throw new Error(`Unknown action: ${params.action}. Use: profile, manager, calendar_today, calendar_upcoming`);
			}
			return { content: [{ type: "text", text: truncate(JSON.stringify(result, null, 2)) }], details: { action: params.action } };
		},
	});

	pi.registerTool({
		name: "m365_mail",
		label: "M365 Mail",
		description:
			"Full email management: list, search, read, draft, reply, forward, delete, move, flag, mark read/unread, " +
			"list folders, and batch operations (delete, move, archive, flag, mark read). " +
			"Drafts are created in the Drafts folder with isDraft=true — user reviews and sends manually. NEVER sends email directly.",
		promptSnippet: "Email: list/search/read/draft/reply/forward/delete/move/flag/mark_read/folders/batch",
		promptGuidelines: [
			"action=list: Latest messages. Use folder param for other folders. Use filter for OData like 'isRead eq false'.",
			"action=search: KQL query across all folders. E.g. 'from:john subject:report hasattachments:true received>=2026-01-01'.",
			"action=read: Full message body + attachments list by ID.",
			"action=draft: Create draft. to/subject required. attachments='path1;path2' for file attachments (max 3MB each). NEVER sends.",
			"action=reply: Reply draft. messageId required. replyAll='true' for reply-all.",
			"action=forward: Forward draft. messageId + to required.",
			"action=delete: Delete by messageId.",
			"action=move: Move by messageId to folder (inbox/archive/deleteditems/sentitems/junkemail or folder ID).",
			"action=flag: Flag/unflag by messageId (flagValue='true'/'false').",
			"action=mark_read / mark_unread: Single messageId or batch via query. Supports dry_run.",
			"action=folders: List all mail folders with unread counts.",
			"action=batch_delete: Search + delete. ALWAYS dry_run='true' first.",
			"action=batch_move: Search + move to folder. ALWAYS dry_run='true' first.",
			"action=batch_archive: Shortcut for batch_move to archive. ALWAYS dry_run='true' first.",
			"action=batch_flag: Search + flag/unflag. ALWAYS dry_run='true' first.",
		],
		parameters: Type.Object({
			action: Type.String({ description: "list|search|read|draft|reply|forward|delete|move|flag|mark_read|mark_unread|folders|batch_delete|batch_move|batch_archive|batch_flag" }),
			// list / search / batch
			query: Type.Optional(Type.String({ description: "KQL search query" })),
			folder: Type.Optional(Type.String({ description: "Folder: inbox|sentitems|drafts|archive|deleteditems|junkemail or folder ID" })),
			top: Type.Optional(Type.Number({ description: "Max results (default 15)" })),
			filter: Type.Optional(Type.String({ description: "OData $filter (e.g. 'isRead eq false', 'hasAttachments eq true')" })),
			// read / delete / move / flag / reply / forward
			messageId: Type.Optional(Type.String({ description: "Message ID" })),
			// draft / reply / forward
			to: Type.Optional(Type.String({ description: "Semicolon-separated recipient emails" })),
			cc: Type.Optional(Type.String({ description: "Semicolon-separated CC emails" })),
			subject: Type.Optional(Type.String({ description: "Email subject" })),
			body: Type.Optional(Type.String({ description: "Email body (HTML)" })),
			importance: Type.Optional(Type.String({ description: "low | normal | high" })),
			replyAll: Type.Optional(Type.String({ description: "'true' for reply-all" })),
			attachments: Type.Optional(Type.String({ description: "Semicolon-separated workspace file paths to attach to draft/reply/forward (max 3MB each)" })),
			// flag
			flagValue: Type.Optional(Type.String({ description: "'true' to flag, 'false' to unflag" })),
			// batch / safety
			dryRun: Type.Optional(Type.String({ description: "'true' to preview without acting" })),
			dry_run: Type.Optional(Type.String({ description: "Legacy alias for dryRun" })),
			confirm: Type.Optional(Type.String({ description: "Set to 'true' to confirm destructive or state-changing actions" })),
		}),
		async execute(_id, params): Promise<any> {
			const action = (params.action ?? "").toLowerCase().trim();
			const top = Math.min(params.top ?? 15, 200);
			const dryRun = getDryRun(params);
			const selBrief = "id,subject,from,receivedDateTime,isRead,bodyPreview,flag,importance,hasAttachments";

			// ── LIST ──
			if (action === "list") {
				const folderMap: Record<string, string> = { inbox: "inbox", sent: "sentitems", sentitems: "sentitems", drafts: "drafts", archive: "archive", deleted: "deleteditems", deleteditems: "deleteditems", junk: "junkemail", junkemail: "junkemail" };
				const folderId = params.folder ? (folderMap[params.folder.toLowerCase()] || params.folder) : "inbox";
				const filterClause = params.filter ? `&$filter=${encodeURIComponent(params.filter)}` : "";
				const result: any = await graphFetch(
					`me/mailFolders/${folderId}/messages?$select=${selBrief}&$top=${top}&$orderby=receivedDateTime desc${filterClause}`
				);
				const msgs = (result?.value ?? []).map((m: any) => ({
					id: m.id, subject: m.subject, from: m.from?.emailAddress?.address,
					date: m.receivedDateTime, read: m.isRead, flagged: m.flag?.flagStatus === "flagged",
					importance: m.importance, hasAttachments: m.hasAttachments,
					preview: (m.bodyPreview ?? "").substring(0, 120),
				}));
				return { content: [{ type: "text", text: truncate(JSON.stringify(msgs, null, 2)) }], details: { action: "list", folder: folderId, count: msgs.length } };
			}

			// ── SEARCH ──
			if (action === "search") {
				if (!params.query) throw new Error("query is required for search");
				const result: any = await graphFetch(
					`me/messages?$search="${encodeURIComponent(params.query)}"&$select=${selBrief}&$top=${top}`
				);
				const msgs = (result?.value ?? []).map((m: any) => ({
					id: m.id, subject: m.subject, from: m.from?.emailAddress?.address,
					date: m.receivedDateTime, read: m.isRead, flagged: m.flag?.flagStatus === "flagged",
					preview: (m.bodyPreview ?? "").substring(0, 120),
				}));
				return { content: [{ type: "text", text: truncate(JSON.stringify(msgs, null, 2)) }], details: { action: "search", query: params.query, count: msgs.length } };
			}

			// ── READ ──
			if (action === "read") {
				if (!params.messageId) throw new Error("messageId is required for read");
				const msg: any = await graphFetch(
					`me/messages/${params.messageId}?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,bodyPreview,importance,flag,hasAttachments,conversationId`
				);
				// Fetch attachments list if present
				let attachments: any[] = [];
				if (msg?.hasAttachments) {
					try {
						const attResult: any = await graphFetch(`me/messages/${params.messageId}/attachments?$select=id,name,contentType,size`);
						attachments = (attResult?.value ?? []).map((a: any) => ({ name: a.name, type: a.contentType, size: a.size }));
					} catch (error) {
						logSuppressedM365Index("Failed to list Outlook message attachments; continuing without attachment metadata.", error, {
							messageId: params.messageId,
						});
					}
				}
				const result = {
					id: msg.id, subject: msg.subject,
					from: msg.from?.emailAddress, to: (msg.toRecipients ?? []).map((r: any) => r.emailAddress),
					cc: (msg.ccRecipients ?? []).map((r: any) => r.emailAddress),
					date: msg.receivedDateTime, importance: msg.importance,
					body: msg.body?.content ?? msg.bodyPreview ?? "",
					bodyType: msg.body?.contentType,
					attachments, conversationId: msg.conversationId,
				};
				return { content: [{ type: "text", text: truncate(JSON.stringify(result, null, 2)) }], details: { action: "read", messageId: params.messageId, hasAttachments: attachments.length > 0 } };
			}

			// ── DRAFT ──
			if (action === "draft") {
				if (!params.to) throw new Error("to is required for draft");
				if (!params.subject) throw new Error("subject is required for draft");
				const toList = params.to.split(";").map((e: string) => e.trim()).filter(Boolean);
				const msg: any = {
					subject: params.subject,
					body: { contentType: "HTML", content: params.body || "" },
					toRecipients: toList.map((email: string) => ({ emailAddress: { address: email } })),
					isDraft: true,
				};
				if (params.cc) msg.ccRecipients = params.cc.split(";").map((e: string) => e.trim()).filter(Boolean).map((email: string) => ({ emailAddress: { address: email } }));
				if (params.importance) msg.importance = params.importance;
				const created: any = await graphFetch("me/messages", { method: "POST", body: msg });
				let attachSummary = "";
				let attachResults: any[] = [];
				if (params.attachments) {
					attachResults = await attachFilesToDraft(created.id, params.attachments);
					attachSummary = formatAttachmentSummary(attachResults);
				}
				return {
					content: [{ type: "text", text: `Draft created: **${created.subject}** (to: ${toList.join(", ")})${attachSummary}\nOpen Outlook to review and send.` }],
					details: { action: "draft", messageId: created.id, subject: created.subject, to: toList, attachments: attachResults.length ? attachResults : undefined },
				};
			}

			// ── REPLY ──
			if (action === "reply") {
				if (!params.messageId) throw new Error("messageId is required for reply");
				const endpoint = params.replyAll === "true" ? "createReplyAll" : "createReply";
				const draft: any = await graphFetch(`me/messages/${params.messageId}/${endpoint}`, { method: "POST", body: {} });
				// Patch the draft with our body if provided
				if (params.body) {
					await graphFetch(`me/messages/${draft.id}`, { method: "PATCH", body: {
						body: { contentType: "HTML", content: params.body },
					}});
				}
				let attachSummary = "";
				let attachResults: any[] = [];
				if (params.attachments) {
					attachResults = await attachFilesToDraft(draft.id, params.attachments);
					attachSummary = formatAttachmentSummary(attachResults);
				}
				return {
					content: [{ type: "text", text: `Reply draft created for: **${draft.subject}**${attachSummary}\nOpen Outlook to review and send.` }],
					details: { action: "reply", draftId: draft.id, replyAll: params.replyAll === "true", originalId: params.messageId, attachments: attachResults.length ? attachResults : undefined },
				};
			}

			// ── FORWARD ──
			if (action === "forward") {
				if (!params.messageId) throw new Error("messageId is required for forward");
				if (!params.to) throw new Error("to is required for forward");
				const draft: any = await graphFetch(`me/messages/${params.messageId}/createForward`, { method: "POST", body: {} });
				const toList = params.to.split(";").map((e: string) => e.trim()).filter(Boolean);
				const patch: any = { toRecipients: toList.map((email: string) => ({ emailAddress: { address: email } })) };
				if (params.body) patch.body = { contentType: "HTML", content: params.body };
				await graphFetch(`me/messages/${draft.id}`, { method: "PATCH", body: patch });
				let attachSummary = "";
				let attachResults: any[] = [];
				if (params.attachments) {
					attachResults = await attachFilesToDraft(draft.id, params.attachments);
					attachSummary = formatAttachmentSummary(attachResults);
				}
				return {
					content: [{ type: "text", text: `Forward draft created: **${draft.subject}** (to: ${toList.join(", ")})${attachSummary}\nOpen Outlook to review and send.` }],
					details: { action: "forward", draftId: draft.id, to: toList, originalId: params.messageId, attachments: attachResults.length ? attachResults : undefined },
				};
			}

			// ── DELETE ──
			if (action === "delete") {
				if (!params.messageId) throw new Error("messageId is required for delete");
				if (dryRun) {
					return { content: [{ type: "text", text: `Dry run: would delete message ${params.messageId}` }], details: { action: "delete", dryRun: true, messageId: params.messageId } };
				}
				requireConfirmed("Deleting a mail message", params);
				await graphFetch(`me/messages/${params.messageId}`, { method: "DELETE" });
				return { content: [{ type: "text", text: `Deleted message ${params.messageId}` }], details: { action: "delete", messageId: params.messageId } };
			}

			// ── MOVE ──
			if (action === "move") {
				if (!params.messageId) throw new Error("messageId is required for move");
				if (!params.folder) throw new Error("folder is required for move");
				const folderMap: Record<string, string> = { inbox: "inbox", archive: "archive", deleted: "deleteditems", deleteditems: "deleteditems", drafts: "drafts", sent: "sentitems", sentitems: "sentitems", junk: "junkemail", junkemail: "junkemail" };
				const destinationId = folderMap[params.folder.toLowerCase()] || params.folder;
				if (dryRun) {
					return {
						content: [{ type: "text", text: `Dry run: would move message ${params.messageId} to ${params.folder}` }],
						details: { action: "move", dryRun: true, messageId: params.messageId, folder: params.folder, destinationId },
					};
				}
				requireConfirmed("Moving a mail message", params);
				const moved: any = await graphFetch(`me/messages/${params.messageId}/move`, { method: "POST", body: { destinationId } });
				return {
					content: [{ type: "text", text: `Moved message to ${params.folder}` }],
					details: { action: "move", messageId: params.messageId, folder: params.folder, newId: moved?.id },
				};
			}

			// ── FLAG ──
			if (action === "flag") {
				if (!params.messageId) throw new Error("messageId is required for flag");
				const flagStatus = params.flagValue === "false" ? "notFlagged" : "flagged";
				if (dryRun) {
					return {
						content: [{ type: "text", text: `Dry run: would ${flagStatus === "flagged" ? "flag" : "unflag"} message ${params.messageId}` }],
						details: { action: "flag", dryRun: true, messageId: params.messageId, flagStatus },
					};
				}
				requireConfirmed("Flagging a mail message", params);
				await graphFetch(`me/messages/${params.messageId}`, { method: "PATCH", body: { flag: { flagStatus } } });
				return {
					content: [{ type: "text", text: `${flagStatus === "flagged" ? "Flagged" : "Unflagged"} message` }],
					details: { action: "flag", messageId: params.messageId, flagStatus },
				};
			}

			// ── FOLDERS ──
			if (action === "folders") {
				const result: any = await graphFetch("me/mailFolders?$select=id,displayName,totalItemCount,unreadItemCount&$top=50");
				const folders = (result?.value ?? []).map((f: any) => ({
					id: f.id, name: f.displayName, total: f.totalItemCount, unread: f.unreadItemCount,
				}));
				return { content: [{ type: "text", text: truncate(JSON.stringify(folders, null, 2)) }], details: { action: "folders", count: folders.length } };
			}

			// ── BATCH helpers ──
			const batchSearch = async () => {
				if (!params.query) throw new Error("query is required for batch operations");
				const batchTop = Math.min(top, 100);
				const result: any = await graphFetch(
					`me/messages?$search="${encodeURIComponent(params.query)}"&$select=id,subject,from,receivedDateTime&$top=${batchTop}`
				);
				return result?.value ?? [];
			};

			if (action === "batch_delete") {
				const msgs = await batchSearch();
				if (dryRun) {
					const preview = msgs.map((m: any) => ({ id: m.id, subject: m.subject, from: m.from?.emailAddress?.address, date: m.receivedDateTime }));
					return {
						content: [{ type: "text", text: `Dry run: would delete ${msgs.length} messages:\n${truncate(JSON.stringify(preview, null, 2))}` }],
						details: { action: "batch_delete", dryRun: true, count: msgs.length },
					};
				}
				requireConfirmed("Batch deleting mail messages", params);
				let deleted = 0;
				for (const m of msgs) {
					try {
						await graphFetch(`me/messages/${m.id}`, { method: "DELETE" });
						deleted++;
					} catch (error) {
						logSuppressedM365Index("Failed to delete one Outlook message during a batch delete; continuing.", error, {
							messageId: m.id,
							query: params.query,
						});
					}
				}
				return {
					content: [{ type: "text", text: `Deleted ${deleted}/${msgs.length} messages matching "${params.query}"` }],
					details: { action: "batch_delete", deleted, total: msgs.length, query: params.query },
				};
			}

			if (action === "batch_move" || action === "batch_archive") {
				const destFolder = action === "batch_archive" ? "archive" : (params.folder ?? "archive");
				const folderMap: Record<string, string> = { inbox: "inbox", archive: "archive", deleted: "deleteditems", deleteditems: "deleteditems", junk: "junkemail", junkemail: "junkemail" };
				const destinationId = folderMap[destFolder.toLowerCase()] || destFolder;
				const msgs = await batchSearch();
				if (dryRun) {
					const preview = msgs.map((m: any) => ({ id: m.id, subject: m.subject, from: m.from?.emailAddress?.address, date: m.receivedDateTime }));
					return {
						content: [{ type: "text", text: `Dry run: would move ${msgs.length} messages to ${destFolder}:\n${truncate(JSON.stringify(preview, null, 2))}` }],
						details: { action, dryRun: true, count: msgs.length, folder: destFolder },
					};
				}
				requireConfirmed(`Batch moving mail messages to ${destFolder}`, params);
				let moved = 0;
				for (const m of msgs) {
					try {
						await graphFetch(`me/messages/${m.id}/move`, { method: "POST", body: { destinationId } });
						moved++;
					} catch (error) {
						logSuppressedM365Index("Failed to move one Outlook message during a batch move; continuing.", error, {
							messageId: m.id,
							destinationId,
							query: params.query,
						});
					}
				}
				return {
					content: [{ type: "text", text: `Moved ${moved}/${msgs.length} messages to ${destFolder}` }],
					details: { action, moved, total: msgs.length, folder: destFolder, query: params.query },
				};
			}

			// ── BATCH FLAG ──
			if (action === "batch_flag") {
				const msgs = await batchSearch();
				const flagStatus = params.flagValue === "false" ? "notFlagged" : "flagged";
				if (dryRun) {
					const preview = msgs.map((m: any) => ({ id: m.id, subject: m.subject, from: m.from?.emailAddress?.address }));
					return {
						content: [{ type: "text", text: `Dry run: would ${flagStatus === "flagged" ? "flag" : "unflag"} ${msgs.length} messages:\n${truncate(JSON.stringify(preview, null, 2))}` }],
						details: { action: "batch_flag", dryRun: true, count: msgs.length, flagStatus },
					};
				}
				requireConfirmed(`${flagStatus === "flagged" ? "Batch flagging" : "Batch unflagging"} mail messages`, params);
				let updated = 0;
				for (const m of msgs) {
					try {
						await graphFetch(`me/messages/${m.id}`, { method: "PATCH", body: { flag: { flagStatus } } });
						updated++;
					} catch (error) {
						logSuppressedM365Index("Failed to update one Outlook flag during a batch flag operation; continuing.", error, {
							messageId: m.id,
							flagStatus,
							query: params.query,
						});
					}
				}
				return {
					content: [{ type: "text", text: `${flagStatus === "flagged" ? "Flagged" : "Unflagged"} ${updated}/${msgs.length} messages` }],
					details: { action: "batch_flag", updated, total: msgs.length, flagStatus, query: params.query },
				};
			}

			// ── MARK READ / UNREAD ──
			if (action === "mark_read" || action === "mark_unread") {
				const isRead = action === "mark_read";
				if (params.messageId) {
					if (dryRun) {
						return {
							content: [{ type: "text", text: `Dry run: would mark ${isRead ? "read" : "unread"}: ${params.messageId}` }],
							details: { action, dryRun: true, messageId: params.messageId, isRead },
						};
					}
					requireConfirmed(`Marking a mail message ${isRead ? "read" : "unread"}`, params);
					await graphFetch(`me/messages/${params.messageId}`, { method: "PATCH", body: { isRead } });
					return {
						content: [{ type: "text", text: `Marked ${isRead ? "read" : "unread"}: ${params.messageId}` }],
						details: { action, messageId: params.messageId, isRead },
					};
				}
				// Batch mode: search + mark
				const msgs = await batchSearch();
				if (dryRun) {
					const preview = msgs.map((m: any) => ({ id: m.id, subject: m.subject, from: m.from?.emailAddress?.address }));
					return {
						content: [{ type: "text", text: `Dry run: would mark ${isRead ? "read" : "unread"} ${msgs.length} messages:\n${truncate(JSON.stringify(preview, null, 2))}` }],
						details: { action, dryRun: true, count: msgs.length },
					};
				}
				requireConfirmed(`Batch marking mail messages ${isRead ? "read" : "unread"}`, params);
				let updated = 0;
				for (const m of msgs) {
					try {
						await graphFetch(`me/messages/${m.id}`, { method: "PATCH", body: { isRead } });
						updated++;
					} catch (error) {
						logSuppressedM365Index("Failed to update one Outlook read-state during a batch mark operation; continuing.", error, {
							messageId: m.id,
							isRead,
							query: params.query,
						});
					}
				}
				return {
					content: [{ type: "text", text: `Marked ${isRead ? "read" : "unread"}: ${updated}/${msgs.length} messages` }],
					details: { action, updated, total: msgs.length, query: params.query },
				};
			}

			throw new Error(`Unknown action: ${action}. Use: list|search|read|draft|reply|forward|delete|move|flag|folders|mark_read|mark_unread|batch_delete|batch_move|batch_archive|batch_flag`);
		},
	});

	// ── People search & resolve ──
	pi.registerTool({
		name: "m365_people",
		label: "M365 People Search",
		description:
			"Search for people by name, email, or keyword. Returns display name, email, job title, department. " +
			"Uses Graph People API (relevance-ranked) and falls back to directory search.",
		promptSnippet: "Find people by name/email in the organization",
		promptGuidelines: [
			"Use this to resolve display names to email addresses for calendar invites, email drafts, etc.",
			"Results are ranked by relevance to the current user (frequent contacts first).",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Name, email, or keyword to search" }),
			top: Type.Optional(Type.Number({ description: "Max results (default 10)" })),
		}),
		async execute(_id, params): Promise<any> {
			const top = params.top ?? 10;
			let people: any[] = [];

			// Primary: People API (relevance-ranked)
			try {
				const result: any = await graphFetch(
					`me/people?$search="${encodeURIComponent(params.query)}"&$select=displayName,scoredEmailAddresses,jobTitle,department,companyName,personType&$top=${top}`
				);
				people = (result?.value ?? []).map((p: any) => ({
					name: p.displayName,
					email: p.scoredEmailAddresses?.[0]?.address || "",
					jobTitle: p.jobTitle || "",
					department: p.department || "",
					company: p.companyName || "",
					type: p.personType?.subclass || p.personType?.class || "",
				}));
			} catch (error) {
				logSuppressedM365Index("People API search failed; falling back to directory lookup.", error, {
					query: params.query,
					top,
				});
			}

			// Fallback: Directory users search
			if (people.length === 0) {
				try {
					const result: any = await graphFetch(
						`users?$filter=startswith(displayName,'${encodeURIComponent(params.query)}') or startswith(mail,'${encodeURIComponent(params.query)}')&$select=displayName,mail,jobTitle,department,companyName&$top=${top}`
					);
					people = (result?.value ?? []).map((u: any) => ({
						name: u.displayName,
						email: u.mail || "",
						jobTitle: u.jobTitle || "",
						department: u.department || "",
						company: u.companyName || "",
						type: "directory",
					}));
				} catch (error) {
					logSuppressedM365Index("Directory fallback for people search failed.", error, {
						query: params.query,
						top,
					});
				}
			}

			return {
				content: [{ type: "text", text: truncate(JSON.stringify(people, null, 2)) }],
				details: { query: params.query, count: people.length },
			};
		},
	});

	// ── OneDrive quick operations ──
	pi.registerTool({
		name: "m365_onedrive",
		label: "M365 OneDrive",
		description:
			"OneDrive operations: list folder contents, search files, get item metadata, create folders, and delete items. " +
			"Works on the current user's OneDrive. For SharePoint sites, use m365_spo_browse.",
		promptSnippet: "OneDrive: list / search / info / mkdir / delete",
		promptGuidelines: [
			"action=list: folderPath defaults to root. Returns name, size, modified date, type.",
			"action=search: query uses OneDrive search. Returns matching files across all folders.",
			"action=info: itemPath or itemId required. Returns full metadata including download URL.",
			"action=mkdir: folderPath required. Creates nested folders.",
			"action=delete: itemPath or itemId required. Always confirm with user first.",
		],
		parameters: Type.Object({
			action: Type.String({ description: "list | search | info | mkdir | delete" }),
			folderPath: Type.Optional(Type.String({ description: "Folder path (e.g. 'Documents/Reports')" })),
			itemPath: Type.Optional(Type.String({ description: "Item path for info/delete" })),
			itemId: Type.Optional(Type.String({ description: "Item ID for info/delete" })),
			query: Type.Optional(Type.String({ description: "Search query for search action" })),
			top: Type.Optional(Type.Number({ description: "Max results (default 25)" })),
			dryRun: Type.Optional(Type.String({ description: "Set to 'true' to preview without changing anything" })),
			confirm: Type.Optional(Type.String({ description: "Set to 'true' to confirm deletion" })),
		}),
		async execute(_id, params): Promise<any> {
			const action = (params.action ?? "").toLowerCase().trim();
			const dryRun = getDryRun(params);
			const top = params.top ?? 25;

			if (action === "list") {
				const fp = (params.folderPath ?? "").replace(/^\//, "").replace(/\/$/, "");
				const endpoint = fp
					? `me/drive/root:/${encodeURIComponent(fp).replace(/%2F/g, "/")}:/children?$select=name,id,size,lastModifiedDateTime,file,folder&$top=${top}`
					: `me/drive/root/children?$select=name,id,size,lastModifiedDateTime,file,folder&$top=${top}`;
				const result: any = await graphFetch(endpoint);
				const items = (result?.value ?? []).map((i: any) => ({
					name: i.name,
					id: i.id,
					size: i.size,
					modified: i.lastModifiedDateTime,
					type: i.folder ? `folder(${i.folder.childCount})` : (i.file?.mimeType ?? "file"),
				}));
				return {
					content: [{ type: "text", text: truncate(JSON.stringify(items, null, 2)) }],
					details: { action: "list", path: fp || "/", count: items.length },
				};
			}

			if (action === "search") {
				if (!params.query) throw new Error("query is required for search");
				const result: any = await graphFetch(
					`me/drive/root/search(q='${encodeURIComponent(params.query)}')?$select=name,id,size,lastModifiedDateTime,parentReference,webUrl&$top=${top}`
				);
				const items = (result?.value ?? []).map((i: any) => ({
					name: i.name,
					id: i.id,
					size: i.size,
					modified: i.lastModifiedDateTime,
					path: i.parentReference?.path?.replace("/drive/root:", "") || "/",
					webUrl: i.webUrl,
				}));
				return {
					content: [{ type: "text", text: truncate(JSON.stringify(items, null, 2)) }],
					details: { action: "search", query: params.query, count: items.length },
				};
			}

			if (action === "info") {
				const endpoint = params.itemId
					? `me/drive/items/${params.itemId}?$select=name,id,size,lastModifiedDateTime,createdDateTime,file,folder,parentReference,webUrl,@microsoft.graph.downloadUrl`
					: params.itemPath
					? `me/drive/root:/${encodeURIComponent(params.itemPath).replace(/%2F/g, "/")}?$select=name,id,size,lastModifiedDateTime,createdDateTime,file,folder,parentReference,webUrl,@microsoft.graph.downloadUrl`
					: null;
				if (!endpoint) throw new Error("itemPath or itemId required for info");
				const item: any = await graphFetch(endpoint);
				return {
					content: [{ type: "text", text: truncate(JSON.stringify(item, null, 2)) }],
					details: { action: "info", name: item?.name, id: item?.id, size: item?.size },
				};
			}

			if (action === "mkdir") {
				if (!params.folderPath) throw new Error("folderPath is required for mkdir");
				if (dryRun) {
					return {
						content: [{ type: "text", text: `Dry run: would create folder ${params.folderPath}` }],
						details: { action: "mkdir", dryRun: true, path: params.folderPath },
					};
				}
				requireConfirmed("Creating a OneDrive folder", params);
				const result = await ensureOneDriveFolder(params.folderPath);
				return {
					content: [{ type: "text", text: `Created folder: ${params.folderPath} (id: ${result?.id})` }],
					details: { action: "mkdir", path: params.folderPath, id: result?.id },
				};
			}

			if (action === "delete") {
				const endpoint = params.itemId
					? `me/drive/items/${params.itemId}`
					: params.itemPath
					? `me/drive/root:/${encodeURIComponent(params.itemPath).replace(/%2F/g, "/")}`
					: null;
				if (!endpoint) throw new Error("itemPath or itemId required for delete");
				if (dryRun) {
					return {
						content: [{ type: "text", text: `Dry run: would delete ${params.itemPath || params.itemId}` }],
						details: { action: "delete", dryRun: true, path: params.itemPath, id: params.itemId },
					};
				}
				requireConfirmed("Deleting a OneDrive item", params);
				await graphFetch(endpoint, { method: "DELETE" });
				return {
					content: [{ type: "text", text: `Deleted: ${params.itemPath || params.itemId}` }],
					details: { action: "delete", path: params.itemPath, id: params.itemId },
				};
			}

			throw new Error(`Unknown action: ${action}. Use: list | search | info | mkdir | delete`);
		},
	});

	// ═══════════════════════════════════════════════════════════════════════
	// Teams chat/message/send/transcript tools → m365-teams extension
	// ═══════════════════════════════════════════════════════════════════════

	// ═══════════════════════════════════════════════════════════════════════
	// SHAREPOINT / ONEDRIVE TOOLS
	// ═══════════════════════════════════════════════════════════════════════

	pi.registerTool({
		name: "m365_spo_search",
		label: "M365 SharePoint Search",
		description:
			"Search for files across SharePoint sites and OneDrive. Supports KQL queries (e.g. 'filetype:pptx project').",
		promptSnippet: "Search files across SharePoint/OneDrive (KQL queries, filetype filters)",
		promptGuidelines: [
			"For SharePoint search, siteUrl should be the root or team site (e.g. https://contoso.sharepoint.com).",
			"Use filetype: prefix to filter (e.g. 'filetype:vtt meeting').",
		],
		parameters: Type.Object({
			siteUrl: Type.String({ description: "SharePoint site URL" }),
			query: Type.String({ description: "KQL search query" }),
			top: Type.Optional(Type.Number({ description: "Max results (default 20)" })),
		}),
		async execute(_id, params): Promise<any> {
			const top = params.top ?? 20;
			const encoded = encodeURIComponent(params.query);
			const result = await spoFetch(params.siteUrl, `/_api/search/query?querytext='${encoded}'&selectproperties='Title,Path,Size,LastModifiedTime,Author,FileExtension'&rowlimit=${top}`);
			const rows = result?.PrimaryQueryResult?.RelevantResults?.Table?.Rows ?? [];
			const items = rows.map((row: any) => {
				const cells: Record<string, string> = {};
				for (const cell of row.Cells ?? []) cells[cell.Key] = cell.Value;
				return { title: cells.Title, path: cells.Path, size: cells.Size, modified: cells.LastModifiedTime, author: cells.Author };
			});
			return { content: [{ type: "text", text: truncate(JSON.stringify(items, null, 2)) }], details: { query: params.query, count: items.length } };
		},
	});

	pi.registerTool({
		name: "m365_spo_browse",
		label: "M365 OneDrive Browse",
		description: "List files in a OneDrive/SharePoint folder.",
		promptSnippet: "List files in OneDrive/SharePoint folder",
		parameters: Type.Object({
			siteUrl: Type.String({ description: "SharePoint personal/team site URL" }),
			folderPath: Type.Optional(Type.String({ description: "Folder path relative to drive root. Omit for root." })),
		}),
		async execute(_id, params): Promise<any> {
			const folder = params.folderPath?.replace(/ /g, "%20").replace(/^\//, "") ?? "";
			const apiPath = folder
				? `/_api/v2.0/drive/root:/${folder}:/children?select=name,id,size,lastModifiedDateTime,file,folder`
				: `/_api/v2.0/drive/root/children?select=name,id,size,lastModifiedDateTime,file,folder`;
			const result = await spoFetch(params.siteUrl, apiPath);
			const items = (result.value ?? []).map((item: any) => ({
				name: item.name,
				size: item.size,
				modified: item.lastModifiedDateTime,
				type: item.folder ? `folder(${item.folder.childCount})` : item.file?.mimeType ?? "file",
			}));
			return { content: [{ type: "text", text: truncate(JSON.stringify(items, null, 2)) }], details: { count: items.length } };
		},
	});

	pi.registerTool({
		name: "m365_spo_download",
		label: "M365 File Download",
		description: "Download a file from SharePoint/OneDrive to local disk.",
		promptSnippet: "Download file from SharePoint/OneDrive",
		parameters: Type.Object({
			siteUrl: Type.String({ description: "SharePoint personal/team site URL" }),
			filePath: Type.String({ description: "File path relative to drive root" }),
			outFile: Type.Optional(Type.String({ description: "Local output path (default: cwd + filename)" })),
		}),
		async execute(_id, params): Promise<any> {
			const { file, size } = await spoDownload(params.siteUrl, params.filePath, params.outFile);
			return { content: [{ type: "text", text: `Downloaded ${file} (${Math.round(size / 1024)} KB)` }], details: { file, size } };
		},
	});

	pi.registerTool({
		name: "m365_document_link_metadata",
		label: "M365 Document Link Metadata",
		description: "Resolve a SharePoint or Teams document link and return filename, preview image URL, and document URL.",
		promptSnippet: "Extract document metadata from a SharePoint or Teams file link",
		promptGuidelines: [
			"Use this for SharePoint links and Teams file links that ultimately point to SharePoint/OneDrive documents.",
			"Returns the resolved filename, canonical document URL, and preview image URL when thumbnails are available.",
			"Teams links are resolved by extracting the underlying objectUrl/url when present.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "SharePoint or Teams document URL" }),
		}),
		async execute(_id, params): Promise<any> {
			const result = await getDocumentLinkMetadata(params.url);
			return { content: [{ type: "text", text: truncate(JSON.stringify(result, null, 2)) }], details: result };
		},
	});

	pi.registerTool({
		name: "m365_onedrive_share_local_file",
		label: "M365 OneDrive Share Local File",
		description: "Upload a local file to your OneDrive Attachments folder and return a read-only share link.",
		promptSnippet: "Upload a local file to OneDrive and get a shareable read-only link",
		parameters: Type.Object({
			localPath: Type.String({ description: "Local file path to upload" }),
			folderPath: Type.Optional(Type.String({ description: "OneDrive folder path (default: Attachments)" })),
			fileName: Type.Optional(Type.String({ description: "Optional target filename override" })),
			scope: Type.Optional(Type.String({ description: "Link scope (default: organization)" })),
			dryRun: Type.Optional(Type.String({ description: "Set to 'true' to preview without uploading" })),
			confirm: Type.Optional(Type.String({ description: "Set to 'true' to confirm upload/share-link creation" })),
		}),
		async execute(_id, params): Promise<any> {
			const resolvedPath = path.resolve(params.localPath);
			if (!fs.existsSync(resolvedPath)) throw new Error(`File not found: ${resolvedPath}`);
			if (getDryRun(params)) {
				return {
					content: [{ type: "text", text: truncate(JSON.stringify({ dryRun: true, localPath: resolvedPath, folderPath: params.folderPath ?? "Attachments", fileName: params.fileName ?? path.basename(resolvedPath), scope: params.scope ?? "organization" }, null, 2)) }],
					details: { dryRun: true, localPath: resolvedPath, folderPath: params.folderPath ?? "Attachments" },
				};
			}
			requireConfirmed("Uploading a local file to OneDrive and creating a share link", params);
			const uploaded = await uploadFileToOneDrive(params.localPath, params.folderPath ?? "Attachments", params.fileName, true, true);
			const { permission, reusedExistingLink } = await ensureReadOnlyShareUrl(uploaded.id, params.scope ?? "organization", uploaded.parentReference?.driveId);
			const result = {
				filename: uploaded.name,
				itemId: uploaded.id,
				folderPath: params.folderPath ?? "Attachments",
				documentUrl: uploaded.webUrl ?? null,
				shareUrl: permission?.link?.webUrl ?? null,
				reusedExistingFile: !!uploaded.reusedExistingFile,
				reusedExistingLink,
			};
			return { content: [{ type: "text", text: truncate(JSON.stringify(result, null, 2)) }], details: result };
		},
	});

	// ═══════════════════════════════════════════════════════════════════════
	// SHAREPOINT / ONEDRIVE UPLOAD TOOL
	// ═══════════════════════════════════════════════════════════════════════

	pi.registerTool({
		name: "m365_spo_upload",
		label: "M365 SharePoint/OneDrive Upload",
		description:
			"Upload a local file to any SharePoint or OneDrive folder. Provide the driveId + folderId (from m365_spo_browse or " +
			"m365_document_link_metadata), or a folderUrl (SharePoint sharing link to a folder). " +
			"Supports files up to 250 MB via resumable upload sessions.",
		promptSnippet: "Upload a local file to SharePoint or OneDrive",
		promptGuidelines: [
			"Use m365_document_link_metadata on a SharePoint folder link to get driveId and folderId.",
			"For OneDrive personal uploads, use m365_onedrive_share_local_file instead.",
			"Returns the uploaded file's webUrl and driveItem metadata.",
		],
		parameters: Type.Object({
			localPath: Type.String({ description: "Local file path to upload" }),
			driveId: Type.Optional(Type.String({ description: "Target drive ID (from m365_spo_browse or document_link_metadata)" })),
			folderId: Type.Optional(Type.String({ description: "Target folder item ID" })),
			folderUrl: Type.Optional(Type.String({ description: "SharePoint sharing link to the target folder (alternative to driveId+folderId)" })),
			fileName: Type.Optional(Type.String({ description: "Override filename (default: use local filename)" })),
			dryRun: Type.Optional(Type.String({ description: "Set to 'true' to preview without uploading" })),
			confirm: Type.Optional(Type.String({ description: "Set to 'true' to confirm upload" })),
		}),
		async execute(_id, params): Promise<any> {
			const resolvedPath = path.resolve(params.localPath);
			if (!fs.existsSync(resolvedPath)) throw new Error(`File not found: ${resolvedPath}`);
			const stat = fs.statSync(resolvedPath);
			if (!stat.isFile()) throw new Error(`Not a file: ${resolvedPath}`);
			const fileName = params.fileName?.trim() || path.basename(resolvedPath);
			const buffer = fs.readFileSync(resolvedPath);

			let driveId = params.driveId;
			let folderId = params.folderId;

			// Resolve folder URL if provided
			if (params.folderUrl && (!driveId || !folderId)) {
				const b64 = Buffer.from(params.folderUrl).toString("base64").replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
				const resolved: any = await graphFetch(`shares/u!${b64}/driveItem?$select=id,name,parentReference,folder`);
				driveId = resolved.parentReference?.driveId;
				folderId = resolved.id;
				if (!resolved.folder) throw new Error(`Resolved URL is not a folder: ${resolved.name}`);
			}

			if (!driveId || !folderId) throw new Error("Provide either (driveId + folderId) or folderUrl");
			if (getDryRun(params)) {
				return {
					content: [{ type: "text", text: truncate(JSON.stringify({ dryRun: true, localPath: resolvedPath, driveId, folderId, fileName, size: buffer.length }, null, 2)) }],
					details: { dryRun: true, localPath: resolvedPath, driveId, folderId, fileName, size: buffer.length },
				};
			}
			requireConfirmed("Uploading a SharePoint/OneDrive file", params);

			const MAX_SIMPLE = 4 * 1024 * 1024;
			let result: any;

			if (buffer.length <= MAX_SIMPLE) {
				result = await graphFetch(`drives/${driveId}/items/${folderId}:/${encodeURIComponent(fileName)}:/content`, {
					method: "PUT",
					rawBody: buffer as any,
					headers: { "Content-Type": "application/octet-stream" },
				});
			} else {
				// Resumable upload session
				const session: any = await graphFetch(`drives/${driveId}/items/${folderId}:/${encodeURIComponent(fileName)}:/createUploadSession`, {
					method: "POST",
					body: { item: { "@microsoft.graph.conflictBehavior": "replace", name: fileName } },
				});
				const uploadUrl = session.uploadUrl;
				if (!uploadUrl) throw new Error("Failed to create upload session");

				const CHUNK_SIZE = 3_932_160;
				let offset = 0;
				result = null;
				while (offset < buffer.length) {
					const end = Math.min(offset + CHUNK_SIZE, buffer.length);
					const chunk = buffer.subarray(offset, end);
					const resp = await edgeFetch(uploadUrl, {
						method: "PUT",
						headers: {
							"Content-Length": String(chunk.length),
							"Content-Range": `bytes ${offset}-${end - 1}/${buffer.length}`,
						},
						body: chunk,
						signal: AbortSignal.timeout(120_000),
					});
					if (!resp.ok) throw new Error(`Upload chunk failed: ${resp.status} ${await resp.text()}`);
					result = await resp.json();
					offset = end;
				}
			}

			const summary = `Uploaded **${fileName}** (${Math.round(buffer.length / 1024)} KB) → ${result.webUrl || result.name}`;
			return { content: [{ type: "text", text: summary }], details: result };
		},
	});

	// ═══════════════════════════════════════════════════════════════════════
	// SHAREPOINT / ONEDRIVE SYNC TOOL
	// ═══════════════════════════════════════════════════════════════════════

	pi.registerTool({
		name: "m365_spo_sync",
		label: "M365 SharePoint/OneDrive Sync",
		description:
			"Sync local files/folders with a SharePoint or OneDrive folder. Compares by filename + size + lastModified " +
			"and uploads new/changed files, optionally downloads remote-only files. Skips unchanged files.",
		promptSnippet: "Sync local folder with SharePoint/OneDrive",
		promptGuidelines: [
			"Use m365_document_link_metadata on a folder sharing link to get driveId and folderId.",
			"direction='upload' pushes local changes to remote. direction='download' pulls remote to local. direction='both' does bidirectional.",
			"Dry-run mode (dryRun='true') shows what would change without modifying anything.",
		],
		parameters: Type.Object({
			localDir: Type.String({ description: "Local directory path" }),
			driveId: Type.Optional(Type.String({ description: "Target drive ID" })),
			folderId: Type.Optional(Type.String({ description: "Target folder item ID" })),
			folderUrl: Type.Optional(Type.String({ description: "SharePoint sharing link to the target folder" })),
			direction: Type.Optional(Type.String({ description: "Sync direction: 'upload' (default), 'download', or 'both'" })),
			pattern: Type.Optional(Type.String({ description: "Glob pattern to filter files (e.g. '*.md', '*.vtt')" })),
			dryRun: Type.Optional(Type.String({ description: "Set to 'true' to preview changes without syncing" })),
			confirm: Type.Optional(Type.String({ description: "Set to 'true' to confirm sync changes when dryRun is false" })),
		}),
		async execute(_id, params): Promise<any> {
			const localDir = path.resolve(params.localDir);
			if (!fs.existsSync(localDir)) throw new Error(`Local directory not found: ${localDir}`);
			if (!fs.statSync(localDir).isDirectory()) throw new Error(`Not a directory: ${localDir}`);

			const direction = (params.direction ?? "upload").toLowerCase();
			const dryRun = getDryRun(params);
			const pattern = params.pattern ? compileM365SyncPattern(params.pattern) : null;

			let driveId = params.driveId;
			let folderId = params.folderId;

			if (params.folderUrl && (!driveId || !folderId)) {
				const b64 = Buffer.from(params.folderUrl).toString("base64").replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
				const resolved: any = await graphFetch(`shares/u!${b64}/driveItem?$select=id,name,parentReference,folder`);
				driveId = resolved.parentReference?.driveId;
				folderId = resolved.id;
			}

			if (!driveId || !folderId) throw new Error("Provide either (driveId + folderId) or folderUrl");
			if (!dryRun) requireConfirmed(`Running SharePoint/OneDrive sync (${direction})`, params);

			// Get remote file list
			const remoteItems: any[] = [];
			let nextUrl: string | null = `drives/${driveId}/items/${folderId}/children?$select=id,name,size,lastModifiedDateTime,file&$top=200`;
			while (nextUrl) {
				const resp: any = await graphFetch(nextUrl);
				remoteItems.push(...(resp.value ?? []));
				nextUrl = resp["@odata.nextLink"] ?? null;
			}
			const remoteByName = new Map(remoteItems.filter((i: any) => i.file).map((i: any) => [i.name, i]));

			// Get local file list
			const localFiles = fs.readdirSync(localDir)
				.filter((f) => fs.statSync(path.join(localDir, f)).isFile())
				.filter((f) => !pattern || pattern.test(f));

			const actions: string[] = [];
			const conflicts: string[] = [];
			let uploaded = 0, downloaded = 0, skipped = 0, conflictCount = 0;

			// Compare and sync
			if (direction === "upload" || direction === "both") {
				for (const localName of localFiles) {
					const localPath2 = path.join(localDir, localName);
					const localStat = fs.statSync(localPath2);
					const remote = remoteByName.get(localName);

					if (remote) {
						const remoteModified = new Date(remote.lastModifiedDateTime).getTime();
						const localModified = localStat.mtimeMs;

						// Identical — skip
						if (remote.size === localStat.size && Math.abs(remoteModified - localModified) < 2000) {
							skipped++;
							continue;
						}

						// Conflict: both sides changed (remote is newer AND local is different size)
						if (direction === "both" && remoteModified > localModified && remote.size !== localStat.size) {
							conflictCount++;
							conflicts.push(`⚠️ CONFLICT: ${localName} — local: ${Math.round(localStat.size / 1024)} KB @ ${new Date(localModified).toISOString().slice(0, 16)}, remote: ${Math.round(remote.size / 1024)} KB @ ${new Date(remoteModified).toISOString().slice(0, 16)}`);
							continue; // Skip — don't overwrite either side
						}
					}

					actions.push(`⬆️ ${localName} (${Math.round(localStat.size / 1024)} KB)${remote ? " — updated" : " — new"}`);
					if (!dryRun) {
						const buffer = fs.readFileSync(localPath2);
						const MAX_SIMPLE = 4 * 1024 * 1024;
						if (buffer.length <= MAX_SIMPLE) {
							await graphFetch(`drives/${driveId}/items/${folderId}:/${encodeURIComponent(localName)}:/content`, {
								method: "PUT", rawBody: buffer as any, headers: { "Content-Type": "application/octet-stream" },
							});
						} else {
							const session: any = await graphFetch(`drives/${driveId}/items/${folderId}:/${encodeURIComponent(localName)}:/createUploadSession`, {
								method: "POST", body: { item: { "@microsoft.graph.conflictBehavior": "replace", name: localName } },
							});
							const CHUNK_SIZE = 3_932_160;
							let offset = 0;
							while (offset < buffer.length) {
								const end = Math.min(offset + CHUNK_SIZE, buffer.length);
								const chunk = buffer.subarray(offset, end);
								const resp = await edgeFetch(session.uploadUrl, {
									method: "PUT",
									headers: { "Content-Length": String(chunk.length), "Content-Range": `bytes ${offset}-${end - 1}/${buffer.length}` },
									body: chunk, signal: AbortSignal.timeout(120_000),
								});
								if (!resp.ok) throw new Error(`Upload chunk failed for ${localName}: ${resp.status}`);
								await resp.json();
								offset = end;
							}
						}
						uploaded++;
					}
				}
			}

			if (direction === "download" || direction === "both") {
				for (const [remoteName, remoteItem] of remoteByName) {
					if (pattern && !pattern.test(remoteName)) continue;
					const localPath2 = path.join(localDir, remoteName);

					if (fs.existsSync(localPath2)) {
						const localStat = fs.statSync(localPath2);
						const remoteModified = new Date(remoteItem.lastModifiedDateTime).getTime();
						const localModified = localStat.mtimeMs;

						// Identical — skip
						if (remoteItem.size === localStat.size && Math.abs(remoteModified - localModified) < 2000) {
							if (direction === "download") skipped++;
							continue;
						}

						// Conflict: local is newer AND different size (in bidirectional mode)
						if (direction === "both" && localModified > remoteModified && remoteItem.size !== localStat.size) {
							// Already caught in the upload pass — skip silently
							continue;
						}
					}

					actions.push(`⬇️ ${remoteName} (${Math.round(remoteItem.size / 1024)} KB)${fs.existsSync(localPath2) ? " — updated" : " — new"}`);
					if (!dryRun) {
						await downloadDriveItem(driveId!, remoteItem.id, localPath2);
						// Set mtime to match remote
						const remoteMtime = new Date(remoteItem.lastModifiedDateTime);
						fs.utimesSync(localPath2, remoteMtime, remoteMtime);
						downloaded++;
					}
				}
			}

			const modeLabel = dryRun ? "DRY RUN" : "SYNC";
			const summary = [
				`## ${modeLabel}: ${path.basename(localDir)} ↔ SharePoint`,
				``,
				`**Direction:** ${direction} | **Local files:** ${localFiles.length} | **Remote files:** ${remoteByName.size}`,
				``,
				conflicts.length > 0 ? `### Conflicts (${conflicts.length} — not synced, resolve manually)\n${conflicts.join("\n")}` : "",
				``,
				actions.length > 0 ? actions.join("\n") : "✅ Everything in sync — no changes needed.",
				``,
				!dryRun ? `**Result:** ${uploaded} uploaded, ${downloaded} downloaded, ${skipped} skipped${conflictCount > 0 ? `, ${conflictCount} conflicts` : ""}` : `**Preview:** ${actions.length} changes would be made${conflictCount > 0 ? `, ${conflictCount} conflicts` : ""}`,
			].filter(Boolean).join("\n");

			return {
				content: [{ type: "text", text: summary }],
				details: { uploaded, downloaded, skipped, conflicts: conflictCount, actions: actions.length, dryRun, direction },
			};
		},
	});

	// ═══════════════════════════════════════════════════════════════════════
	// TEAMS MEETING RECORDING + TRANSCRIPT TOOL
	// ═══════════════════════════════════════════════════════════════════════

	// ═══════════════════════════════════════════════════════════════════════
	// CALENDAR TOOLS
	// ═══════════════════════════════════════════════════════════════════════

	pi.registerTool({
		name: "m365_calendar",
		label: "M365 Calendar",
		description:
			"Manage Outlook calendar events: list, create, update, delete, RSVP, and find availability. " +
			"All date/times use ISO 8601 format. Timezone is auto-detected from mailbox settings.",
		promptSnippet: "Manage Outlook calendar events (list/create/update/delete/rsvp/availability)",
		promptGuidelines: [
			"action=list: date (YYYY-MM-DD) required. Returns events for that day.",
			"action=create: subject, startDateTime, endDateTime required. attendees is a semicolon-separated list of emails.",
			"action=update: eventId required plus any fields to change.",
			"action=delete: eventId required. Always confirm with user first.",
			"action=rsvp: eventId and response (accept/tentative/decline) required.",
			"action=availability: attendees and startDateTime/endDateTime required. Uses Graph findMeetingTimes API.",
			"For recurring events, use seriesMasterId for the series or eventId for a single instance.",
			"isOnlineMeeting=true adds a Teams meeting link automatically.",
		],
		parameters: Type.Object({
			action: Type.String({ description: "Action: list | create | update | delete | rsvp | availability" }),
			// list
			date: Type.Optional(Type.String({ description: "Date YYYY-MM-DD for list action" })),
			days: Type.Optional(Type.Number({ description: "Number of days to list (default 1)" })),
			// create / update
			eventId: Type.Optional(Type.String({ description: "Event ID (for update/delete/rsvp)" })),
			subject: Type.Optional(Type.String({ description: "Event subject" })),
			startDateTime: Type.Optional(Type.String({ description: "Start: ISO datetime or YYYY-MM-DDTHH:MM:SS" })),
			endDateTime: Type.Optional(Type.String({ description: "End: ISO datetime or YYYY-MM-DDTHH:MM:SS" })),
			location: Type.Optional(Type.String({ description: "Location display name" })),
			body: Type.Optional(Type.String({ description: "Event body (HTML or plain text)" })),
			attendees: Type.Optional(Type.String({ description: "Semicolon-separated attendee emails" })),
			isOnlineMeeting: Type.Optional(Type.String({ description: "'true' to create Teams meeting link" })),
			isAllDay: Type.Optional(Type.String({ description: "'true' for all-day event" })),
			recurrence: Type.Optional(Type.String({ description: "JSON recurrence pattern (Graph format)" })),
			// rsvp
			response: Type.Optional(Type.String({ description: "RSVP: accept | tentative | decline" })),
			comment: Type.Optional(Type.String({ description: "Optional RSVP comment" })),
			// availability / safety
			meetingDuration: Type.Optional(Type.String({ description: "ISO 8601 duration for availability (default PT1H)" })),
			dryRun: Type.Optional(Type.String({ description: "Set to 'true' to preview write actions without changing anything" })),
			confirm: Type.Optional(Type.String({ description: "Set to 'true' to confirm create/update/delete/rsvp actions" })),
		}),
		async execute(_id, params): Promise<any> {
			const action = (params.action ?? "").toLowerCase().trim();
			const dryRun = getDryRun(params);

			// ── Resolve timezone once ──
			const tzData: any = await graphFetch("me/mailboxSettings?$select=timeZone").catch(() => null);
			const tz = tzData?.timeZone || "UTC";

			// ── LIST ──
			if (action === "list") {
				const date = params.date || new Date().toISOString().slice(0, 10);
				const numDays = params.days ?? 1;
				const startDT = `${date}T00:00:00`;
				const endDate = new Date(new Date(date).getTime() + numDays * 86400000).toISOString().slice(0, 10);
				const endDT = `${endDate}T00:00:00`;
				const data: any = await graphFetch(
					`me/calendarView?startDateTime=${encodeURIComponent(startDT)}&endDateTime=${encodeURIComponent(endDT)}` +
					`&$select=id,subject,start,end,showAs,categories,location,isAllDay,attendees,onlineMeeting,recurrence,organizer,bodyPreview` +
					`&$orderby=start/dateTime&$top=100`,
					{ headers: { Prefer: `outlook.timezone="${tz}"` } },
				);
				const events = (data?.value ?? []).map((e: any) => ({
					id: e.id,
					subject: e.subject,
					start: e.start?.dateTime,
					end: e.end?.dateTime,
					showAs: e.showAs,
					location: e.location?.displayName || "",
					isAllDay: e.isAllDay,
					attendees: (e.attendees ?? []).map((a: any) => ({
						name: a.emailAddress?.name,
						email: a.emailAddress?.address,
						status: a.status?.response,
					})),
					organizer: e.organizer?.emailAddress?.name,
					teamsLink: e.onlineMeeting?.joinUrl || null,
					bodyPreview: (e.bodyPreview ?? "").substring(0, 200),
					categories: e.categories,
				}));
				return {
					content: [{ type: "text", text: truncate(JSON.stringify(events, null, 2)) }],
					details: { action: "list", date, days: numDays, count: events.length, tz },
				};
			}

			// ── CREATE ──
			if (action === "create") {
				if (!params.subject) throw new Error("subject is required for create");
				if (!params.startDateTime) throw new Error("startDateTime is required for create");
				if (!params.endDateTime) throw new Error("endDateTime is required for create");

				const event: any = {
					subject: params.subject,
					start: { dateTime: params.startDateTime, timeZone: tz },
					end: { dateTime: params.endDateTime, timeZone: tz },
				};
				if (params.location) event.location = { displayName: params.location };
				if (params.body) event.body = { contentType: "HTML", content: params.body };
				if (params.isAllDay === "true") event.isAllDay = true;
				if (params.isOnlineMeeting === "true") {
					event.isOnlineMeeting = true;
					event.onlineMeetingProvider = "teamsForBusiness";
				}
				if (params.attendees) {
					event.attendees = params.attendees.split(";").map((e: string) => e.trim()).filter(Boolean).map((email: string) => ({
						emailAddress: { address: email },
						type: "required",
					}));
				}
				if (params.recurrence) {
					try {
						event.recurrence = JSON.parse(params.recurrence);
					} catch (error) {
						logSuppressedM365Index("Failed to parse calendar recurrence JSON for event creation; sending the event without recurrence.", error, {
							recurrence: params.recurrence,
						});
					}
				}

				if (dryRun) {
					return {
						content: [{ type: "text", text: truncate(JSON.stringify({ action: "create", dryRun: true, event }, null, 2)) }],
						details: { action: "create", dryRun: true, subject: event.subject, attendeeCount: event.attendees?.length ?? 0 },
					};
				}
				requireConfirmed("Creating a calendar event", params);
				const created: any = await graphFetch("me/events", { method: "POST", body: event });
				return {
					content: [{ type: "text", text: `Created: **${created.subject}** (${created.start?.dateTime} → ${created.end?.dateTime})${created.onlineMeeting?.joinUrl ? `\nTeams: ${created.onlineMeeting.joinUrl}` : ""}` }],
					details: {
						action: "create",
						eventId: created.id,
						subject: created.subject,
						start: created.start?.dateTime,
						end: created.end?.dateTime,
						teamsLink: created.onlineMeeting?.joinUrl || null,
						attendeeCount: event.attendees?.length ?? 0,
					},
				};
			}

			// ── UPDATE ──
			if (action === "update") {
				if (!params.eventId) throw new Error("eventId is required for update");
				const patch: any = {};
				if (params.subject) patch.subject = params.subject;
				if (params.startDateTime) patch.start = { dateTime: params.startDateTime, timeZone: tz };
				if (params.endDateTime) patch.end = { dateTime: params.endDateTime, timeZone: tz };
				if (params.location) patch.location = { displayName: params.location };
				if (params.body) patch.body = { contentType: "HTML", content: params.body };
				if (params.isAllDay === "true") patch.isAllDay = true;
				if (params.isAllDay === "false") patch.isAllDay = false;
				if (params.isOnlineMeeting === "true") {
					patch.isOnlineMeeting = true;
					patch.onlineMeetingProvider = "teamsForBusiness";
				}
				if (params.attendees) {
					patch.attendees = params.attendees.split(";").map((e: string) => e.trim()).filter(Boolean).map((email: string) => ({
						emailAddress: { address: email },
						type: "required",
					}));
				}
				if (params.recurrence) {
					try {
						patch.recurrence = JSON.parse(params.recurrence);
					} catch (error) {
						logSuppressedM365Index("Failed to parse calendar recurrence JSON for event updates; sending the patch without recurrence.", error, {
							recurrence: params.recurrence,
							eventId: params.eventId,
						});
					}
				}

				if (dryRun) {
					return {
						content: [{ type: "text", text: truncate(JSON.stringify({ action: "update", dryRun: true, eventId: params.eventId, patch }, null, 2)) }],
						details: { action: "update", dryRun: true, eventId: params.eventId, patched: Object.keys(patch) },
					};
				}
				requireConfirmed("Updating a calendar event", params);
				const updated: any = await graphFetch(`me/events/${params.eventId}`, { method: "PATCH", body: patch });
				return {
					content: [{ type: "text", text: `Updated: **${updated.subject}** (${updated.start?.dateTime} → ${updated.end?.dateTime})` }],
					details: { action: "update", eventId: params.eventId, patched: Object.keys(patch) },
				};
			}

			// ── DELETE ──
			if (action === "delete") {
				if (!params.eventId) throw new Error("eventId is required for delete");
				if (dryRun) {
					return {
						content: [{ type: "text", text: `Dry run: would delete event ${params.eventId}` }],
						details: { action: "delete", dryRun: true, eventId: params.eventId },
					};
				}
				requireConfirmed("Deleting a calendar event", params);
				await graphFetch(`me/events/${params.eventId}`, { method: "DELETE" });
				return {
					content: [{ type: "text", text: `Deleted event ${params.eventId}` }],
					details: { action: "delete", eventId: params.eventId },
				};
			}

			// ── RSVP ──
			if (action === "rsvp") {
				if (!params.eventId) throw new Error("eventId is required for rsvp");
				const resp = (params.response ?? "").toLowerCase().trim();
				if (!resp || !["accept", "tentative", "tentativelyaccept", "decline"].includes(resp)) {
					throw new Error("response must be: accept | tentative | decline");
				}
				const action_name = resp === "tentative" ? "tentativelyAccept" : resp === "tentativelyaccept" ? "tentativelyAccept" : resp;
				const body: any = {};
				if (params.comment) body.comment = params.comment;
				if (dryRun) {
					return {
						content: [{ type: "text", text: truncate(JSON.stringify({ action: "rsvp", dryRun: true, eventId: params.eventId, response: resp, body }, null, 2)) }],
						details: { action: "rsvp", dryRun: true, eventId: params.eventId, response: resp },
					};
				}
				requireConfirmed(`Sending calendar RSVP (${resp})`, params);
				await graphFetch(`me/events/${params.eventId}/${action_name}`, { method: "POST", body });
				return {
					content: [{ type: "text", text: `RSVP: ${resp} for event ${params.eventId}` }],
					details: { action: "rsvp", eventId: params.eventId, response: resp },
				};
			}

			// ── AVAILABILITY ──
			if (action === "availability") {
				if (!params.attendees) throw new Error("attendees is required for availability");
				if (!params.startDateTime) throw new Error("startDateTime is required for availability");
				if (!params.endDateTime) throw new Error("endDateTime is required for availability");

				const attendeeList = params.attendees.split(";").map((e: string) => e.trim()).filter(Boolean);
				const body = {
					attendees: attendeeList.map((email: string) => ({
						type: "required",
						emailAddress: { address: email },
					})),
					timeConstraint: {
						timeslots: [{
							start: { dateTime: params.startDateTime, timeZone: tz },
							end: { dateTime: params.endDateTime, timeZone: tz },
						}],
					},
					meetingDuration: params.meetingDuration || "PT1H",
					returnSuggestionReasons: true,
					minimumAttendeePercentage: 100,
				};

				const result: any = await graphFetch("me/findMeetingTimes", { method: "POST", body });
				const suggestions = (result?.meetingTimeSuggestions ?? []).map((s: any) => ({
					start: s.meetingTimeSlot?.start?.dateTime,
					end: s.meetingTimeSlot?.end?.dateTime,
					confidence: s.confidence,
					organizer: s.organizerAvailability,
					attendees: (s.attendeeAvailability ?? []).map((a: any) => ({
						email: a.attendee?.emailAddress?.address,
						availability: a.availability,
					})),
					reason: s.suggestionReason,
				}));

				return {
					content: [{ type: "text", text: truncate(JSON.stringify(suggestions, null, 2)) }],
					details: {
						action: "availability",
						suggestionsCount: suggestions.length,
						emptySuggestionsReason: result?.emptySuggestionsReason || null,
					},
				};
			}

			throw new Error(`Unknown action: ${action}. Use: list | create | update | delete | rsvp | availability`);
		},
	});




	// ── Calendar Day SVG (inline renderer) ──────────────────────────
	pi.registerTool({
		name: "m365_calendar_svg",
		label: "M365 Calendar Day SVG",
		description:
			"Render an Outlook-style day timeline SVG from Microsoft Graph calendar events. " +
			"Returns an SVG file showing events as colored blocks on a timeline.",
		promptSnippet: "Generate a visual calendar day view as SVG",
		promptGuidelines: [
			"Pass date in YYYY-MM-DD format for a specific day (default: today).",
			"Use startHour/endHour to show only a portion of the day (e.g. morning: 8-14).",
			"Set showFree=false to hide free/following events.",
			"Output SVG is written to outPath and should be attached via attach_file.",
		],
		parameters: Type.Object({
			date: Type.Optional(Type.String({ description: "Date in YYYY-MM-DD format (default: today)" })),
			startHour: Type.Optional(Type.Number({ description: "Start hour 0-23 (default: 8)" })),
			endHour: Type.Optional(Type.Number({ description: "End hour 1-24 (default: 21)" })),
			showFree: Type.Optional(Type.String({ description: "Show free events: true/false (default: true)" })),
			outPath: Type.Optional(Type.String({ description: "Output SVG file path" })),
		}),
		async execute(_id, params): Promise<any> {
			const date = params.date || new Date().toISOString().slice(0, 10);
			if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date must be YYYY-MM-DD");
			const startHour = params.startHour ?? 8;
			const endHour = params.endHour ?? 21;
			if (startHour < 0 || startHour > 23 || endHour < 1 || endHour > 24 || startHour >= endHour)
				throw new Error("Invalid hour window");
			const showFree = (params.showFree ?? "true").toLowerCase() !== "false";
			const outPath = params.outPath || path.join(process.cwd(), `calendar-${date}.svg`);

			// ── Fetch data via extension's graphFetch ──
			const tzData: any = await graphFetch("me/mailboxSettings?$select=timeZone").catch(() => null);
			const tz = tzData?.timeZone || "GMT Standard Time";

			const startDT = `${date}T00:00:00`;
			const endDT = `${date}T23:59:59`;
			const eventsData: any = await graphFetch(
				`me/calendarView?startDateTime=${encodeURIComponent(startDT)}&endDateTime=${encodeURIComponent(endDT)}` +
				`&$select=id,subject,start,end,showAs,categories,location,isAllDay&$orderby=start/dateTime&$top=200`,
				{ headers: { Prefer: `outlook.timezone="${tz}"` } },
			);
			const events: any[] = eventsData?.value ?? [];

			let catColors = new Map<string, string>();
			try {
				const catData: any = await graphFetch("me/outlook/masterCategories?$select=displayName,color");
				const presetHex: Record<string, string> = {
					preset0:"#e74856",preset1:"#ff8c00",preset2:"#ffb900",preset3:"#107c10",preset4:"#00b294",
					preset5:"#00bcf2",preset6:"#0078d4",preset7:"#2b88d8",preset8:"#8764b8",preset9:"#b146c2",
					preset10:"#e3008c",preset11:"#c239b3",preset12:"#9a0089",preset13:"#881798",preset14:"#744da9",
					preset15:"#4864a8",preset16:"#3a96dd",preset17:"#1a9b9b",preset18:"#38a169",preset19:"#8c8c8c",
					preset20:"#69797e",preset21:"#647687",preset22:"#8764b8",preset23:"#ca5010",preset24:"#c19c00",
				};
				for (const c of (catData?.value ?? [])) {
					if (c?.displayName && c?.color && presetHex[c.color]) catColors.set(c.displayName, presetHex[c.color]);
				}
			} catch (error) {
				logSuppressedM365Index("Failed to load Outlook category colors; rendering the calendar SVG without category color accents.", error, {
					date,
					outPath,
				});
			}

			// ── Parse events into rows ──
			type ShowAs = "oof"|"busy"|"tentative"|"free"|"workingElsewhere"|"unknown";
			interface Row { subject: string; showAs: ShowAs; categories: string[]; location: string; startMin: number; endMin: number; }
			const wStart = startHour * 60, wEnd = endHour * 60;
			const parseMin = (dt: string) => { const t = (dt.split("T")[1] ?? "00:00"); return (Number(t.slice(0,2))||0)*60 + (Number(t.slice(3,5))||0); };
			const rows: Row[] = [];
			for (const e of events) {
				const sa = (e.showAs ?? "unknown") as ShowAs;
				if (!showFree && sa === "free") continue;
				let s = parseMin(e.start.dateTime), en = parseMin(e.end.dateTime);
				if (en <= s) en = s + 15;
				if (en <= wStart || s >= wEnd) continue;
				rows.push({ subject: e.subject||"(no subject)", showAs: sa, categories: e.categories??[], location: e.location?.displayName||"", startMin: Math.max(s, wStart), endMin: Math.min(en, wEnd) });
			}
			rows.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);

			// ── Assign overlap columns ──
			const colEnds: number[] = [];
			const mapped: Array<{ row: Row; col: number }> = [];
			for (const row of rows) {
				let col = colEnds.findIndex(e => e <= row.startMin);
				if (col < 0) { col = colEnds.length; colEnds.push(row.endMin); } else { colEnds[col] = row.endMin; }
				mapped.push({ row, col });
			}
			const maxCols = Math.max(1, colEnds.length);

			// ── Render SVG ──
			const esc = (s: string) => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
			const hhmm = (m: number) => `${String(Math.floor(m/60)).padStart(2,"0")}:${String(m%60).padStart(2,"0")}`;
			const colorFor = (sa: ShowAs) => ({ oof:{s:"#b42318",f:"#fef3f2"}, busy:{s:"#175cd3",f:"#eff8ff"}, tentative:{s:"#b54708",f:"#fff7ed"}, free:{s:"#667085",f:"#f8fafc"}, workingElsewhere:{s:"#7a5af8",f:"#f4f3ff"}, unknown:{s:"#475467",f:"#f8fafc"} }[sa]);
			const withAlpha = (hex: string, a=0.14) => { const c=hex.replace("#",""); return `rgba(${parseInt(c.slice(0,2),16)},${parseInt(c.slice(2,4),16)},${parseInt(c.slice(4,6),16)},${a})`; };
			const maxCharsF = (wpx: number, fpx=10) => Math.max(8, Math.floor(wpx/(fpx*0.56)));

			const W = 1280, pxH = 80, mL = 90, mT = 90, mR = 24, mB = 40;
			const gW = W-mL-mR, gH = (endHour-startHour)*pxH, svgH = mT+gH+mB;
			const ppm = gH/((wEnd-wStart)||1), colW = gW/maxCols;

			const o: string[] = [];
			o.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${svgH}" viewBox="0 0 ${W} ${svgH}">`);
			o.push(`<rect width="${W}" height="${svgH}" fill="#f8fafc"/>`);
			o.push(`<text x="20" y="36" font-family="Segoe UI,Arial" font-size="26" font-weight="700" fill="#0f172a">Calendar — ${esc(date)}</text>`);
			o.push(`<text x="20" y="58" font-family="Segoe UI,Arial" font-size="13" fill="#475467">${esc(tz)} · ${String(startHour).padStart(2,"0")}:00–${String(endHour).padStart(2,"0")}:00 · ${rows.length} events</text>`);

			// Hour grid
			for (let h = startHour; h <= endHour; h++) {
				const y = mT + (h*60-wStart)*ppm;
				o.push(`<line x1="${mL}" y1="${y.toFixed(1)}" x2="${mL+gW}" y2="${y.toFixed(1)}" stroke="#d0d5dd"/>`);
				if (h < endHour) o.push(`<text x="14" y="${(y+12).toFixed(1)}" font-family="Segoe UI,Arial" font-size="12" fill="#344054">${String(h).padStart(2,"0")}:00</text>`);
			}
			for (let c = 1; c < maxCols; c++) {
				const cx = mL + c*colW;
				o.push(`<line x1="${cx.toFixed(1)}" y1="${mT}" x2="${cx.toFixed(1)}" y2="${mT+gH}" stroke="#e4e7ec"/>`);
			}

			// Event blocks
			for (const { row, col } of mapped) {
				const x = mL + col*colW + 2, y = mT + (row.startMin-wStart)*ppm + 1;
				const hp = Math.max(16, (row.endMin-row.startMin)*ppm - 2), wp = colW - 4;
				const catHex = row.categories.map(c => catColors.get(c)).find(Boolean);
				const base = colorFor(row.showAs);
				const sk = catHex || base.s, fl = catHex ? withAlpha(catHex) : base.f;
				o.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${wp.toFixed(1)}" height="${hp.toFixed(1)}" rx="4" fill="${fl}" stroke="${sk}" stroke-width="1.2"/>`);
				o.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="3" height="${hp.toFixed(1)}" rx="1" fill="${sk}"/>`);
				if (hp < 22) {
					const txt = `${hhmm(row.startMin)} ${row.subject}`;
					o.push(`<text x="${(x+8).toFixed(1)}" y="${(y+hp/2+4).toFixed(1)}" font-family="Segoe UI,Arial" font-size="10" font-weight="600" fill="#101828">${esc(txt.slice(0, maxCharsF(wp-12)))}</text>`);
				} else {
					o.push(`<text x="${(x+10).toFixed(1)}" y="${(y+12).toFixed(1)}" font-family="Segoe UI,Arial" font-size="10" font-weight="700" fill="#101828">${esc(hhmm(row.startMin))}-${esc(hhmm(row.endMin))}</text>`);
					const tl = x+10, flY = y+24, lh = 11, mc = maxCharsF(wp-16);
					const ml = Math.max(1, Math.floor((hp-24-4)/lh));
					const words = row.subject.split(/\s+/), lines: string[] = [];
					let cur = "";
					for (const w of words) { if (!cur) { cur=w; } else if ((cur+" "+w).length<=mc) { cur+=" "+w; } else { lines.push(cur); cur=w; } }
					if (cur) lines.push(cur);
					if (row.location) lines.push(`📍 ${row.location}`);
					const cl = lines.slice(0, ml);
					if (lines.length > ml && cl.length) cl[cl.length-1] = cl[cl.length-1].slice(0,-1)+"…";
					o.push(`<text x="${tl.toFixed(1)}" y="${flY.toFixed(1)}" font-family="Segoe UI,Arial" font-size="10" fill="#101828">`);
					cl.forEach((l,i) => o.push(`<tspan x="${tl.toFixed(1)}" dy="${i?lh:0}">${esc(l)}</tspan>`));
					o.push(`</text>`);
				}
			}
			o.push(`</svg>`);
			const svg = o.join("\n");

			// Write output
			const dir = path.dirname(outPath);
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(outPath, svg, "utf8");

			return {
				content: [{ type: "text", text: `Calendar SVG: ${outPath} (${Math.round(svg.length/1024)} KB)\nDate: ${date} · ${tz} · ${String(startHour).padStart(2,"0")}:00–${String(endHour).padStart(2,"0")}:00 · ${rows.length} events · ${maxCols} column(s)` }],
			};
		},
	});

	// ── OneDrive/SharePoint file move/rename ───────────────────────────
	async function resolveSpoMoveTarget(target: {
		siteUrl?: string;
		filePath?: string;
		driveId?: string;
		itemId?: string;
	}) {
		let driveId = target.driveId;
		let itemId = target.itemId;
		let drivePath = "";
		let sourceRef = target.itemId ?? target.filePath ?? "";
		let currentName: string | null = null;

		if (!driveId || !itemId) {
			if (!target.siteUrl || !target.filePath) throw new Error("Provide siteUrl+filePath or driveId+itemId");
			const site = target.siteUrl.replace(/\/+$/, "");
			const fp = target.filePath.replace(/^\/+/, "");
			sourceRef = fp;
			const isPersonal = site.includes("-my.sharepoint.com/personal/");
			if (isPersonal) {
				drivePath = "me/drive";
			} else {
				const siteInfo: any = await graphFetch(`sites/${new URL(site).hostname}:${new URL(site).pathname}?$select=id`);
				const driveInfo: any = await graphFetch(`sites/${siteInfo.id}/drive?$select=id`);
				drivePath = `drives/${driveInfo.id}`;
			}
			const item: any = await graphFetch(`${drivePath}/root:/${fp}?$select=id,name,parentReference`);
			driveId = item.parentReference?.driveId;
			itemId = item.id;
			currentName = item.name ?? null;
		}
		if (!driveId || !itemId) throw new Error("Could not resolve item");
		if (!currentName) {
			try {
				const item: any = await graphFetch(`drives/${driveId}/items/${itemId}?$select=id,name,parentReference`);
				currentName = item?.name ?? null;
			} catch (error) {
				logSuppressedM365Index("Failed to refresh the current SharePoint/OneDrive item name during move-target resolution.", error, {
					driveId,
					itemId,
					sourceRef,
				});
			}
		}
		return { driveId, itemId, drivePath: drivePath || `drives/${driveId}`, sourceRef, currentName };
	}

	async function moveSpoItem(target: {
		siteUrl?: string;
		filePath?: string;
		driveId?: string;
		itemId?: string;
		newName?: string;
		newParentPath?: string;
	}, options: { dryRun?: boolean } = {}) {
		if (!target.newName && !target.newParentPath) throw new Error("Provide newName, newParentPath, or both");
		const resolved = await resolveSpoMoveTarget(target);
		const body: any = {};
		if (target.newName) body.name = target.newName;
		if (target.newParentPath) {
			const parentPath = target.newParentPath.replace(/^\/+/, "").replace(/\/+$/, "");
			const folder: any = await graphFetch(`${resolved.drivePath}/root:/${parentPath}?$select=id,name,parentReference`);
			body.parentReference = { id: folder.id };
		}
		if (options.dryRun) {
			return {
				dryRun: true,
				source: resolved.sourceRef,
				driveId: resolved.driveId,
				itemId: resolved.itemId,
				currentName: resolved.currentName,
				newName: target.newName ?? resolved.currentName,
				newParentPath: target.newParentPath ?? null,
				body,
			};
		}
		const result: any = await graphFetch(`drives/${resolved.driveId}/items/${resolved.itemId}`, { method: "PATCH", body });
		const newPath = result.parentReference?.path?.replace(/.*root:/, "") || "";
		return {
			dryRun: false,
			source: resolved.sourceRef,
			driveId: resolved.driveId,
			itemId: result.id,
			name: result.name,
			newPath,
			webUrl: result.webUrl ?? null,
		};
	}

	pi.registerTool({
		name: "m365_spo_move",
		label: "M365 Move/Rename File",
		description:
			"Move or rename a file/folder on OneDrive or SharePoint. " +
			"Specify the item by siteUrl + filePath, or by driveId + itemId. " +
			"Set newName to rename, newParentPath to move, or both.",
		promptSnippet: "Move or rename a file on OneDrive/SharePoint",
		promptGuidelines: [
			"Use siteUrl + filePath for personal OneDrive or team sites.",
			"Use driveId + itemId if you already have them from m365_spo_browse or m365_document_link_metadata.",
			"Set newName to rename in place. Set newParentPath to move. Set both to move and rename.",
			"newParentPath is relative to the drive root (e.g. 'FY26/Practice Management').",
		],
		parameters: Type.Object({
			siteUrl: Type.Optional(Type.String({ description: "SharePoint/OneDrive site URL" })),
			filePath: Type.Optional(Type.String({ description: "File path relative to drive root" })),
			driveId: Type.Optional(Type.String({ description: "Drive ID (alternative to siteUrl)" })),
			itemId: Type.Optional(Type.String({ description: "Item ID (alternative to filePath)" })),
			newName: Type.Optional(Type.String({ description: "New filename (rename)" })),
			newParentPath: Type.Optional(Type.String({ description: "New parent folder path relative to drive root (move)" })),
			dryRun: Type.Optional(Type.String({ description: "Set to 'true' to preview without changing anything" })),
			confirm: Type.Optional(Type.String({ description: "Set to 'true' to confirm the move/rename" })),
		}),
		async execute(_id, params): Promise<any> {
			const dryRun = getDryRun(params);
			if (!dryRun) requireConfirmed("Moving or renaming a SharePoint/OneDrive item", params);
			const planned = await moveSpoItem(params, { dryRun });
			if (planned.dryRun) {
				return {
					content: [{ type: "text", text: truncate(JSON.stringify(planned, null, 2)) }],
					details: planned,
				};
			}
			return {
				content: [{ type: "text", text: `Moved/renamed: ${planned.name}\nNew location: ${planned.newPath}/${planned.name}\nID: ${planned.itemId}` }],
				details: planned,
			};
		},
	});

	pi.registerTool({
		name: "m365_spo_move_many",
		label: "M365 Move/Rename Many",
		description:
			"Move or rename multiple files/folders on OneDrive or SharePoint in one call. " +
			"Each item may be identified by siteUrl + filePath or driveId + itemId. Supports dry-run and continue-on-error.",
		promptSnippet: "Move or rename multiple files on OneDrive/SharePoint",
		promptGuidelines: [
			"Prefer dryRun='true' first for batch operations.",
			"Set top-level newParentPath when moving many items to the same destination.",
			"Each item can also override newName and newParentPath individually.",
		],
		parameters: Type.Object({
			items: Type.Array(Type.Object({
				siteUrl: Type.Optional(Type.String({ description: "SharePoint/OneDrive site URL" })),
				filePath: Type.Optional(Type.String({ description: "File path relative to drive root" })),
				driveId: Type.Optional(Type.String({ description: "Drive ID" })),
				itemId: Type.Optional(Type.String({ description: "Item ID" })),
				newName: Type.Optional(Type.String({ description: "New filename for this item" })),
				newParentPath: Type.Optional(Type.String({ description: "Destination folder path for this item" })),
			})),
			newParentPath: Type.Optional(Type.String({ description: "Default destination folder path applied to items that do not specify one" })),
			dryRun: Type.Optional(Type.String({ description: "Set to 'true' to preview without changing anything" })),
			continueOnError: Type.Optional(Type.String({ description: "Set to 'true' to continue processing after an item fails" })),
			confirm: Type.Optional(Type.String({ description: "Set to 'true' to confirm the batch move/rename" })),
		}),
		async execute(_id, params): Promise<any> {
			if (!params.items?.length) throw new Error("items must contain at least one entry");
			const dryRun = getDryRun(params);
			if (!dryRun) requireConfirmed("Batch moving or renaming SharePoint/OneDrive items", params);
			const continueOnError = params.continueOnError === "true";
			const results: any[] = [];
			let moved = 0;
			let failed = 0;
			for (let idx = 0; idx < params.items.length; idx++) {
				const item = params.items[idx] ?? {};
				const effective = {
					...item,
					newParentPath: item.newParentPath ?? params.newParentPath,
				};
				try {
					const result = await moveSpoItem(effective, { dryRun });
					results.push({ index: idx, ok: true, ...result });
					if (!dryRun) moved++;
				} catch (error: any) {
					failed++;
					results.push({
						index: idx,
						ok: false,
						source: item.itemId ?? item.filePath ?? "",
						error: String(error?.message ?? error ?? "Unknown error"),
					});
					if (!continueOnError) {
						return {
							content: [{ type: "text", text: truncate(JSON.stringify({ dryRun, moved, failed, stoppedAt: idx, results }, null, 2)) }],
							details: { dryRun, moved, failed, stoppedAt: idx, results },
						};
					}
				}
			}
			const summary = dryRun
				? `Dry run complete: ${results.length - failed}/${results.length} item(s) planned, ${failed} failed.`
				: `Batch move complete: ${moved}/${results.length} item(s) moved, ${failed} failed.`;
			return {
				content: [{ type: "text", text: `${summary}\n\n${truncate(JSON.stringify(results, null, 2))}` }],
				details: { dryRun, moved, failed, count: results.length, results },
			};
		},
	});

	// ── M365 TODO ──────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "m365_todo",
		label: "M365 To Do",
		description:
			"Read Microsoft To Do tasks and flagged emails surfaced as tasks. " +
			"action=list (default): returns open tasks from Tasks and Flagged Emails by default. " +
			"Read-only in v1.",
		promptSnippet: "To Do: list tasks and flagged emails from Microsoft To Do",
		promptGuidelines: [
			"action=list: returns normalized tasks from Microsoft To Do lists.",
			"sources=['tasks','flaggedEmails'] by default. Use 'allLists' to include all lists.",
			"includeCompleted=false by default. Set true to include completed items.",
			"search filters across title + body + linked resource display name.",
			"dueBefore / dueAfter accept ISO date strings.",
			"Flagged email tasks include linkedWebUrl pointing to the Outlook item.",
			"Partial list failures are recorded in details.errors and do not abort the tool.",
		],
		parameters: Type.Object({
			action: Type.Optional(Type.String({ description: "'list' (default and only v1 action)" })),
			sources: Type.Optional(Type.Array(Type.String(), { description: "Sources to query: 'tasks', 'flaggedEmails', 'allLists'. Default: ['tasks','flaggedEmails']" })),
			includeCompleted: Type.Optional(Type.Boolean({ description: "Include completed items (default false)" })),
			status: Type.Optional(Type.Array(Type.String(), { description: "Filter by status: notStarted, inProgress, completed, waitingOnOthers, deferred" })),
			top: Type.Optional(Type.Number({ description: "Max items to return (default 50, max 200)" })),
			search: Type.Optional(Type.String({ description: "Search term across title, body, linked resource name" })),
			dueBefore: Type.Optional(Type.String({ description: "Return only tasks due before this ISO date" })),
			dueAfter: Type.Optional(Type.String({ description: "Return only tasks due after this ISO date" })),
			listIds: Type.Optional(Type.Array(Type.String(), { description: "Explicit list IDs to query (overrides sources)" })),
		}),
		async execute(_id, params): Promise<any> {
			const top = Math.min(params.top ?? 50, 200);
			const includeCompleted = params.includeCompleted ?? false;
			const sources: string[] = params.sources ?? ["tasks", "flaggedEmails"];
			const searchTerm = (params.search ?? "").toLowerCase().trim();
			const statusFilter = params.status ? new Set(params.status.map((s: string) => s.toLowerCase())) : null;
			const dueBefore = params.dueBefore ? new Date(params.dueBefore) : null;
			const dueAfter = params.dueAfter ? new Date(params.dueAfter) : null;

			type NormalizedTask = {
				id: string;
				title: string;
				status: string;
				importance: string;
				source: "tasks" | "flaggedEmails" | "list";
				listId: string;
				listName: string;
				wellknownListName: string | null;
				createdDateTime: string | null;
				lastModifiedDateTime: string | null;
				dueDateTime: string | null;
				completedDateTime: string | null;
				hasAttachments: boolean;
				bodyText: string | null;
				linkedResourceCount: number;
				linkedWebUrl: string | null;
				linkedDisplayName: string | null;
			};

			// 1. Fetch all To Do lists
			const listsResult: any = await graphFetch("me/todo/lists?$top=100");
			const allLists: any[] = listsResult?.value ?? [];

			// 2. Determine which lists to query
			let targetLists: any[];
			if (params.listIds && params.listIds.length > 0) {
				const idSet = new Set(params.listIds);
				targetLists = allLists.filter((l: any) => idSet.has(l.id));
			} else if (sources.includes("allLists")) {
				targetLists = allLists;
			} else {
				const wantWellknown = new Set<string>();
				if (sources.includes("tasks")) wantWellknown.add("defaultList");
				if (sources.includes("flaggedEmails")) wantWellknown.add("flaggedEmails");
				targetLists = allLists.filter((l: any) => wantWellknown.has(l.wellknownListName ?? ""));
			}

			// 3. Fetch tasks list-by-list with partial failure tolerance
			const errors: { listId: string; listName: string; error: string }[] = [];
			const items: NormalizedTask[] = [];
			const listsQueried: { id: string; name: string; wellknown: string | null }[] = [];

			for (const list of targetLists) {
				const listId: string = list.id;
				const listName: string = list.displayName ?? listId;
				const wellknown: string | null = list.wellknownListName ?? null;
				const source: NormalizedTask["source"] =
					wellknown === "defaultList" ? "tasks"
					: wellknown === "flaggedEmails" ? "flaggedEmails"
					: "list";

				try {
					const select = "id,title,status,importance,body,createdDateTime,lastModifiedDateTime,dueDateTime,completedDateTime,hasAttachments,linkedResources";
					const encodedId = encodeURIComponent(listId);
					const tasksResult: any = await graphFetch(
						`me/todo/lists/${encodedId}/tasks?$select=${select}&$top=${top}`
					);
					const rawTasks: any[] = tasksResult?.value ?? [];

					for (const t of rawTasks) {
						const linkedResources: any[] = t.linkedResources ?? [];
						const firstLink = linkedResources[0] ?? null;
						const dueStr: string | null = t.dueDateTime?.dateTime ?? null;

						items.push({
							id: t.id,
							title: t.title ?? "",
							status: t.status ?? "notStarted",
							importance: t.importance ?? "normal",
							source,
							listId,
							listName,
							wellknownListName: wellknown,
							createdDateTime: t.createdDateTime ?? null,
							lastModifiedDateTime: t.lastModifiedDateTime ?? null,
							dueDateTime: dueStr,
							completedDateTime: t.completedDateTime?.dateTime ?? null,
							hasAttachments: t.hasAttachments ?? false,
							bodyText: t.body?.content ? t.body.content.replace(/<[^>]+>/g, "").trim().substring(0, 300) || null : null,
							linkedResourceCount: linkedResources.length,
							linkedWebUrl: firstLink?.webUrl ?? null,
							linkedDisplayName: firstLink?.displayName ?? null,
						});
					}
					listsQueried.push({ id: listId, name: listName, wellknown });
				} catch (error: unknown) {
					errors.push({
						listId,
						listName,
						error: String((error as any)?.message ?? error ?? "Unknown error"),
					});
				}
			}

			// 4. Filter
			let filtered = items.filter((t) => {
				if (!includeCompleted && t.status === "completed") return false;
				if (statusFilter && !statusFilter.has(t.status.toLowerCase())) return false;
				if (dueBefore && t.dueDateTime && new Date(t.dueDateTime) > dueBefore) return false;
				if (dueAfter && t.dueDateTime && new Date(t.dueDateTime) < dueAfter) return false;
				if (searchTerm) {
					const haystack = [
						t.title, t.bodyText ?? "", t.linkedDisplayName ?? "",
					].join(" ").toLowerCase();
					if (!haystack.includes(searchTerm)) return false;
				}
				return true;
			});

			// 5. Sort: incomplete first, then due ASC (undated last), importance high>normal>low, lastModified DESC
			const importanceOrder: Record<string, number> = { high: 0, normal: 1, low: 2 };
			filtered.sort((a, b) => {
				const aComplete = a.status === "completed" ? 1 : 0;
				const bComplete = b.status === "completed" ? 1 : 0;
				if (aComplete !== bComplete) return aComplete - bComplete;
				const aDue = a.dueDateTime ? new Date(a.dueDateTime).getTime() : Infinity;
				const bDue = b.dueDateTime ? new Date(b.dueDateTime).getTime() : Infinity;
				if (aDue !== bDue) return aDue - bDue;
				const aImp = importanceOrder[a.importance] ?? 1;
				const bImp = importanceOrder[b.importance] ?? 1;
				if (aImp !== bImp) return aImp - bImp;
				const aModified = a.lastModifiedDateTime ? new Date(a.lastModifiedDateTime).getTime() : 0;
				const bModified = b.lastModifiedDateTime ? new Date(b.lastModifiedDateTime).getTime() : 0;
				return bModified - aModified;
			});

			// 6. Build human-readable summary
			const openCount = filtered.filter(t => t.status !== "completed").length;
			const fromTasks = filtered.filter(t => t.source === "tasks").length;
			const fromFlagged = filtered.filter(t => t.source === "flaggedEmails").length;
			const fromOther = filtered.length - fromTasks - fromFlagged;

			const lines: string[] = [
				`To Do: ${openCount} open item${openCount !== 1 ? "s" : ""} ` +
				`(${fromTasks} task${fromTasks !== 1 ? "s" : ""}, ${fromFlagged} flagged email${fromFlagged !== 1 ? "s" : ""}` +
				(fromOther > 0 ? `, ${fromOther} from other lists` : "") + ")",
			];

			if (errors.length > 0) {
				lines.push(`Partial errors: ${errors.map(e => e.listName).join(", ")}`);
			}

			lines.push("");
			const preview = filtered.slice(0, Math.min(top, filtered.length));
			for (const t of preview) {
				const due = t.dueDateTime ? ` due:${t.dueDateTime.substring(0, 10)}` : "";
				const flag = t.importance === "high" ? " [!]" : "";
				const src = t.source === "flaggedEmails" ? " [email]" : t.source === "tasks" ? " [task]" : ` [${t.listName}]`;
				lines.push(`• ${t.title}${flag}${src}${due} (${t.status})`);
			}

			return {
				content: [{ type: "text", text: truncate(lines.join("\n")) }],
				details: {
					count: filtered.length,
					listsQueried,
					items: filtered.slice(0, top),
					...(errors.length > 0 ? { errors } : {}),
				},
			};
		},
	});
}

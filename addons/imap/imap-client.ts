/**
 * imap-client.ts — Minimal IMAP client using Bun's native TLS.
 *
 * Supports: LOGIN, LIST, SELECT, SEARCH, FETCH, STORE, COPY, MOVE,
 * APPEND, CREATE, DELETE, NOOP, LOGOUT.
 *
 * Zero external dependencies.
 */

import { connect, type Socket } from "node:net";
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from "node:tls";

export interface ImapConfig {
	host: string;
	port: number;
	tls: boolean;
	starttls?: boolean;
	user: string;
	pass: string;
	allowInsecureTls?: boolean;
}

export interface ImapEnvelope {
	uid: number;
	flags: string[];
	size: number;
	date: string | null;
	subject: string;
	from: string;
	to: string;
	cc: string;
	messageId: string | null;
	inReplyTo: string | null;
}

export interface ImapFolder {
	path: string;
	name: string;
	delimiter: string;
	flags: string[];
	specialUse: string | null;
}

interface PendingCommand {
	resolve: (lines: string[]) => void;
	reject: (err: Error) => void;
	lines: string[];
	literal: { remaining: number; chunks: Buffer[] } | null;
	continuationLiteral?: Buffer;
	continuationSent?: boolean;
}

export class ImapClient {
	private sock: Socket | TLSSocket | null = null;
	private tagCounter = 0;
	private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	private pending = new Map<string, PendingCommand>();
	private commandQueue: Promise<void> | null = null;
	private capabilities = new Set<string>();
	private selected: string | null = null;
	private greetingResolved = false;

	constructor(private config: ImapConfig) {}

	private async openSocket(useTls: boolean, existingSocket?: Socket): Promise<Socket | TLSSocket> {
		return await new Promise<Socket | TLSSocket>((resolve, reject) => {
			let settled = false;
			const timeout = setTimeout(() => {
				if (settled) return;
				settled = true;
				reject(new Error(`Timeout connecting to ${this.config.host}:${this.config.port}`));
			}, 15_000);

			const socket = useTls
				? tlsConnect({
						host: this.config.host,
						port: this.config.port,
						socket: existingSocket,
						rejectUnauthorized: !this.config.allowInsecureTls,
					} as ConnectionOptions)
				: existingSocket ?? connect({ host: this.config.host, port: this.config.port });

			const cleanup = () => {
				clearTimeout(timeout);
				socket.removeListener("error", onError);
				socket.removeListener(useTls ? "secureConnect" : "connect", onReady);
			};
			const onError = (err: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(err);
			};
			const onReady = () => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(socket);
			};

			socket.once("error", onError);
			if (existingSocket && !useTls) onReady();
			else socket.once(useTls ? "secureConnect" : "connect", onReady);
		});
	}

	private async awaitGreeting(): Promise<void> {
		if (!this.sock) throw new Error("Socket not connected");
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				cleanup();
				reject(new Error("Timeout waiting for IMAP greeting"));
			}, 15_000);

			const onError = (err: Error) => {
				cleanup();
				reject(err);
			};

			const onGreet = (chunk: Buffer) => {
				const text = chunk.toString("utf-8");
				const nlIdx = text.indexOf("\r\n");
				if (nlIdx === -1) return;
				const line = text.slice(0, nlIdx);
				const rest = text.slice(nlIdx + 2);
				if (!line.startsWith("* OK")) {
					cleanup();
					reject(new Error(`Unexpected greeting: ${line}`));
					return;
				}
				this.greetingResolved = true;
				this.captureCapabilitiesFromLine(line);
				this.buffer = rest ? Buffer.from(rest, "utf-8") : Buffer.alloc(0);
				cleanup();
				resolve();
			};

			const cleanup = () => {
				clearTimeout(timeout);
				this.sock?.removeListener("error", onError);
				this.sock?.removeListener("data", onGreet);
			};

			this.sock!.on("data", onGreet);
			this.sock!.once("error", onError);
		});
	}

	private bindSocketHandlers(): void {
		if (!this.sock) return;
		this.sock.removeAllListeners("data");
		this.sock.removeAllListeners("error");
		this.sock.removeAllListeners("close");
		this.sock.on("data", (chunk: Buffer) => this.feed(chunk));
		this.sock.on("error", (err: Error) => this.abortAll(err));
		this.sock.on("close", () => this.abortAll(new Error("Connection closed")));
		if (this.buffer.length > 0) {
			const rest = this.buffer;
			this.buffer = Buffer.alloc(0);
			this.feed(rest);
		}
	}

	private captureCapabilitiesFromLine(line: string): void {
		const capMatch = line.match(/\[CAPABILITY ([^\]]+)\]/i) ?? line.match(/^\* CAPABILITY\s+(.+)/i);
		if (!capMatch?.[1]) return;
		this.capabilities.clear();
		for (const capability of capMatch[1].split(/\s+/)) {
			if (capability) this.capabilities.add(capability.toUpperCase());
		}
	}

	private async refreshCapabilities(): Promise<void> {
		const resp = await this.command("CAPABILITY");
		for (const line of resp) {
			if (line.startsWith("* CAPABILITY ")) {
				this.captureCapabilitiesFromLine(line);
				return;
			}
		}
	}

	private async ensureStartTls(): Promise<void> {
		if (this.config.tls) return;
		if (!this.capabilities.has("STARTTLS")) {
			await this.refreshCapabilities();
		}
		if (!this.capabilities.has("STARTTLS")) {
			throw new Error("IMAP server does not advertise STARTTLS");
		}
		await this.command("STARTTLS");
		const plainSocket = this.sock as Socket;
		plainSocket.removeAllListeners();
		this.sock = await this.openSocket(true, plainSocket);
		this.bindSocketHandlers();
		await this.refreshCapabilities();
	}

	async connect(): Promise<void> {
		if (this.sock) return;

		this.sock = await this.openSocket(this.config.tls);
		await this.awaitGreeting();
		this.bindSocketHandlers();

		if (!this.config.tls && this.config.starttls) {
			await this.ensureStartTls();
		}
	}

	async login(): Promise<void> {
		const resp = await this.command(`LOGIN ${this.quote(this.config.user)} ${this.quote(this.config.pass)}`);
		const capLine = resp.find((line) => /CAPABILITY/i.test(line));
		if (capLine) {
			const capMatch = capLine.match(/CAPABILITY\s+(.+)/i);
			if (capMatch?.[1]) {
				this.capabilities.clear();
				for (const capability of capMatch[1].split(/\s+/)) {
					if (capability) this.capabilities.add(capability.toUpperCase());
				}
			}
		}
	}

	async logout(): Promise<void> {
		if (!this.sock) return;
		try {
			await this.command("LOGOUT");
		} catch {}
		this.sock.destroy();
		this.sock = null;
		this.selected = null;
	}

	async noop(): Promise<void> {
		await this.command("NOOP");
	}

	async list(): Promise<ImapFolder[]> {
		const resp = await this.command('LIST "" "*"');
		const folders: ImapFolder[] = [];
		for (const line of resp) {
			if (!line.startsWith("* LIST ")) continue;
			const parsed = parseListLine(line);
			if (!parsed) continue;
			folders.push(parsed);
		}
		return folders;
	}

	async select(mailbox: string): Promise<{ exists: number; recent: number }> {
		const resp = await this.command(`SELECT ${this.quote(mailbox)}`);
		this.selected = mailbox;
		let exists = 0;
		let recent = 0;
		for (const line of resp) {
			const existsMatch = line.match(/^\* (\d+) EXISTS/i);
			if (existsMatch?.[1]) exists = Number.parseInt(existsMatch[1], 10);
			const recentMatch = line.match(/^\* (\d+) RECENT/i);
			if (recentMatch?.[1]) recent = Number.parseInt(recentMatch[1], 10);
		}
		return { exists, recent };
	}

	async create(mailbox: string): Promise<void> {
		const resp = await this.command(`CREATE ${this.quote(mailbox)}`);
		this.assertOk(resp, "CREATE");
	}

	async delete(mailbox: string): Promise<void> {
		const resp = await this.command(`DELETE ${this.quote(mailbox)}`);
		this.assertOk(resp, "DELETE");
	}

	async search(criteria: string, uid = true): Promise<number[]> {
		const prefix = uid ? "UID SEARCH" : "SEARCH";
		const resp = await this.command(`${prefix} ${criteria}`);
		for (const line of resp) {
			const match = line.match(/^\* SEARCH(.*)$/i);
			if (!match) continue;
			return (match[1] ?? "")
				.trim()
				.split(/\s+/)
				.filter(Boolean)
				.map((value) => Number.parseInt(value, 10))
				.filter((value) => Number.isFinite(value) && value > 0);
		}
		return [];
	}

	async fetch(range: string, items: string, uid = true): Promise<Array<{ uid: number; raw: string }>> {
		const prefix = uid ? "UID FETCH" : "FETCH";
		const resp = await this.command(`${prefix} ${range} (${items})`);
		return this.parseFetchResponse(resp);
	}

	async store(range: string, action: string, flags: string[], uid = true): Promise<void> {
		const prefix = uid ? "UID STORE" : "STORE";
		await this.command(`${prefix} ${range} ${action} (${flags.join(" ")})`);
	}

	async copy(range: string, mailbox: string, uid = true): Promise<void> {
		const prefix = uid ? "UID COPY" : "COPY";
		await this.command(`${prefix} ${range} ${this.quote(mailbox)}`);
	}

	async move(range: string, mailbox: string, uid = true): Promise<void> {
		if (this.capabilities.has("MOVE")) {
			const prefix = uid ? "UID MOVE" : "MOVE";
			await this.command(`${prefix} ${range} ${this.quote(mailbox)}`);
			return;
		}

		await this.copy(range, mailbox, uid);
		await this.store(range, "+FLAGS.SILENT", ["\\Deleted"], uid);
		await this.command("EXPUNGE");
	}

	async append(mailbox: string, message: string | Buffer, flags: string[] = []): Promise<void> {
		const buf = typeof message === "string" ? Buffer.from(message, "utf-8") : message;
		const flagStr = flags.length > 0 ? ` (${flags.join(" ")})` : "";
		await this.command(`APPEND ${this.quote(mailbox)}${flagStr} {${buf.length}}`, { literal: buf });
	}

	async searchAndFetch(mailbox: string, criteria: string, limit: number): Promise<ImapEnvelope[]> {
		await this.select(mailbox);
		const uids = await this.search(criteria);
		if (uids.length === 0) return [];

		const selected = uids.slice(-limit).reverse();
		const raw = await this.fetch(selected.join(","), "UID FLAGS RFC822.SIZE ENVELOPE");
		return raw.map((entry) => this.parseEnvelopeLine(entry));
	}

	async fetchSource(mailbox: string, uid: number): Promise<string> {
		if (this.selected !== mailbox) await this.select(mailbox);
		const resp = await this.command(`UID FETCH ${uid} (BODY[])`);
		for (let i = 0; i < resp.length; i++) {
			const line = resp[i];
			if (line?.includes("BODY[]") && line.includes("{")) {
				const next = resp[i + 1];
				if (next !== undefined) return next;
			}
		}
		return resp.filter((line) => !line.startsWith("A") && line !== ")").join("\n");
	}

	private nextTag(): string {
		return `A${String(++this.tagCounter).padStart(4, "0")}`;
	}

	private quote(value: string): string {
		if (/^[A-Za-z0-9_./+-]+$/.test(value)) return value;
		return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	}

	private assertOk(resp: string[], cmd: string): void {
		const last = resp.at(-1) ?? "";
		if (!/\bOK\b/i.test(last)) throw new Error(`${cmd} failed: ${last}`);
	}

	private getFirstPending(): [string, PendingCommand] | undefined {
		const first = this.pending.entries().next();
		return first.done ? undefined : first.value;
	}

	private async command(cmd: string, options?: { literal?: Buffer }): Promise<string[]> {
		let release: () => void = () => {};
		const previous = this.commandQueue;
		const current = new Promise<void>((resolve) => { release = resolve; });
		this.commandQueue = current;
		if (previous) await previous.catch(() => {});
		try {
			return await this.runCommand(cmd, options);
		} finally {
			release();
			if (this.commandQueue === current) this.commandQueue = null;
		}
	}

	private async runCommand(cmd: string, options?: { literal?: Buffer }): Promise<string[]> {
		if (!this.sock) throw new Error("IMAP socket is not connected");

		const tag = this.nextTag();
		const line = `${tag} ${cmd}\r\n`;

		return await new Promise<string[]>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(tag);
				reject(new Error(`Timeout: ${cmd.split(" ")[0]}`));
			}, 30_000);

			this.pending.set(tag, {
				resolve: (lines) => {
					clearTimeout(timeout);
					resolve(lines);
				},
				reject: (err) => {
					clearTimeout(timeout);
					reject(err);
				},
				lines: [],
				literal: null,
				continuationLiteral: options?.literal,
				continuationSent: false,
			});

			this.sock!.write(line);
		});
	}

	private feed(chunk: Buffer): void {
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

		while (true) {
			const firstPending = this.getFirstPending()?.[1];
			if (firstPending?.literal) {
				const needed = firstPending.literal.remaining;
				if (this.buffer.length < needed) {
					firstPending.literal.chunks.push(this.buffer);
					firstPending.literal.remaining -= this.buffer.length;
					this.buffer = Buffer.alloc(0);
					return;
				}

				firstPending.literal.chunks.push(this.buffer.subarray(0, needed));
				this.buffer = this.buffer.subarray(needed);
				firstPending.lines.push(Buffer.concat(firstPending.literal.chunks).toString("utf-8"));
				firstPending.literal = null;
				continue;
			}

			const nlIdx = this.buffer.indexOf("\r\n");
			if (nlIdx === -1) return;

			const line = this.buffer.subarray(0, nlIdx).toString("utf-8");
			this.buffer = this.buffer.subarray(nlIdx + 2);

			if (line.startsWith("+")) {
				const pending = this.getFirstPending()?.[1];
				if (pending?.continuationLiteral && !pending.continuationSent) {
					pending.lines.push(line);
					pending.continuationSent = true;
					this.sock?.write(pending.continuationLiteral);
					this.sock?.write("\r\n");
					continue;
				}
			}

			const taggedMatch = line.match(/^(A\d+)\s+(OK|NO|BAD)\b/i);
			if (taggedMatch?.[1]) {
				const tag = taggedMatch[1];
				const pending = this.pending.get(tag);
				if (pending) {
					pending.lines.push(line);
					this.pending.delete(tag);
					if (/^(?:A\d+)\s+(NO|BAD)\b/i.test(line)) pending.reject(new Error(line));
					else pending.resolve(pending.lines);
					continue;
				}
			}

			const target = this.getFirstPending()?.[1];
			if (!target) continue;
			target.lines.push(line);

			const literalMatch = line.match(/\{(\d+)\}$/);
			if (literalMatch?.[1]) {
				target.literal = { remaining: Number.parseInt(literalMatch[1], 10), chunks: [] };
			}
		}
	}

	private parseFetchResponse(lines: string[]): Array<{ uid: number; raw: string }> {
		const results: Array<{ uid: number; raw: string }> = [];
		let currentLine: string | null = null;
		for (const line of lines) {
			if (!line.startsWith("* ")) continue;
			if (line.includes(" FETCH ")) {
				currentLine = line;
				const uidMatch = line.match(/UID\s+(\d+)/i);
				const uid = uidMatch?.[1] ? Number.parseInt(uidMatch[1], 10) : 0;
				results.push({ uid, raw: currentLine });
				continue;
			}
			if (currentLine && line !== ")") {
				results[results.length - 1]!.raw += `\n${line}`;
			}
		}
		return results;
	}

	private abortAll(err: Error): void {
		for (const [, pending] of this.pending) {
			pending.reject(err);
		}
		this.pending.clear();
		this.selected = null;
	}

	private parseEnvelopeLine(entry: { uid: number; raw: string }): ImapEnvelope {
		const line = entry.raw;
		const flags = this.extractParens(line, "FLAGS") ?? "";
		const size = Number.parseInt(line.match(/RFC822\.SIZE\s+(\d+)/)?.[1] ?? "0", 10);
		const envStart = line.indexOf("ENVELOPE (");
		const envelope = {
			date: null as string | null,
			subject: "(no subject)",
			from: "",
			to: "",
			cc: "",
			messageId: null as string | null,
			inReplyTo: null as string | null,
		};

		if (envStart >= 0) {
			const parts = this.parseEnvelopeParts(line.slice(envStart + 9));
			envelope.date = parts[0] ?? null;
			envelope.subject = parts[1] ?? "(no subject)";
			envelope.from = this.formatAddressList(parts[2] ?? "");
			envelope.to = this.formatAddressList(parts[5] ?? "");
			envelope.cc = this.formatAddressList(parts[6] ?? "");
			envelope.inReplyTo = parts[8] && parts[8] !== "NIL" ? parts[8] : null;
			envelope.messageId = parts[9] && parts[9] !== "NIL" ? parts[9] : null;
		}

		return {
			uid: entry.uid,
			flags: flags.replace(/[()]/g, "").split(" ").filter(Boolean),
			size: Number.isFinite(size) ? size : 0,
			...envelope,
		};
	}

	private extractParens(line: string, keyword: string): string | null {
		const idx = line.indexOf(`${keyword} (`);
		if (idx === -1) return null;
		const start = idx + keyword.length + 1;
		let depth = 0;
		for (let i = start; i < line.length; i++) {
			if (line[i] === "(") depth++;
			if (line[i] === ")") {
				depth--;
				if (depth === 0) return line.slice(start, i + 1);
			}
		}
		return null;
	}

	private parseEnvelopeParts(value: string): string[] {
		const parts: string[] = [];
		let i = value[0] === "(" ? 1 : 0;

		while (i < value.length) {
			if (value[i] === " ") {
				i++;
				continue;
			}
			if (value[i] === ")") break;

			if (value[i] === '"') {
				i++;
				let parsed = "";
				while (i < value.length && value[i] !== '"') {
					if (value[i] === "\\" && i + 1 < value.length) {
						parsed += value[i + 1];
						i += 2;
					} else {
						parsed += value[i];
						i++;
					}
				}
				i++;
				parts.push(parsed);
				continue;
			}

			if (value.slice(i, i + 3) === "NIL") {
				parts.push("NIL");
				i += 3;
				continue;
			}

			if (value[i] === "(") {
				let depth = 0;
				const start = i;
				while (i < value.length) {
					if (value[i] === "(") depth++;
					if (value[i] === ")") {
						depth--;
						if (depth === 0) {
							i++;
							break;
						}
					}
					i++;
				}
				parts.push(value.slice(start, i));
				continue;
			}

			let atom = "";
			while (i < value.length && value[i] !== " " && value[i] !== ")") {
				atom += value[i];
				i++;
			}
			parts.push(atom);
		}

		return parts;
	}

	private formatAddressList(value: string): string {
		if (!value || value === "NIL") return "";
		const addresses: string[] = [];
		const re = /\((?:"([^"]*?)"|NIL)\s+(?:"[^"]*?"|NIL)\s+(?:"([^"]*?)"|NIL)\s+(?:"([^"]*?)"|NIL)\)/g;
		let match: RegExpExecArray | null;
		while ((match = re.exec(value)) !== null) {
			const name = match[1] ?? "";
			const user = match[2] ?? "";
			const host = match[3] ?? "";
			const email = user && host ? `${user}@${host}` : "";
			if (name && email) addresses.push(`${name} <${email}>`);
			else if (email) addresses.push(email);
		}
		return addresses.join(", ");
	}
}

function parseListLine(line: string): ImapFolder | null {
	const match = line.match(/^\* LIST \(([^)]*)\) (?:"([^"]*)"|(NIL)) (.+)$/i);
	if (!match) return null;

	const flags = match[1] ? match[1].split(" ").filter(Boolean) : [];
	const delimiter = match[3] ? "" : (match[2] ?? "");
	let path = match[4]?.trim() ?? "";
	if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
	if (!path) return null;

	const name = delimiter && path.includes(delimiter) ? path.split(delimiter).at(-1) ?? path : path;
	const specialUse = flags.find((flag) =>
		["\\All", "\\Archive", "\\Drafts", "\\Flagged", "\\Junk", "\\Sent", "\\Trash"].includes(flag),
	) ?? null;
	return { path, name, delimiter, flags, specialUse };
}

function escapeSearchString(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function buildSearchCriteria(params: {
	from?: string;
	to?: string;
	subject?: string;
	text?: string;
	since?: string;
	before?: string;
	seen?: string;
	flagged?: string;
}): string {
	const parts: string[] = [];
	if (params.from) parts.push(`FROM "${escapeSearchString(params.from)}"`);
	if (params.to) parts.push(`TO "${escapeSearchString(params.to)}"`);
	if (params.subject) parts.push(`SUBJECT "${escapeSearchString(params.subject)}"`);
	if (params.text) parts.push(`BODY "${escapeSearchString(params.text)}"`);
	if (params.since) parts.push(`SINCE ${formatImapDate(params.since)}`);
	if (params.before) parts.push(`BEFORE ${formatImapDate(params.before)}`);
	if (params.seen === "true") parts.push("SEEN");
	if (params.seen === "false") parts.push("UNSEEN");
	if (params.flagged === "true") parts.push("FLAGGED");
	if (params.flagged === "false") parts.push("UNFLAGGED");
	return parts.length > 0 ? parts.join(" ") : "ALL";
}

function formatImapDate(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) throw new Error(`Invalid IMAP date: ${iso}`);
	const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	return `${date.getUTCDate()}-${months[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

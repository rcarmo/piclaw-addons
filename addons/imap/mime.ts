/**
 * mime.ts — Minimal MIME message builder.
 *
 * Creates RFC 5322-compliant messages suitable for IMAP APPEND.
 * No external dependencies — just string formatting.
 */

interface MimeMessageOptions {
	from: string;
	to: string;
	cc?: string;
	subject: string;
	body: string;
	isHtml?: boolean;
	inReplyTo?: string;
	date?: Date;
	isDraft?: boolean;
	messageId?: string;
}

function generateMessageId(): string {
	const rand = Math.random().toString(36).substring(2, 14);
	const ts = Date.now().toString(36);
	return `<${ts}.${rand}@piclaw.local>`;
}

function foldHeader(name: string, value: string): string {
	// RFC 5322: lines should be <= 78 chars, fold with CRLF + space
	const line = `${name}: ${value}`;
	if (line.length <= 78) return line;
	// Simple fold at spaces
	const parts: string[] = [];
	let remaining = line;
	while (remaining.length > 78) {
		let breakAt = remaining.lastIndexOf(" ", 78);
		if (breakAt <= name.length + 2) breakAt = 78;
		parts.push(remaining.slice(0, breakAt));
		remaining = " " + remaining.slice(breakAt).trimStart();
	}
	parts.push(remaining);
	return parts.join("\r\n");
}

function encodeUtf8Header(value: string): string {
	// If ASCII-safe, return as-is
	if (/^[\x20-\x7E]*$/.test(value)) return value;
	// RFC 2047 encoded-word
	const encoded = Buffer.from(value, "utf-8").toString("base64");
	return `=?UTF-8?B?${encoded}?=`;
}

function formatDate(date: Date): string {
	// RFC 5322 date format
	const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
	const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	const d = days[date.getUTCDay()];
	const dd = date.getUTCDate();
	const mon = months[date.getUTCMonth()];
	const yyyy = date.getUTCFullYear();
	const hh = String(date.getUTCHours()).padStart(2, "0");
	const mm = String(date.getUTCMinutes()).padStart(2, "0");
	const ss = String(date.getUTCSeconds()).padStart(2, "0");
	return `${d}, ${dd} ${mon} ${yyyy} ${hh}:${mm}:${ss} +0000`;
}

export function createMimeMessage(opts: MimeMessageOptions): string {
	const date = opts.date ?? new Date();
	const messageId = opts.messageId ?? generateMessageId();
	const contentType = opts.isHtml ? "text/html; charset=UTF-8" : "text/plain; charset=UTF-8";

	const headers: string[] = [
		foldHeader("From", opts.from),
		foldHeader("Date", formatDate(date)),
		foldHeader("Message-ID", messageId),
		foldHeader("Subject", encodeUtf8Header(opts.subject)),
		foldHeader("MIME-Version", "1.0"),
		foldHeader("Content-Type", contentType),
		foldHeader("Content-Transfer-Encoding", "base64"),
	];

	if (opts.to) {
		headers.push(foldHeader("To", opts.to.replace(/;/g, ",")));
	}
	if (opts.cc) {
		headers.push(foldHeader("Cc", opts.cc.replace(/;/g, ",")));
	}
	if (opts.inReplyTo) {
		headers.push(foldHeader("In-Reply-To", opts.inReplyTo));
		headers.push(foldHeader("References", opts.inReplyTo));
	}
	if (opts.isDraft) {
		headers.push(foldHeader("X-Unsent", "1"));
	}

	const bodyBase64 = Buffer.from(opts.body, "utf-8")
		.toString("base64")
		.match(/.{1,76}/g)
		?.join("\r\n") ?? "";

	return headers.join("\r\n") + "\r\n\r\n" + bodyBase64 + "\r\n";
}

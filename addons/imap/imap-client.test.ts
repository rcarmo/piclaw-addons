import { describe, expect, test } from "bun:test";
import { ImapClient, buildSearchCriteria } from "./imap-client.ts";

class FakeSocket {
	writes: Array<string | Buffer> = [];
	listeners = new Map<string, Array<(chunk: any) => void>>();
	on(event: string, handler: (chunk: any) => void) {
		const list = this.listeners.get(event) ?? [];
		list.push(handler);
		this.listeners.set(event, list);
		return this;
	}
	once(event: string, handler: (chunk: any) => void) {
		const wrapped = (chunk: any) => {
			this.removeListener(event, wrapped);
			handler(chunk);
		};
		return this.on(event, wrapped);
	}
	removeListener(event: string, handler: (chunk: any) => void) {
		const list = this.listeners.get(event) ?? [];
		this.listeners.set(event, list.filter((item) => item !== handler));
		return this;
	}
	write(chunk: string | Buffer) {
		this.writes.push(chunk);
		return true;
	}
	destroy() {}
	emit(event: string, chunk: string | Buffer) {
		for (const handler of this.listeners.get(event) ?? []) handler(chunk);
	}
}

function makeClient() {
	return new ImapClient({
		host: "imap.example.com",
		port: 993,
		tls: true,
		user: "user@example.com",
		pass: "secret",
	});
}

describe("buildSearchCriteria", () => {
	test("escapes quotes and backslashes", () => {
		const criteria = buildSearchCriteria({
			from: 'Alice "Dev"',
			text: String.raw`C:\mailbox`,
			seen: "false",
		});
		expect(criteria).toContain('FROM "Alice \\"Dev\\""');
		expect(criteria).toContain('BODY "C:\\\\mailbox"');
		expect(criteria).toContain("UNSEEN");
	});

	test("rejects invalid dates", () => {
		expect(() => buildSearchCriteria({ since: "not-a-date" })).toThrow("Invalid IMAP date");
	});
});

describe("ImapClient protocol handling", () => {
	test("parses LIST with NIL delimiter", async () => {
		const client = makeClient();
		const socket = new FakeSocket();
		(client as any).sock = socket;
		socket.on("data", (chunk) => (client as any).feed(chunk));
		const pending = client.list();
		expect(String(socket.writes[0])).toContain('LIST "" "*"');
		socket.emit("data", Buffer.from('* LIST (\\HasNoChildren) NIL INBOX\r\nA0001 OK LIST completed\r\n'));
		await expect(pending).resolves.toEqual([
			{ path: "INBOX", name: "INBOX", delimiter: "", flags: ["\\HasNoChildren"], specialUse: null },
		]);
	});

	test("fetchSource returns full literal body", async () => {
		const client = makeClient();
		const socket = new FakeSocket();
		(client as any).sock = socket;
		socket.on("data", (chunk) => (client as any).feed(chunk));
		(client as any).selected = "INBOX";
		const pending = client.fetchSource("INBOX", 42);
		expect(String(socket.writes[0])).toContain("UID FETCH 42 (BODY[])");
		const body = "Subject: hi\r\n\r\nOlá";
		socket.emit("data", Buffer.from(`* 1 FETCH (UID 42 BODY[] {${Buffer.byteLength(body)}}\r\n`));
		socket.emit("data", Buffer.concat([Buffer.from(body), Buffer.from("\r\nA0001 OK FETCH completed\r\n")]));
		await expect(pending).resolves.toBe(body);
	});

	test("append waits for continuation and sends literal body", async () => {
		const client = makeClient();
		const socket = new FakeSocket();
		(client as any).sock = socket;
		socket.on("data", (chunk) => (client as any).feed(chunk));
		const pending = client.append("Drafts", "hello ✓", ["\\Draft"]);
		expect(String(socket.writes[0])).toContain('APPEND Drafts (\\Draft) {');
		socket.emit("data", Buffer.from("+ Ready for literal data\r\n"));
		expect(Buffer.isBuffer(socket.writes[1])).toBe(true);
		expect((socket.writes[1] as Buffer).toString("utf-8")).toBe("hello ✓");
		expect(String(socket.writes[2])).toBe("\r\n");
		socket.emit("data", Buffer.from("A0001 OK APPEND completed\r\n"));
		await expect(pending).resolves.toBeUndefined();
	});

	test("serializes concurrent commands on one connection", async () => {
		const client = makeClient();
		const socket = new FakeSocket();
		(client as any).sock = socket;
		socket.on("data", (chunk) => (client as any).feed(chunk));

		const first = client.noop();
		const second = client.list();
		expect(socket.writes.length).toBe(1);
		expect(String(socket.writes[0])).toContain("NOOP");

		socket.emit("data", Buffer.from("A0001 OK NOOP completed\r\n"));
		await expect(first).resolves.toBeUndefined();
		expect(String(socket.writes[1])).toContain('LIST "" "*"');

		socket.emit("data", Buffer.from('* LIST (\\HasNoChildren) "/" INBOX\r\nA0002 OK LIST completed\r\n'));
		await expect(second).resolves.toEqual([
			{ path: "INBOX", name: "INBOX", delimiter: "/", flags: ["\\HasNoChildren"], specialUse: null },
		]);
	});
});

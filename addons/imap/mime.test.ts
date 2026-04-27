import { describe, expect, test } from "bun:test";
import { createMimeMessage } from "./mime.ts";

describe("createMimeMessage", () => {
	test("creates draft-friendly RFC 5322 message", () => {
		const message = createMimeMessage({
			from: "Rui Carmo <rui@example.com>",
			to: "test@example.com",
			subject: "Olá mundo",
			body: "hello world",
			isDraft: true,
		});

		expect(message).toContain("From: Rui Carmo <rui@example.com>");
		expect(message).toContain("To: test@example.com");
		expect(message).toContain("X-Unsent: 1");
		expect(message).toContain("Subject: =?UTF-8?B?");
		expect(message).toContain("Content-Transfer-Encoding: base64");
		expect(message.endsWith("\r\n")).toBe(true);
	});

	test("wraps long base64 body lines", () => {
		const body = "x".repeat(200);
		const message = createMimeMessage({
			from: "rui@example.com",
			to: "test@example.com",
			subject: "Long",
			body,
		});

		const encodedBody = message.split("\r\n\r\n")[1] ?? "";
		for (const line of encodedBody.trim().split("\r\n")) {
			expect(line.length).toBeLessThanOrEqual(76);
		}
	});
});

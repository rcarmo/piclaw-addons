import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureNativeOutputResponse, type PendingActivity } from "./src/providers/openai-codex-native-output-observer.ts";

const encoder = new TextEncoder();
const data = (event: unknown) => `data: ${JSON.stringify(event)}`;
const created = (id: string) => data({ type: "response.created", response: { id } });
const completed = (item: Record<string, unknown>) => data({ type: "response.output_item.done", item });
const image = (id: string, value: string, revised_prompt?: string) => completed({
	type: "image_generation_call", id, result: Buffer.from(value).toString("base64"), revised_prompt,
});

function bytewiseResponse(text: string, onEOF: () => void): Response {
	const bytes = encoder.encode(text);
	let offset = 0;
	return new Response(new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset < bytes.length) {
				controller.enqueue(bytes.subarray(offset, offset + 1));
				offset++;
			} else {
				onEOF();
				controller.close();
			}
		},
	}, { highWaterMark: 0 }));
}

test("stream capture keeps image response IDs and activity order across byte boundaries", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "codex-stream-"));
	try {
		await mkdir(join(cwd, ".git"));
		let eof = false;
		const response = bytewiseResponse([
			`\uFEFF${created("first")}\r\n\r\n`,
			// A CR left after CRLF normalization is not a blank line. This whole frame is invalid.
			`${created("ignored")}\r\n\r\r\ndata: not-json\n\n`,
			`${data({ type: "response.output_text.delta", delta: "ignored" })}\n\n`,
			`${completed({ type: "message", id: "ignored" })}\n\n`,
			`${image("one", "first image", "Café 🐈")}\r\n\r\n`,
			'data: \t{"type":"response.output_item.done",\r\n',
			'data:\u00A0"item":{"type":"web_search_call","id":"search","action":{"query":"café"}}}\r\n\r\n',
			"data: [DONE]\n\n",
			`${created("second")}\n\n`,
			image("two", "second image"),
		].join(""), () => { eof = true; });
		const activities: PendingActivity[] = [];
		const guardPhases: boolean[] = [];
		await captureNativeOutputResponse(response, cwd, "Original prompt", (activity) => {
			expect(guardPhases[1]).toBe(true);
			activities.push(activity);
		}, () => { guardPhases.push(eof); });

		expect(guardPhases.slice(0, 2)).toEqual([false, true]);
		expect(activities).toHaveLength(3);
		expect(activities[0]).toMatchObject({ kind: "image", savedImage: { responseId: "first", callId: "one", revisedPrompt: "Café 🐈" } });
		expect(activities[1]).toMatchObject({ kind: "web-search", search: { callId: "search", query: "café" } });
		expect(activities[2]).toMatchObject({ kind: "image", savedImage: { responseId: "second", callId: "two", revisedPrompt: "Original prompt" } });
		const dir = join(cwd, ".pi/openai-codex-images");
		expect(await readFile(join(dir, "one-first.png"), "utf8")).toBe("first image");
		expect(await readFile(join(dir, "two-second.png"), "utf8")).toBe("second image");
		expect(await readFile(join(dir, "latest.png"), "utf8")).toBe("second image");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("a body error after a complete image frame prevents capture effects", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "codex-stream-failure-"));
	try {
		await mkdir(join(cwd, ".git"));
		let sent = false;
		const response = new Response(new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent) controller.error(new Error("body failed"));
				else {
					sent = true;
					controller.enqueue(encoder.encode(`${created("resp")}\n\n${image("call", "image")}\n\n`));
				}
			},
		}, { highWaterMark: 0 }));
		const activities: PendingActivity[] = [];
		let checks = 0;
		await expect(captureNativeOutputResponse(response, cwd, undefined, (activity) => {
			activities.push(activity);
		}, () => { checks++; })).rejects.toThrow("body failed");
		expect(checks).toBe(1);
		expect(activities).toHaveLength(0);
		expect(existsSync(join(cwd, ".pi"))).toBe(false);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("JSON null still fails after EOF and earlier activity, not while reading", async () => {
	const search = (id: string) => completed({ type: "web_search_call", id });
	const observed: string[] = [];
	const response = bytewiseResponse(`${search("before")}\n\ndata: null\n\n${search("after")}`, () => { observed.push("eof"); });
	await expect(captureNativeOutputResponse(response, tmpdir(), undefined, (activity) => {
		if (activity.kind === "web-search") observed.push(activity.search.callId);
	}, () => { observed.push("guard"); })).rejects.toBeInstanceOf(TypeError);
	expect(observed).toEqual(["guard", "eof", "guard", "before"]);
});

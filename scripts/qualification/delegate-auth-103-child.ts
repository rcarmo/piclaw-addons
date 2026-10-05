/** Inactive synthetic child extension. Loaded only by the opt-in qualification. */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { type AuthResult, type Model, type Provider, type ProviderRequestOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex");

export default function fixture(pi: ExtensionAPI) {
  const input = createReadStream("", { fd: 4, autoClose: false });
  const output = createWriteStream("", { fd: 3, autoClose: false });
  let buffer = "", next = 0, closed = false, streams = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  function close() {
    if (closed) return;
    closed = true;
    for (const request of pending.values()) request.reject(new Error("Scoped auth unavailable"));
    pending.clear(); input.destroy(); output.destroy();
  }
  function request(action: string, value?: unknown): Promise<unknown> {
    if (closed) return Promise.reject(new Error("Scoped auth unavailable"));
    return new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      output.write(JSON.stringify({ id, action, ...(value === undefined ? {} : { value }) }) + "\n");
    });
  }
  input.on("end", close); input.on("error", close); output.on("error", close);
  input.on("data", chunk => {
    buffer += chunk.toString();
    if (buffer.length > 65_536) return close();
    for (let end; (end = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const reply = JSON.parse(line);
        const waiter = pending.get(reply.id);
        if (!waiter) return close();
        pending.delete(reply.id);
        if (reply.ok === true) waiter.resolve(reply.value);
        else waiter.reject(new Error("Scoped auth unavailable"));
      } catch { close(); }
    }
  });

  const model: Model<"openai-completions"> = {
    id: "bridge-test", name: "Synthetic auth bridge", api: "openai-completions", provider: "delegate-auth-fixture",
    baseUrl: "https://unused.invalid", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1024,
  };
  const stream = (selected: Model<any>, _context: TranscriptContext, options?: ProviderRequestOptions) => {
    const events = new AssistantMessageEventStream();
    const message: any = {
      role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "pending", timestamp: Date.now(),
    };
    void (async () => {
      try {
        streams++;
        await request("observed", { stream: streams, apiKey: digest(options?.apiKey), headers: digest(options?.headers), env: digest(options?.env), baseUrl: selected.baseUrl });
        message.content = streams === 1
          ? [{ type: "toolCall", id: "advance-1", name: "advance", arguments: {} }]
          : [{ type: "text", text: "AUTH_BRIDGE_OK" }];
        message.stopReason = streams === 1 ? "toolUse" : "stop";
        events.push({ type: "done", reason: message.stopReason, message }); events.end();
      } catch {
        message.stopReason = "error"; message.errorMessage = "Scoped auth unavailable";
        events.push({ type: "error", reason: "error", error: message }); events.end();
      }
    })();
    return events;
  };
  const provider: Provider = {
    id: model.provider, name: "Synthetic child", getModels: () => [model],
    auth: { apiKey: { name: "Parent pipe", check: async () => ({ type: "api_key", source: "parent pipe" }), resolve: async () => await request("auth") as AuthResult | undefined } },
    stream, streamSimple: stream,
  };
  pi.registerProvider(provider);
  pi.registerTool({ name: "advance", label: "Advance synthetic auth", description: "Advance the synthetic parent auth state", parameters: Type.Object({}), execute: async () => {
    await request("advance"); return { content: [{ type: "text", text: "advanced" }], details: {} };
  } });
  pi.on("session_shutdown", async () => close());
}

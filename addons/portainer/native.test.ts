import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import addon, { createPortainerTool, getPortainerPrompt } from "./index.js";

function fixture() {
  let allowed = true, effects = 0;
  const options = { chatJid: "web:native-portainer", assertCurrent() { if (!allowed) throw Error("revoked"); },
    credentials: { async get(name: string) { return { name, type: "secret", secret: "synthetic", username: "fixture@pam!test" }; }, list() { return []; } },
    transport: async (...args: any[]) => { effects++; return { status: 200, statusText: "OK", bodyText: "[]" }; },
  };
  const tool = createPortainerTool(options);
  const invoke = (params: any) => tool.execute("test", params);
  const configure = () => invoke({ action: "set", base_url: "https://synthetic.invalid", username: "fixture@pam!test", api_token_keychain: "fixture/test" });
  return { options, tool, invoke, configure, revoke() { allowed = false; }, effects: () => effects };
}
test("native declaration, prompt, skills and pure action parity", async () => {
  let legacy: any; const hooks: Record<string, any> = {};
  addon({ registerTool(t: any) { legacy = t; }, on(name: string, hook: any) { hooks[name] = hook; } } as any);
  const f = fixture();
  expect(f.tool.parameters).toEqual(legacy.parameters);
  const capabilities = await f.invoke({ action: "capabilities", include_workflows: true });
  for (const workflow of (capabilities.details.workflows as Array<{ name: string }>)) {
    const params = { action: "workflow_help", workflow: workflow.name, include_examples: true };
    expect(await f.invoke(params)).toEqual(await legacy.execute("test", { ...params, chat_jid: f.options.chatJid }));
  }
  expect((await hooks.before_agent_start({ systemPrompt: "base" })).systemPrompt).toBe(`base\n\n${getPortainerPrompt()}`);
  expect(hooks.resources_discover().skillPaths.length).toBeGreaterThan(0);
  for (const params of [{ action: "contract" }, { action: "capabilities", include_workflows: true }, { action: "recommend", intent: "inspect" }, { action: "request_help" }, { action: "workflow_help", workflow: "endpoint.list" }]) {
    expect(await f.invoke(params)).toEqual(await legacy.execute("test", { ...params, chat_jid: f.options.chatJid }));
  }
});
test("all remaining actions use real implementation and synthetic transport", async () => {
  const f = fixture(); await f.configure();
  expect((await f.invoke({ action: "get" })).details.configured).toBe(true);
  expect((await f.invoke({ action: "discover" })).details.action).toBe("discover");
  expect((await f.invoke({ action: "request", path: "/api/endpoints" })).details.ok).toBe(true);
  expect((await f.invoke({ action: "workflow", workflow: "endpoint.list" })).details.ok).toBe(true);
  expect(f.effects()).toBe(2);
  expect((await f.invoke({ action: "clear" })).details.deleted).toBe(true);
});
test("credential await revocation prevents HTTP dispatch", async () => {
  const f = fixture(); await f.configure();
  f.options.credentials.get = async name => { await Promise.resolve(); f.revoke(); return { name, type: "secret", secret: "synthetic", username: "fixture@pam!test" }; };
  await expect(f.invoke({ action: "request", path: "/api/endpoints" })).rejects.toThrow("revoked");
  expect(f.effects()).toBe(0);
});
test("revocation after HTTP await prevents retries, next batch request and output writes", async () => {
  const f = fixture(); await f.configure();
  let requests = 0;
  f.options.transport = async () => { requests++; await Promise.resolve(); f.revoke(); return { status: 200, statusText: "OK", bodyText: "[]" }; };
  const tool = createPortainerTool(f.options);
  const output = "native-portainer-revoked.json";
  await expect(tool.execute("test", { action: "request", requests: [{ path: "/api/endpoints" }, { path: "/api/endpoints" }], retries: 2, throttle_ms: 0, output_path: output })).rejects.toThrow("revoked");
  expect(requests).toBe(1);
  expect(existsSync(join(process.env.PICLAW_WORKSPACE!, output))).toBe(false);
});
test("foreign chat denied and concurrent invocation scopes never exchange authority", async () => {
  const a = fixture(), b = fixture(); await a.configure(); await b.configure();
  await expect(a.invoke({ action: "clear", chat_jid: "web:foreign" })).rejects.toThrow("Foreign");
  let release!: () => void;
  const wait = new Promise<void>(resolve => release = resolve);
  a.options.credentials.get = async name => { await wait; return { name, type: "secret", secret: "synthetic", username: "fixture@pam!test" }; };
  const pending = createPortainerTool(a.options).execute("a", { action: "request", path: "/api/endpoints" });
  a.revoke();
  await b.invoke({ action: "request", path: "/api/endpoints" }); release();
  await expect(pending).rejects.toThrow("revoked");
  expect(a.effects()).toBe(0); expect(b.effects()).toBe(1);
});

test("multi-step workflow stops at next effect after revocation", async () => {
  const f = fixture(); await f.configure(); let requests = 0;
  f.options.transport = async () => { requests++; await Promise.resolve(); f.revoke(); return { status: 200, statusText: "OK", bodyText: '{"Id":"synthetic-exec"}' }; };
  await expect(createPortainerTool(f.options).execute("workflow", { action: "workflow", workflow: "container.exec", endpoint_id: 1, container_id: "synthetic", command: "true" })).rejects.toThrow("revoked");
  expect(requests).toBe(1);
});
test("aborted invocation cannot write a profile", async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort();
  await expect(f.tool.execute("abort", { action: "set", base_url: "https://foreign.invalid" }, controller.signal)).rejects.toThrow();
});

test("revocation during retry backoff prevents another dispatch", async () => {
  const f = fixture(); await f.configure(); let requests = 0;
  f.options.transport = async () => { requests++; setTimeout(() => f.revoke(), 1); throw Error("synthetic network failure"); };
  await expect(createPortainerTool(f.options).execute("retry", { action: "request", requests: [{ path: "/synthetic" }], retry_delay_ms: 10, retries: 2, throttle_ms: 0 })).rejects.toThrow("revoked");
  expect(requests).toBe(1);
});

// A timed-out credential continuation must not dispatch while its retry is alive.
test("timed-out batch attempt loses authority independently of retry", async () => {
  const f = fixture(); await f.configure();
  let lookups = 0, releaseFirst!: () => void, releaseSecond!: () => void;
  let secondStarted!: () => void;
  const second = new Promise<void>(resolve => secondStarted = resolve);
  const firstWait = new Promise<void>(resolve => releaseFirst = resolve);
  const secondWait = new Promise<void>(resolve => releaseSecond = resolve);
  f.options.credentials.get = async name => {
    lookups++;
    if (lookups === 1) await firstWait;
    else { secondStarted(); await secondWait; }
    return { name, type: "secret", secret: "synthetic", username: "fixture@pam!test" };
  };
  const pending = createPortainerTool(f.options).execute("timeout", { action: "request", requests: [{ path: "/synthetic" }], timeout_ms: 30, retries: 1, retry_delay_ms: 0, throttle_ms: 0 });
  await second;
  releaseFirst();
  await new Promise(resolve => setTimeout(resolve, 2));
  expect(f.effects()).toBe(0);
  releaseSecond();
  expect((await pending).details.ok).toBe(true);
  expect(f.effects()).toBe(1);
});

test("production HTTP transport uses invocation credentials and fences response continuation", async () => {
  const f = fixture(); let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests++;
    expect(request.headers.get("x-api-key")).toContain("synthetic");
    if (requests === 2) f.revoke();
    return Response.json([]);
  } });
  try {
    const tool = createPortainerTool({ ...f.options, transport: undefined });
    await tool.execute("set", { action: "set", base_url: server.url.toString() });
    expect((await tool.execute("http", { action: "request", path: "/synthetic" })).details.ok).toBe(true);
    await expect(tool.execute("http-revoke", { action: "request", requests: [{ path: "/synthetic" }, { path: "/never" }], retries: 2, throttle_ms: 0 })).rejects.toThrow("revoked");
    expect(requests).toBe(2);
  } finally { server.stop(true); }
});

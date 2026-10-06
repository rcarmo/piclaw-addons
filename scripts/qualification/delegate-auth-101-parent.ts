/** Synthetic qualification runner; no production Delegate caller imports this file. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, type AuthResult, type Model, type OAuthCredential, type Provider } from "@earendil-works/pi-ai";

const [root, cli, extension] = process.argv.slice(2);
assert(root && cli && extension);
let networkAttempts = 0;
globalThis.fetch = Object.assign(() => { networkAttempts++; throw new Error("Network forbidden"); }, { preconnect: () => { networkAttempts++; throw new Error("Network forbidden"); } }) as typeof fetch;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex");
const rows: object[] = [];
const secrets: string[] = [];

for (const mode of ["rotate", "api-key-env", "logout", "denied", "disconnect", "terminate"] as const) {
  const path = join(root, mode); mkdirSync(path);
  for (const dir of ["home", "profile", "workspace", "tmp"]) mkdirSync(join(path, dir));
  const guard = join(path, "guard.ts");
  const childNetworkLog = join(path, "network-attempts.log");
  writeFileSync(guard, `import {appendFileSync} from 'node:fs'; globalThis.fetch=()=>{appendFileSync(${JSON.stringify(childNetworkLog)},'attempt\\n');throw Error('Network forbidden')};\n`);
  writeFileSync(join(path, "profile/settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
  const store = new InMemoryCredentialStore();
  const initial: OAuthCredential = { type: "oauth", access: `SYNTHETIC_ACCESS_${mode}_1`, refresh: `SYNTHETIC_REFRESH_${mode}_1`, expires: Date.now() + 3_600_000 };
  secrets.push(initial.access, initial.refresh);
  const providerId = "delegate-auth-fixture";
  await store.modify(providerId, async () => initial);
  // An unrelated synthetic provider credential must never cross the broker.
  const unrelated = `SYNTHETIC_UNRELATED_${mode}`; secrets.push(unrelated);
  await store.modify("unrelated", async () => ({ type: "api_key", key: unrelated }));
  const runtime = await ModelRuntime.create({ credentials: store, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  let authRequests = 0, observations = 0, advanced = 0, refreshes = 0;
  const sent: AuthResult[] = [];
  const model: Model<"openai-completions"> = {
    id: "bridge-test", name: "Synthetic parent", api: "openai-completions", provider: providerId,
    baseUrl: "https://unused.invalid", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1024,
  };
  let provider: Provider = {
    id: providerId, name: "Synthetic parent", getModels: () => [model],
    auth: { oauth: {
      name: "Synthetic OAuth", login: async () => { throw Error("Login forbidden"); },
      refresh: async credential => {
        assert.equal(credential.refresh, initial.refresh); refreshes++;
        const rotated = { ...credential, access: `SYNTHETIC_ACCESS_${mode}_2`, refresh: `SYNTHETIC_REFRESH_${mode}_2`, expires: Date.now() + 3_600_000 };
        secrets.push(rotated.access, rotated.refresh); return rotated;
      },
      toAuth: async credential => ({ apiKey: credential.access, headers: { "x-private-fixture": credential.access, "X-Suppress": null }, baseUrl: `https://fixture-${credential.access.endsWith("_2") ? "2" : "1"}.invalid` }),
    } },
    stream: () => { throw Error("Parent inference forbidden"); }, streamSimple: () => { throw Error("Parent inference forbidden"); },
  };
  if (mode === "api-key-env") {
    await store.modify(providerId, async () => ({ type: "api_key", key: initial.access, env: { FIXTURE_SCOPED_ENV: "SYNTHETIC_ENV_VALUE" } }));
    secrets.push("SYNTHETIC_ENV_VALUE");
    provider = { ...provider, auth: { apiKey: { name: "Synthetic key", check: async () => ({ type: "api_key" }), resolve: async ({ credential }) => credential?.key ? { auth: { apiKey: credential.key, headers: { "x-private-fixture": credential.key, "X-Suppress": null }, baseUrl: "https://fixture-key.invalid" }, env: credential.env } : undefined } } };
  }
  runtime.registerNativeProvider(provider);
  await runtime.refresh({ allowNetwork: false });
  if (mode === "denied") await runtime.logout(providerId);
  const registry = new ModelRegistry(runtime);
  const env = { PATH: "/usr/bin:/bin", HOME: join(path, "home"), PI_CODING_AGENT_DIR: join(path, "profile"), TMPDIR: join(path, "tmp"), XDG_CONFIG_HOME: join(path, "home"), XDG_CACHE_HOME: join(path, "home"), PI_OFFLINE: "1", PI_TELEMETRY: "0", NO_COLOR: "1" };
  const args = ["--no-env-file", "--preload", guard, cli, "--offline", "--mode", "json", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "-e", extension, "--model", `${providerId}/${model.id}`, "--tools", "advance", "Run synthetic fixture"];
  const child = spawn(process.execPath, args, { cwd: join(path, "workspace"), env, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "", buffer = "", failure: unknown, terminated = false;
  const input = child.stdio[3] as Readable, output = child.stdio[4] as Writable;
  const terminate = () => { if (!terminated && child.pid) { terminated = true; try { child.kill("SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } } };
  output.on("error", () => { if (mode !== "terminate" && mode !== "disconnect") { failure = Error("Broker write failed"); terminate(); } });
  child.stdout!.on("data", bytes => { stdout += bytes.toString(); if (stdout.length > 200_000) { failure = Error("stdout overflow"); terminate(); } });
  child.stderr!.on("data", bytes => { stderr += bytes.toString(); if (stderr.length > 200_000) { failure = Error("stderr overflow"); terminate(); } });
  let chain = Promise.resolve();
  input.on("data", bytes => {
    buffer += bytes.toString(); if (buffer.length > 65_536) { failure = Error("IPC overflow"); terminate(); return; }
    for (let end; (end = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      chain = chain.then(async () => {
        const request = JSON.parse(line);
        assert(Number.isSafeInteger(request.id));
        assert.deepEqual(Object.keys(request).sort(), request.action === "observed" ? ["action", "id", "value"] : ["action", "id"]);
        let value: unknown = null;
        if (request.action === "auth") {
          authRequests++;
          if (authRequests === 2 && mode === "disconnect") { output.end(); return; }
          if (authRequests === 2 && mode === "terminate") { terminate(); return; }
          // The immutable model binding comes from this parent, never the child message.
          if (!await registry.getProviderAuth(providerId)) { output.write(JSON.stringify({ id: request.id, ok: false }) + "\n"); return; }
          const resolved = await registry.getApiKeyAndHeaders(model);
          assert(resolved.ok);
          value = { auth: { apiKey: resolved.apiKey, headers: resolved.headers, baseUrl: resolved.baseUrl }, env: resolved.env } satisfies AuthResult;
          sent.push(value as AuthResult);
        } else if (request.action === "advance") {
          advanced++;
          if (mode === "rotate") await store.modify(providerId, async credential => ({ ...credential as OAuthCredential, expires: 0 }));
          if (mode === "logout") await runtime.logout(providerId);
        } else if (request.action === "observed") {
          observations++; const current = sent.at(-1)!;
          assert.deepEqual(request.value, { stream: observations, apiKey: digest(current.auth.apiKey), headers: digest(current.auth.headers), env: digest(current.env), baseUrl: current.auth.baseUrl });
        } else throw Error("Unexpected IPC action");
        output.write(JSON.stringify({ id: request.id, ok: true, value }) + "\n");
      }).catch(error => { failure = error; terminate(); });
    }
  });
  let rejectDeadline!: (error: Error) => void;
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  const timer = setTimeout(() => { terminate(); rejectDeadline(Error("Child deadline exceeded")); }, 12_000);
  const stop = () => { terminate(); rejectDeadline(Error("Qualification interrupted")); }; process.once("SIGTERM", stop); process.once("SIGINT", stop);
  let exit: number | null;
  const exited = new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  try {
    exit = await Promise.race([exited, deadline]);
    await Promise.race([chain, deadline]); if (failure) throw failure;
  } finally {
    clearTimeout(timer); process.off("SIGTERM", stop); process.off("SIGINT", stop);
    if (child.exitCode === null && child.signalCode === null) terminate();
    input.destroy(); output.destroy(); await exited;
  }
  const success = mode === "rotate" || mode === "api-key-env";
  assert.equal(advanced, mode === "denied" ? 0 : 1); assert.equal(authRequests, mode === "denied" ? 1 : 2); assert.equal(observations, success ? 2 : mode === "denied" ? 0 : 1);
  const events = stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const assistants = events.filter(event => event.type === "message_end" && event.message.role === "assistant").map(event => event.message);
  if (mode === "terminate") { assert.equal(exit, null); assert.equal(child.signalCode, "SIGKILL"); assert.equal(assistants.length, 1); assert.equal(assistants[0].stopReason, "toolUse"); }
  else {
    assert.equal(exit, 0, "Child failed"); assert.equal(assistants.length, mode === "denied" ? 1 : 2);
    const terminal = assistants.at(-1);
    assert.equal(terminal.stopReason, success ? "stop" : "error");
    if (success) assert.deepEqual(terminal.content, [{ type: "text", text: "AUTH_BRIDGE_OK" }]);
    else { assert.match(terminal.errorMessage, /Scoped auth unavailable/); assert(!stdout.includes("AUTH_BRIDGE_OK")); }
    assert.equal(events.at(-1)?.type, "agent_settled");
  }
  if (mode === "api-key-env") assert.equal(sent[0].env?.FIXTURE_SCOPED_ENV, "SYNTHETIC_ENV_VALUE");
  assert.equal(refreshes, mode === "rotate" ? 1 : 0);
  assert.equal((await store.read("unrelated"))?.type, "api_key");
  if (mode === "logout") assert.equal(await store.read(providerId), undefined);
  if (mode === "rotate") assert((await store.read(providerId) as OAuthCredential).refresh.endsWith("_2"));
  for (const secret of secrets) {
    assert(!stdout.includes(secret), "stdout secrecy"); assert(!stderr.includes(secret), "stderr secrecy");
    assert(!JSON.stringify({ args, env }).includes(secret), "launch secrecy");
  }
  const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)]);
  for (const file of ["profile", "workspace", "home", "tmp"].flatMap(dir => walk(join(path, dir)))) {
    const text = readFileSync(file, "utf8"); for (const secret of secrets) assert(!text.includes(secret), "disk secrecy"); assert(!file.endsWith(".jsonl"));
  }
  assert(!readdirSync(path).includes("network-attempts.log"), "No child fetch attempt");
  rows.push({ mode, authRequests, observations, advanced, refreshes, exit, signal: child.signalCode, secrecy: "pass", childFetchAttempts: 0 });
}
assert.equal(networkAttempts, 0);
console.log(JSON.stringify({ version: "1.0.1", runtime: Bun.version, rows, networkAttempts, scope: "synthetic public extension/provider IPC seam only; not production Delegate or real-provider parity" }, null, 2));

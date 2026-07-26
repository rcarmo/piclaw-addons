import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildAppInsightsActorAttributes,
  buildRuntimeConfigKey,
  buildSyntheticDependencyAttributes,
  buildSyntheticRequestAttributes,
  modelDependencyTarget,
} from "./index.ts";

test("observability compat shims avoid runtime source imports", () => {
  for (const file of ["extension-kv.ts", "keychain.ts", "log-sink.ts"]) {
    const source = readFileSync(join(import.meta.dir, "compat", file), "utf8");
    expect(source).not.toContain("piclaw/runtime/src");
  }
});

test("buildRuntimeConfigKey changes only for backend runtime settings", () => {
  const base = {
    enabled: true,
    instance_name: "smith",
    appinsights_enabled: true,
    appinsights_keychain: "azure/appinsights-connection-string",
    appinsights_live_metrics: true,
    appinsights_standard_metrics: true,
    appinsights_sampling_ratio: 1,
    graphite_enabled: false,
    graphite_host: "",
    graphite_port: 2003,
    graphite_prefix: "piclaw",
  };
  expect(buildRuntimeConfigKey({ ...base })).toBe(buildRuntimeConfigKey(base));
  expect(buildRuntimeConfigKey({ ...base, instance_name: "smith-2" })).not.toBe(buildRuntimeConfigKey(base));
  expect(buildRuntimeConfigKey({ ...base, graphite_enabled: true, graphite_host: "graphite.local" })).not.toBe(buildRuntimeConfigKey(base));
});

test("process runtime is not torn down by individual session shutdown hooks", () => {
  const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
  expect(source).toContain("ensureProcessRuntimeConfig");
  expect(source).not.toContain('pi.on("session_shutdown"');
});

test("buildSyntheticRequestAttributes adds request-style semantics for agent turns", () => {
  const attrs = buildSyntheticRequestAttributes({ "piclaw.chat_jid": "web:default" }, "/agent/turn", "smith");
  expect(attrs).toMatchObject({
    "piclaw.chat_jid": "web:default",
    "http.request.method": "POST",
    "http.route": "/agent/turn",
    "server.address": "smith",
    "network.protocol.name": "piclaw",
    "piclaw.telemetry_class": "request",
  });
  expect(String(attrs["url.full"])).toBe("piclaw://request/agent/turn");
});

test("buildSyntheticDependencyAttributes adds dependency-style semantics for model and tool calls", () => {
  const attrs = buildSyntheticDependencyAttributes({ "piclaw.model": "openai/gpt-5" }, "/model/call", "openai", "model");
  expect(attrs).toMatchObject({
    "piclaw.model": "openai/gpt-5",
    "http.request.method": "POST",
    "http.route": "/model/call",
    "server.address": "openai",
    "peer.service": "openai",
    "network.protocol.name": "piclaw",
    "piclaw.telemetry_class": "dependency",
    "piclaw.dependency.kind": "model",
  });
  expect(String(attrs["url.full"])).toBe("piclaw://openai/model/call");
});

test("buildAppInsightsActorAttributes maps chat and session into App Insights user/session fields", () => {
  expect(buildAppInsightsActorAttributes("web:addons", "leaf-123", "smith")).toMatchObject({
    "piclaw.chat_jid": "web:addons",
    "piclaw.actor.kind": "chat_jid",
    "piclaw.actor.id": "web:addons",
    "enduser.id": "web:addons",
    "enduser.pseudo.id": "web:addons",
    "ai.user.authUserId": "web:addons",
    "ai.user.id": "web:addons",
    "session.id": "leaf-123",
    "ai.session.id": "leaf-123",
    "piclaw.session.id": "leaf-123",
    "piclaw.session_leaf_id": "leaf-123",
  });
});

test("modelDependencyTarget prefers the provider prefix and falls back to llm", () => {
  expect(modelDependencyTarget("azure-openai/gpt-5")).toBe("azure-openai");
  expect(modelDependencyTarget("gpt-5")).toBe("gpt-5");
  expect(modelDependencyTarget("")).toBe("llm");
  expect(modelDependencyTarget(null)).toBe("llm");
});

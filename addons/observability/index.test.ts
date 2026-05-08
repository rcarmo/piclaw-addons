import { expect, test } from "bun:test";
import {
  buildAppInsightsActorAttributes,
  buildSyntheticDependencyAttributes,
  buildSyntheticRequestAttributes,
  modelDependencyTarget,
} from "./index.ts";

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

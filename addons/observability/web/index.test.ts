import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  deriveTelemetryEventsFromSse,
  isBrowserTelemetryConfigEnabled,
  normalizeChatJid,
  parseChatJidFromUrl,
} from "./index.ts";

test("normalizeChatJid trims and nulls blanks", () => {
  expect(normalizeChatJid(" web:default ")).toBe("web:default");
  expect(normalizeChatJid("   ")).toBeNull();
  expect(normalizeChatJid(null)).toBeNull();
});

test("parseChatJidFromUrl prefers explicit chat_jid query", () => {
  expect(parseChatJidFromUrl("/sse/stream?chat_jid=web%3Adefault%3Abranch%3A1", "https://example.test/")).toBe("web:default:branch:1");
  expect(parseChatJidFromUrl("/agent/models", "https://example.test/")).toBe("web:default");
});

test("deriveTelemetryEventsFromSse emits turn start, phase, and completion by chat jid", () => {
  const state: Record<string, unknown> = {};

  const started = deriveTelemetryEventsFromSse("agent_status", {
    chat_jid: "web:default:branch:42",
    turn_id: "turn-1",
    type: "thinking",
    title: "Thinking…",
  }, state);
  expect(started.map((event) => event.name)).toEqual(["agent.turn.start"]);

  const phased = deriveTelemetryEventsFromSse("agent_status", {
    chat_jid: "web:default:branch:42",
    turn_id: "turn-1",
    type: "tool_call",
    title: "Running read",
  }, state);
  expect(phased.map((event) => event.name)).toEqual(["agent.turn.phase"]);

  const completed = deriveTelemetryEventsFromSse("agent_status", {
    chat_jid: "web:default:branch:42",
    turn_id: "turn-1",
    type: "done",
    context_usage: { percent: 31 },
  }, state);
  expect(completed.map((event) => event.name)).toEqual(["agent.turn.complete"]);
  expect(completed[0]?.measurements?.contextPercent).toBe(31);
});

test("browser telemetry requires an explicit enabled config", () => {
  expect(isBrowserTelemetryConfigEnabled({
    enabled: true,
    appinsights_enabled: true,
    appinsights_browser_enabled: true,
    appinsights_keychain: "azure/appinsights-connection-string",
  })).toBe(true);
  expect(isBrowserTelemetryConfigEnabled({
    enabled: true,
    appinsights_enabled: true,
    appinsights_browser_enabled: false,
    appinsights_keychain: "azure/appinsights-connection-string",
  })).toBe(false);
});

test("web entry does not install browser telemetry wrappers directly at load", () => {
  const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
  expect(source).toContain("void bootstrapBrowserTelemetryIfEnabled()");
  expect(source).not.toMatch(/try\s*{\s*installObservabilityFetchHeaders\(\)/);
  expect(source).not.toMatch(/try\s*{\s*installAgentTelemetry\(\)/);
});

test("deriveTelemetryEventsFromSse maps followup lifecycle events", () => {
  const events = deriveTelemetryEventsFromSse("agent_followup_queued", {
    chat_jid: "web:default",
    turn_id: "turn-2",
  }, {});
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    name: "agent.followup.queued",
    chatJid: "web:default",
    turnId: "turn-2",
  });
});

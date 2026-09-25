import { expect } from "bun:test";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type StepDefinition = { pattern: string; handler: () => Promise<void> | void };

interface HostFixture {
  url: string;
  reviewDb: string;
  ownerMarker: string;
  providerRequests: () => number;
}

/** Execute the canonical CR-077 Background and steps against an authenticated disposable host. */
export async function runCr077Scenario(fixture: HostFixture): Promise<string> {
  const feature = readFileSync(resolve(import.meta.dir, "../../../../specs/code-review/features/08-security-and-accessibility.feature"), "utf8");
  const background: string[] = [];
  const scenario: string[] = [];
  let section = "";
  let found = false;
  for (const raw of feature.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("Background:")) section = "background";
    else if (line.startsWith("Scenario:")) {
      section = line.startsWith("Scenario: CR-077 ") ? "scenario" : "other";
      if (section === "scenario") found = true;
    } else if (/^(Given|When|Then|And|But)\s+/.test(line)) {
      if (section === "background") background.push(line);
      if (section === "scenario") scenario.push(line);
    }
  }
  expect(found).toBe(true);
  expect(background.length).toBe(2);
  expect(scenario.length).toBe(3);
  const results: Array<{ status: number; error: string; expected: number }> = [];
  let cookie = "";
  const actionUrl = fixture.url + "/agent/addons/api/code-review/action";
  const post = async (body: object, origin: string, session = "") => {
    const response = await fetch(actionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...(session ? { Cookie: session } : {}) },
      body: JSON.stringify(body),
    });
    const payload = await response.json() as { error?: string };
    return { status: response.status, error: payload.error ?? "" };
  };
  const steps: StepDefinition[] = [
    { pattern: "Code Review is running in a disposable supported single-operator workspace", async handler() {
      const login = await fetch(fixture.url + "/login");
      expect(login.status).toBe(200);
      const anonymousRead = await fetch(fixture.url + "/workspace/raw?path=fixture-owner.txt", { redirect: "manual" });
      expect(anonymousRead.status).toBeGreaterThanOrEqual(300);
      expect(anonymousRead.status).toBeLessThan(400);
    } },
    { pattern: "its pane uses authenticated local add-on APIs", async handler() {
      // Base32 ORSXG5A decodes to "test"; this credential exists only in the disposable fixture.
      const counter = Buffer.alloc(8);
      counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
      const digest = createHmac("sha1", Buffer.from("test")).update(counter).digest();
      const offset = digest[19]! & 15;
      const code = ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
      const login = await fetch(fixture.url + "/auth/verify", {
        method: "POST", headers: { "Content-Type": "application/json", Origin: fixture.url },
        body: JSON.stringify({ code }),
      });
      expect(login.status).toBe(200);
      cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
      expect(cookie.startsWith("piclaw_session=")).toBe(true);
      const read = await fetch(fixture.url + "/workspace/raw?path=fixture-owner.txt", { headers: { Cookie: cookie } });
      expect(read.status).toBe(200);
      expect(await read.text()).toBe(fixture.ownerMarker);
    } },
    { pattern: "an unauthenticated or cross-origin caller attempts to create or edit a comment", async handler() {
      const actions = [
        { action: "create", path: "review-fixture.ts", target: { agentName: "worker" }, requestId: "denied-create" },
        { action: "edit", messageId: "guessed", body: "forged", expectedVersion: 1, requestId: "denied-edit" },
      ];
      for (const action of actions) {
        results.push({ ...(await post(action, fixture.url)), expected: 401 });
        results.push({ ...(await post(action, "https://evil.example", cookie)), expected: 403 });
      }
    } },
    { pattern: "host authentication and request-origin protections reject it", handler() {
      expect(results).toHaveLength(4);
      for (const result of results) {
        expect(result.status).toBe(result.expected);
        expect(result.error).toBe(result.expected === 401 ? "Unauthorized" : "Origin not allowed");
      }
    } },
    { pattern: "no review data or execution request is created", handler() {
      expect(existsSync(fixture.reviewDb)).toBe(false);
      expect(fixture.providerRequests()).toBe(0);
    } },
  ];
  for (const step of [...background, ...scenario]) {
    const text = step.replace(/^(Given|When|Then|And|But)\s+/, "");
    const matching = steps.filter((definition) => definition.pattern === text);
    if (matching.length !== 1) throw Error(`Expected one CR-077 step handler for: ${step}; found ${matching.length}`);
    await matching[0]!.handler();
  }
  return cookie;
}

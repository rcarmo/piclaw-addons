import { expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type HostFixture = { url: string; reviewDb: string; cookie: string; providerRequests: () => number };
type Counts = { reviews: number; messages: number; dispatches: number; attempts: number; receipts: number; agentMessages: number };

/** Execute canonical CR-078 steps after the authenticated browser creates a genuine comment. */
export async function runCr078Scenario(fixture: HostFixture): Promise<void> {
  const feature = readFileSync(resolve(import.meta.dir, "../../../../specs/code-review/features/08-security-and-accessibility.feature"), "utf8");
  const background: string[] = [], scenario: string[] = [];
  let section = "", found = false;
  for (const raw of feature.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("Background:")) section = "background";
    else if (line.startsWith("Scenario:")) {
      section = line.startsWith("Scenario: CR-078 ") ? "scenario" : "other";
      if (section === "scenario") found = true;
    } else if (/^(Given|When|Then|And|But)\s+/.test(line)) {
      if (section === "background") background.push(line);
      if (section === "scenario") scenario.push(line);
    }
  }
  expect(found).toBe(true);
  expect(background.length).toBe(2);
  expect(scenario.length).toBe(4);
  const db = new Database(fixture.reviewDb, { readonly: true });
  try {
    const count = (table: string) => (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const counts = (): Counts => ({
      reviews: count("reviews"), messages: count("messages"), dispatches: count("dispatches"),
      attempts: count("attempts"), receipts: count("request_receipts"),
      agentMessages: (db.query("SELECT COUNT(*) AS n FROM messages WHERE author_kind='agent'").get() as { n: number }).n,
    });
    let before: Counts | null = null;
    let reviewId = "";
    const results: Array<{ ok: boolean; code?: string }> = [];
    const post = async (body: object) => {
      const response = await fetch(fixture.url + "/agent/addons/api/code-review/action", {
        method: "POST", headers: { "Content-Type": "application/json", Origin: fixture.url, Cookie: fixture.cookie },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200); // The add-on API encloses domain errors in its response.
      return response.json() as Promise<{ ok: boolean; error?: { code?: string }; result?: any }>;
    };
    const handlers: Record<string, () => Promise<void> | void> = {
      "Code Review is running in a disposable supported single-operator workspace": () => {
        expect(count("reviews")).toBe(1);
        expect(count("messages")).toBe(1);
        expect(count("attempts")).toBe(0);
      },
      "its pane uses authenticated local add-on APIs": async () => {
        const response = await post({ action: "list", limit: 10 });
        expect(response.ok).toBe(true);
        expect(JSON.stringify(response.result)).toContain("review-fixture.ts");
        const review = db.query("SELECT id FROM reviews LIMIT 1").get() as { id: string };
        reviewId = review.id;
        before = counts();
      },
      "a client supplies another author identity or an unauthorised target in a request body": async () => {
        for (const [key, value] of [["actorId", "forged-agent"], ["kind", "agent"], ["ownerId", "forged-owner"]] as const) {
          const thread = db.query("SELECT id FROM threads WHERE review_id=? LIMIT 1").get(reviewId) as { id: string };
          const result = await post({ action: "reply", threadId: thread.id, body: "forged agent reply", expectedVersion: 1, assignmentEpoch: 1, requestId: `forged-${key}`, [key]: value });
          results.push({ ok: result.ok, code: result.error?.code });
        }
        const invalid = await post({ action: "target", reviewId, target: { chatId: "web:unrelated:forged" }, expectedVersion: 1, requestId: "foreign-target" });
        results.push({ ok: invalid.ok, code: invalid.error?.code });
        // A guessed dispatch must not reach the host queue either.
        const send = await post({ action: "send", reviewId, target: { chatId: "web:unrelated:forged" }, items: [{ threadId: (db.query("SELECT id FROM threads LIMIT 1").get() as { id: string }).id, version: 1 }], requestId: "foreign-send" });
        results.push({ ok: send.ok, code: send.error?.code });
      },
      "the server rejects the forged identity or target": () => {
        expect(results.map((r) => r.code)).toEqual(["forbidden", "forbidden", "forbidden", "target_unavailable", "target_unavailable"]);
        expect(results.every((r) => !r.ok)).toBe(true);
      },
      "no user comment is recorded as an agent message": () => {
        expect(before).not.toBeNull();
        expect(counts()).toEqual(before!);
        expect(count("messages")).toBe(1);
        const author = db.query("SELECT author_kind,author_id FROM messages LIMIT 1").get() as { author_kind: string; author_id: string };
        expect(author.author_kind).toBe("operator");
        expect(author.author_id).not.toBe("forged-agent");
      },
      "no unrelated chat is queued": () => {
        expect(count("dispatches")).toBe(0);
        expect(count("attempts")).toBe(0);
        expect(fixture.providerRequests()).toBe(0);
        expect(before).not.toBeNull();
        expect(counts()).toEqual(before!);
      },
    };
    for (const step of [...background, ...scenario]) {
      const text = step.replace(/^(Given|When|Then|And|But)\s+/, "");
      const handler = handlers[text];
      if (!handler) throw Error(`No CR-078 step handler: ${step}`);
      await handler();
    }
  } finally { db.close(); }
}

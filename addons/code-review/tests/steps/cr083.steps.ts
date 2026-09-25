import { expect } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LIMITS } from "../../contracts.js";

type HostFixture = { url: string; workspace: string; reviewDb: string; cookie: string; providerRequests: () => number };

/** Execute the bounded-source/comment CR-083 steps against a disposable authenticated host. */
export async function runCr083Scenario(fixture: HostFixture): Promise<void> {
  const feature = readFileSync(resolve(import.meta.dir, "../../../../specs/code-review/features/08-security-and-accessibility.feature"), "utf8");
  const background: string[] = [], scenario: string[] = [];
  let section = "", found = false;
  for (const raw of feature.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("Background:")) section = "background";
    else if (line.startsWith("Scenario:")) {
      section = line.startsWith("Scenario: CR-083 ") ? "scenario" : "other";
      if (section === "scenario") found = true;
    } else if (/^(Given|When|Then|And|But)\s+/.test(line)) {
      if (section === "background") background.push(line);
      if (section === "scenario") scenario.push(line);
    }
  }
  expect(found).toBe(true);
  expect(background.length).toBe(2);
  expect(scenario.length).toBe(5);
  const db = new Database(fixture.reviewDb, { readonly: true });
  try {
    const count = (table: string) => (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const counts = () => ["reviews", "snapshots", "blobs", "threads", "messages", "message_revisions", "dispatches", "attempts", "request_receipts"].map(count);
    const review = db.query("SELECT id,target_json FROM reviews LIMIT 1").get() as { id: string; target_json: string };
    const { chatId, incarnation } = JSON.parse(review.target_json) as { chatId: string; incarnation: string };
    const thread = db.query("SELECT id FROM threads WHERE review_id=? LIMIT 1").get(review.id) as { id: string };
    let before: number[] = [];
    const results: Array<{ ok: boolean; code?: string; message?: string }> = [];
    const post = async (body: object) => {
      const response = await fetch(fixture.url + "/agent/addons/api/code-review/action", {
        method: "POST", headers: { "Content-Type": "application/json", Origin: fixture.url, Cookie: fixture.cookie }, body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      return response.json() as Promise<{ ok: boolean; error?: { code?: string; message?: string }; result?: any }>;
    };
    const handlers: Record<string, () => Promise<void> | void> = {
      "Code Review is running in a disposable supported single-operator workspace": () => {
        expect(count("reviews")).toBe(1);
        expect(count("threads")).toBe(1);
      },
      "its pane uses authenticated local add-on APIs": async () => {
        expect((await post({ action: "list", limit: 10 })).ok).toBe(true);
        before = counts();
      },
      "a source snapshot, diff or comment exceeds the documented limits": () => {
        writeFileSync(join(fixture.workspace, "over-limit.ts"), "x".repeat(LIMITS.fileBytes + 1));
        // CR-081 intentionally left a hostile helper in this owned Git fixture.
        // Disable it for fixture setup, then let SourceReader enforce its own Git isolation.
        const git = (...args: string[]) => execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "diff.external=", ...args], {
          cwd: fixture.workspace, encoding: "utf8", env: { PATH: process.env.PATH!, HOME: fixture.workspace, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
        });
        writeFileSync(join(fixture.workspace, "over-diff.ts"), "initial\n");
        git("add", "--", "over-diff.ts");
        git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "-qm", "bounded baseline");
        writeFileSync(join(fixture.workspace, "over-diff.ts"), "one\n".repeat(LIMITS.diffLines + 1));
        expect(Buffer.byteLength("é".repeat(LIMITS.commentBytes / 2 + 1))).toBeGreaterThan(LIMITS.commentBytes);
      },
      "it is read or submitted": async () => {
        const target = { chatId, incarnation };
        const huge = await post({ action: "create", path: "over-limit.ts", target, requestId: "oversize-source" });
        results.push({ ok: huge.ok, code: huge.error?.code, message: huge.error?.message });
        const diff = await post({ action: "create", path: "over-diff.ts", mode: "unstaged", target, requestId: "oversize-diff" });
        results.push({ ok: diff.ok, code: diff.error?.code, message: diff.error?.message });
        const longComment = await post({ action: "reply", threadId: thread.id, body: "é".repeat(LIMITS.commentBytes / 2 + 1), expectedVersion: 1, requestId: "oversize-comment" });
        results.push({ ok: longComment.ok, code: longComment.error?.code, message: longComment.error?.message });
      },
      "a bounded limit state identifies the unsupported content": () => {
        expect(results).toHaveLength(3);
        expect(results.every((r) => !r.ok)).toBe(true);
        expect(results.map((r) => r.code)).toEqual(["limit", "limit", "invalid_input"]);
        expect(results[0]!.message).toContain("byte limit");
        expect(results[1]!.message).toContain("computation budget");
        expect(results[2]!.message).toContain(String(LIMITS.commentBytes));
      },
      "stored guidance is not silently truncated or exposed through unrestricted downloads": async () => {
        expect(counts()).toEqual(before);
        const guessed = await post({ action: "file", reviewId: review.id, fileId: "over-limit.ts", limit: 1000 });
        expect(guessed.ok).toBe(false);
        expect(guessed.error?.code).toBe("not_found");
        const existing = db.query("SELECT id FROM snapshot_files WHERE review_id=? LIMIT 1").get(review.id) as { id: string };
        const unbounded = await post({ action: "file", reviewId: review.id, fileId: existing.id, limit: 1001 });
        expect(unbounded.ok).toBe(false);
        expect(unbounded.error?.code).toBe("invalid_input");
        expect(counts()).toEqual(before);
      },
      "existing threads remain accessible where authorised": async () => {
        const result = await post({ action: "thread", threadId: thread.id });
        expect(result.ok).toBe(true);
        expect(result.result.messages).toHaveLength(1);
        expect(result.result.messages[0].body).toBe("Validate empty strings before trimming.");
        expect(counts()).toEqual(before);
        expect(fixture.providerRequests()).toBe(0);
      },
    };
    for (const step of [...background, ...scenario]) {
      const text = step.replace(/^(Given|When|Then|And|But)\s+/, "");
      const handler = handlers[text];
      if (!handler) throw Error(`No CR-083 step handler: ${step}`);
      await handler();
    }
  } finally { db.close(); }
}

import { expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";

type HostFixture = { url: string; workspace: string; reviewDb: string; cookie: string; providerRequests: () => number };

/** Execute canonical CR-081 steps on an owned authenticated Classic host. */
export async function runCr081Scenario(fixture: HostFixture): Promise<void> {
  const feature = readFileSync(resolve(import.meta.dir, "../../../../specs/code-review/features/08-security-and-accessibility.feature"), "utf8");
  const background: string[] = [], scenario: string[] = [];
  let section = "", found = false;
  for (const raw of feature.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("Background:")) section = "background";
    else if (line.startsWith("Scenario:")) {
      section = line.startsWith("Scenario: CR-081 ") ? "scenario" : "other";
      if (section === "scenario") found = true;
    } else if (/^(Given|When|Then|And|But)\s+/.test(line)) {
      if (section === "background") background.push(line);
      if (section === "scenario") scenario.push(line);
    }
  }
  expect(found).toBe(true);
  expect(background.length).toBe(2);
  expect(scenario.length).toBe(3);
  const db = new Database(fixture.reviewDb, { readonly: true });
  const marker = join(fixture.workspace, "git-side-effect-marker.txt");
  const helper = join(fixture.workspace, "git-side-effect.sh");
  try {
    const count = (table: string) => (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const counts = () => ["reviews", "snapshots", "messages", "dispatches", "attempts", "request_receipts"].map(count);
    let before: number[] = [];
    const selected = db.query("SELECT target_json FROM reviews LIMIT 1").get() as { target_json: string };
    const { chatId, incarnation } = JSON.parse(selected.target_json) as { chatId: string; incarnation: string };
    expect(chatId).toBeTruthy();
    expect(incarnation).toBeTruthy();
    const target = { chatId, incarnation };
    const results: Array<{ ok: boolean; code?: string; status: number }> = [];
    const post = async (body: object) => {
      const response = await fetch(fixture.url + "/agent/addons/api/code-review/action", {
        method: "POST", headers: { "Content-Type": "application/json", Origin: fixture.url, Cookie: fixture.cookie },
        body: JSON.stringify(body),
      });
      const payload = await response.json() as { ok: boolean; error?: { code?: string } };
      return { status: response.status, ok: payload.ok, code: payload.error?.code };
    };
    const handlers: Record<string, () => Promise<void> | void> = {
      "Code Review is running in a disposable supported single-operator workspace": () => {
        expect(count("reviews")).toBe(1);
        expect(count("messages")).toBe(1);
      },
      "its pane uses authenticated local add-on APIs": async () => {
        const listed = await post({ action: "list", limit: 10 });
        expect(listed).toMatchObject({ status: 200, ok: true });
        before = counts();
      },
      "a request supplies a traversal path, a symlink escape or a crafted revision argument": async () => {
        // Never alter a real repository; all Git config and helper artifacts are fixture-owned.
        const git = (...args: string[]) => execFileSync("git", args, {
          cwd: fixture.workspace, encoding: "utf8", env: { PATH: process.env.PATH!, HOME: fixture.workspace, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
        });
        git("init", "-q");
        writeFileSync(helper, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\nexit 1\n`);
        chmodSync(helper, 0o755);
        git("config", "diff.external", helper);
        git("config", "core.fsmonitor", helper);
        symlinkSync("/etc/hosts", join(fixture.workspace, "escape-link.ts"));
        results.push(await post({ action: "create", path: "../escape", target, requestId: "traversal" }));
        results.push(await post({ action: "create", path: "escape-link.ts", target, requestId: "symlink-escape" }));
        results.push(await post({ action: "create", path: ".", mode: "commit", commit: "--output=/tmp/evil", target, requestId: "crafted-revision" }));
      },
      "source and diff reads are rejected before filesystem or Git side effects": () => {
        expect(results).toHaveLength(3);
        expect(results.every((result) => result.status === 200 && !result.ok)).toBe(true);
        expect(results.map((result) => result.code)).toEqual(["unsafe_path", "unsafe_path", "invalid_revision"]);
        expect(counts()).toEqual(before);
        expect(fixture.providerRequests()).toBe(0);
      },
      "no shell interpolation, external diff driver or text conversion command executes": () => {
        expect(existsSync(marker)).toBe(false);
        expect(counts()).toEqual(before);
        expect(fixture.providerRequests()).toBe(0);
      },
    };
    for (const step of [...background, ...scenario]) {
      const text = step.replace(/^(Given|When|Then|And|But)\s+/, "");
      const handler = handlers[text];
      if (!handler) throw Error(`No CR-081 step handler: ${step}`);
      await handler();
    }
  } finally { db.close(); }
}

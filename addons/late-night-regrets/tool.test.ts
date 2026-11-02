import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLateNightRegrets, readExchanges } from "./native.js";
import { normaliseConfig } from "./config.js";

test("native tool uses host-owned history/config/model ports once and preserves the original packet plus usage", async () => {
  const root = mkdtempSync(join(tmpdir(), "regrets-tool-")), path = join(root, "fixture.db");
  const db = new Database(path);
  db.run("CREATE TABLE messages(chat_jid TEXT,sender TEXT,sender_name TEXT,content TEXT,timestamp TEXT,is_bot_message INTEGER,content_blocks TEXT,thread_id INTEGER,content_erased INTEGER DEFAULT 0)");
  const timestamp = new Date(Date.now() - 5000).toISOString();
  for (const [chat, content] of [["web:fixture", "plain English"], ["web:other", "private other chat"]])
    db.run("INSERT INTO messages VALUES(?,'web-user','Human',?, ?,0,NULL,NULL,0)", [chat!, content!, timestamp]);
  db.close();
  let config = normaliseConfig({ enabled: true, decision_model: "fixture/small", review_scope: "current" });
  let calls = 0, current = true;
  const native = createLateNightRegrets({ chat: 'web:fixture', cwd: root,
    assertCurrent() { if (!current) throw Error('Current chat authority revoked'); }, assertSingleUser() {},
    config: { get: () => config, set(value) { config = value; } },
    async history(window) { return readExchanges(path, window); }, async readFile() { return undefined; },
    accountedDecision: { getAvailable: () => [{ provider: 'fixture', id: 'small', maxTokens: 4096, contextWindow: 32000 } as any],
      async complete() { calls++; return { stopReason: 'stop', content: [{ type: 'text', text: '{"decisions":[{"rowid":1,"choice":"routine"}]}' }], usage: { input: 1, output: 1, totalTokens: 2 } } as any; } },
    async admitConversationInput() { throw Error('Tool must not admit input'); },
  });
  try {
    const result = await native.tool.execute('id', {});
    expect(calls).toBe(1);
    expect(result.details).toHaveProperty('packet.exchanges.length', 1);
    expect(result.details).toHaveProperty('packet.exchanges.0.target.content', 'plain English');
    expect(result.details).toHaveProperty('decision.status', 'complete');
    expect(result).toHaveProperty('usage.totalTokens', 2);
    expect(JSON.stringify(result)).not.toContain('private other chat');
    config = normaliseConfig({ enabled: false }, config);
    expect((await native.tool.execute('id', {})).details).toEqual({ disabled: true });
    current = false;
    await expect(native.tool.execute('id', {})).rejects.toThrow('Current chat');
    expect(calls).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("setup migrates only the explicit chat's agent task, leaving internal and other-chat tasks alone", async () => {
  const root = mkdtempSync(join(tmpdir(), "regrets-setup-"));
  try {
    const db = new Database(join(root, "messages.db"));
    db.run(
      "CREATE TABLE tasks(id TEXT,chat_jid TEXT,status TEXT,task_kind TEXT,prompt TEXT,schedule_value TEXT,created_at TEXT,next_run TEXT)",
    );
    for (const [id, chat, kind] of [
      ["target", "web:test", "agent"],
      ["other", "web:other", "agent"],
      ["internal", "web:test", "internal"],
    ])
      db.run(
        "INSERT INTO tasks VALUES(?,?,'active',?,'Late Night Regrets old three-flag prompt','30 2 * * *','2026-01-01',NULL)",
        [id!, chat!, kind!],
      );
    db.close();
    const proc = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "scripts/setup-nightly-task.ts"),
        "--chat-jid",
        "web:test",
      ],
      {
        env: { ...process.env, PICLAW_STORE: root },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
    expect(proc.exitCode).toBe(0);
    const verify = new Database(join(root, "messages.db"), { readonly: true });
    try {
      const rows = verify
        .query<{ id: string; prompt: string }, []>(
          "SELECT id,prompt FROM tasks ORDER BY id",
        )
        .all();
      expect(rows.find((r) => r.id === "target")!.prompt).toContain(
        "Call regrets_review",
      );
      expect(
        rows
          .filter((r) => r.id !== "target")
          .every(
            (r) => r.prompt === "Late Night Regrets old three-flag prompt",
          ),
      ).toBe(true);
    } finally {
      verify.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

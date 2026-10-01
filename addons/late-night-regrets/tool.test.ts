import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import addon from "./index.js";
import { saveConfig } from "./config.js";

test("registered tool reads current chat, calls selected model once and returns original packet plus usage", async () => {
  const root = mkdtempSync(join(tmpdir(), "regrets-tool-")),
    path = join(root, "messages.db");
  const priorStore = process.env.PICLAW_STORE,
    priorBridge = (globalThis as any).__piclawRuntimeInterop;
  const db = new Database(path);
  db.run(
    "CREATE TABLE messages(chat_jid TEXT,sender TEXT,sender_name TEXT,content TEXT,timestamp TEXT,is_bot_message INTEGER,content_blocks TEXT,thread_id INTEGER,content_erased INTEGER DEFAULT 0)",
  );
  const timestamp = new Date(Date.now() - 5000).toISOString();
  db.run(
    "INSERT INTO messages VALUES('web:fixture','web-user','Human','plain English',?,0,NULL,NULL,0)",
    [timestamp],
  );
  db.run(
    "INSERT INTO messages VALUES('web:other','web-user','Human','private other chat',?,0,NULL,NULL,0)",
    [timestamp],
  );
  db.close();
  process.env.PICLAW_STORE = root;
  (globalThis as any).__piclawRuntimeInterop = {
    getChatJid: () => "web:fixture",
  };
  try {
    let tool: any;
    addon({
      on() {},
      registerCommand() {},
      registerTool(t: any) {
        tool = t;
      },
    } as any);
    saveConfig({
      enabled: true,
      decision_model: "fixture/small",
      review_scope: "current",
    });
    let calls = 0;
    const result = await tool.execute("id", {}, undefined, undefined, {
      cwd: root,
      modelRegistry: {
        getAvailable: () => [
          {
            provider: "fixture",
            id: "small",
            maxTokens: 4096,
            contextWindow: 32000,
          },
        ],
        complete: async () => {
          calls++;
          return {
            stopReason: "stop",
            content: [
              {
                type: "text",
                text: '{"decisions":[{"rowid":1,"choice":"routine"}]}',
              },
            ],
            usage: { input: 1, output: 1, totalTokens: 2 },
          };
        },
      },
    });
    expect(calls).toBe(1);
    expect(result.details.packet.exchanges).toHaveLength(1);
    expect(result.details.packet.exchanges[0].target.content).toBe(
      "plain English",
    );
    expect(result.details.decision.status).toBe("complete");
    expect(result.usage.totalTokens).toBe(2);
    expect(JSON.stringify(result)).not.toContain("private other chat");
    saveConfig({ enabled: false });
    expect(
      (await tool.execute("id", {}, undefined, undefined, {})).details.disabled,
    ).toBe(true);
    saveConfig({ enabled: true });
    (globalThis as any).__piclawRuntimeInterop = {};
    await expect(
      tool.execute("id", {}, undefined, undefined, {}),
    ).rejects.toThrow("Current chat");
  } finally {
    saveConfig({ enabled: true, decision_model: "", review_scope: "all" });
    if (priorStore === undefined) delete process.env.PICLAW_STORE;
    else process.env.PICLAW_STORE = priorStore;
    (globalThis as any).__piclawRuntimeInterop = priorBridge;
    rmSync(root, { recursive: true, force: true });
  }
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

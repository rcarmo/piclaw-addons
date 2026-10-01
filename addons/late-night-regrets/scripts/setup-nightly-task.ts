#!/usr/bin/env bun
/**
 * setup-nightly-task.ts
 *
 * Creates or updates the Late Night Regrets nightly scheduled task.
 * Safe to run repeatedly — it will find and update an existing task
 * rather than creating duplicates.
 *
 * Usage:
 *   bun run <addon-path>/scripts/setup-nightly-task.ts [options]
 *
 * Options:
 *   --cron <expr>              Cron schedule (default: "30 2 * * *")
 *   --chat-jid <jid>          Target chat (default: "web:default")
 *   --retrain                  Force a retrain before creating the task
 *   --remove                   Remove the existing task instead of creating
 *   --help, -h                Show help
 */

import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { reflectionPrompt } from "../reflection-prompt.js";
import { CronExpressionParser } from "cron-parser";

const baseDir = dirname(fileURLToPath(import.meta.url));
const addonDir = dirname(baseDir);
const trainScript = join(baseDir, "train-interaction-quality-bayes.ts");

const DEFAULT_DB = `${process.env.PICLAW_STORE || "/workspace/.piclaw/store"}/messages.db`;
const DEFAULT_CRON = "30 2 * * *";
const DEFAULT_CHAT = "web:default";
const TASK_TAG = "late-night-regrets"; // used to find existing task

function helpAndExit(): never {
  console.log("Usage: bun run setup-nightly-task.ts [options]");
  console.log("");
  console.log(`  --cron <expr>        Cron schedule (default: "${DEFAULT_CRON}")`);
  console.log(`  --chat-jid <jid>     Target chat (default: "${DEFAULT_CHAT}")`);
  console.log("  --retrain            Force retrain before creating the task");
  console.log("  --remove             Remove the existing task");
  console.log("  --help, -h           Show help");
  process.exit(0);
}

if (Bun.argv.includes("--help") || Bun.argv.includes("-h")) helpAndExit();

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    cron: { type: "string", default: DEFAULT_CRON },
    "chat-jid": { type: "string", default: DEFAULT_CHAT },
    retrain: { type: "boolean", default: false },
    remove: { type: "boolean", default: false },
  },
  strict: true,
});

const CRON = values.cron!;
const CHAT_JID = values["chat-jid"]!;
const RETRAIN = values.retrain!;
const REMOVE = values.remove!;

// ── Find existing task ───────────────────────────────────────────────

interface TaskRow {
  id: string;
  status: string;
  schedule_value: string;
  prompt: string;
}

function findExistingTask(db: Database): TaskRow | null {
  const rows = db.query<TaskRow, [string]>(
    `SELECT id, status, schedule_value, prompt FROM tasks
     WHERE (prompt LIKE '%interaction quality%' OR prompt LIKE '%late-night-regrets%' OR prompt LIKE '%Late Night Regrets%')
       AND task_kind = 'agent' AND chat_jid = ?
       AND status IN ('active', 'paused')
     ORDER BY created_at DESC
     LIMIT 1`
  ).all(CHAT_JID);
  return rows[0] || null;
}

// ── Build the agent prompt ───────────────────────────────────────────

const buildReflectionPrompt = reflectionPrompt;

// ── Main ─────────────────────────────────────────────────────────────

const db = new Database(DEFAULT_DB, { readwrite: true, create: false });
const existing = findExistingTask(db);

if (REMOVE) {
  if (!existing) {
    console.log("No existing Late Night Regrets task found. Nothing to remove.");
    db.close();
    process.exit(0);
  }
  db.run(`UPDATE tasks SET status = 'deleted' WHERE id = ?`, [existing.id]);
  console.log(`Removed task ${existing.id}`);
  db.close();
  process.exit(0);
}

if (RETRAIN) {
  console.log("Retraining classifier before task setup...");
  const proc = Bun.spawnSync(["bun", "run", trainScript], {
    cwd: addonDir,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (proc.exitCode !== 0) {
    console.error("Retrain failed. Continuing with task setup anyway.");
  }
}

const prompt = buildReflectionPrompt();
// Invalid schedules fail rather than silently falling back to another time.
const nextRun = CronExpressionParser.parse(CRON, { tz: "UTC" }).next().toISOString();

if (existing) {
  // Update the existing task
  db.run(
    `UPDATE tasks SET schedule_value = ?, prompt = ?, next_run = ?, status = 'active' WHERE id = ?`,
    [CRON, prompt, nextRun, existing.id]
  );
  console.log(`Updated existing task ${existing.id}`);
  console.log(`  Schedule: ${CRON}`);
  console.log(`  Chat: ${CHAT_JID}`);
  console.log(`  Status: active`);
} else {
  // Create a new task
  const id = `task-late-night-regrets-${Date.now()}`;
  const now = new Date().toISOString();

  db.run(
    `INSERT INTO tasks (id, chat_jid, prompt, model, task_kind, command, cwd, timeout_sec, schedule_type, schedule_value, next_run, status, created_at)
     VALUES (?, ?, ?, NULL, 'agent', NULL, NULL, NULL, 'cron', ?, ?, 'active', ?)`,
    [id, CHAT_JID, prompt, CRON, nextRun, now]
  );
  console.log(`Created new task ${id}`);
  console.log(`  Schedule: ${CRON}`);
  console.log(`  Chat: ${CHAT_JID}`);
  console.log(`  Next run: ${nextRun}`);
}

db.close();
console.log("\nDone. The nightly reflection task is active.");
console.log(`Classifier script: ${trainScript}`);

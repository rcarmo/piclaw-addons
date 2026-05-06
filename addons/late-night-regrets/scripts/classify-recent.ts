#!/usr/bin/env bun
/**
 * classify-recent.ts
 *
 * Lightweight nightly classifier: loads saved model weights, classifies
 * recent messages, writes attention-worthy predictions. No training.
 *
 * Usage:
 *   bun run <addon>/scripts/classify-recent.ts [options]
 *
 * Options:
 *   --db <path>               SQLite DB path
 *   --weights <path>          Model weights JSON
 *   --out-dir <path>          Output directory
 *   --recent-hours <n>        Lookback window (default: 24)
 *   --confidence <n>          Min confidence for attention-worthy (default: 0.55)
 *   --lookback-window <n>     Context messages for features (default: 4)
 *   --help, -h                Show help
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

// ── Types ────────────────────────────────────────────────────────────

interface MessageRow {
  rowid: number;
  chat_jid: string;
  sender: string;
  sender_name: string;
  timestamp: string;
  content: string;
}

interface Model {
  classes: string[];
  classDocCounts: Record<string, number>;
  classTokenTotals: Record<string, number>;
  tokenCounts: Record<string, Record<string, number>>;
  vocab: string[];
  alpha: number;
  totalDocs: number;
  logPriors: Record<string, number>;
}

interface Prediction {
  rowid: number;
  timestamp: string;
  chat_jid: string;
  sender: string;
  predicted_label: string;
  confidence: number;
  message_preview: string;
  preceding_agent_preview: string;
}

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_DB = `${process.env.PICLAW_STORE || "/workspace/.piclaw/store"}/messages.db`;
const DEFAULT_WEIGHTS = "/workspace/exports/interaction-quality/interaction-quality-weights-latest.json";
const DEFAULT_OUT = "/workspace/exports/interaction-quality";

const STOPWORDS = new Set([
  "the","and","for","that","with","this","from","have","your","you","are","was","were","will","would",
  "can","could","should","has","had","not","but","all","any","our","out","into","about","just","here",
  "then","than","them","they","their","there","what","when","where","which","while","also","been","after",
  "before","over","under","more","most","some","very","much","many","how","why","who","did","does","done",
  "let","lets","its","it","to","of","in","on","at","as","by","an","a","is","be","or","if","we",
  "i","me","my","so","no","yes","ok","now","up","off","do","go","get","got","ll","ve","re",
]);

// ── CLI ──────────────────────────────────────────────────────────────

function helpAndExit(): never {
  console.log("Usage: bun run classify-recent.ts [options]");
  console.log("");
  console.log(`  --db <path>               SQLite DB path (default: ${DEFAULT_DB})`);
  console.log(`  --weights <path>          Weights JSON (default: ${DEFAULT_WEIGHTS})`);
  console.log(`  --out-dir <path>          Output directory (default: ${DEFAULT_OUT})`);
  console.log("  --recent-hours <n>        Lookback window (default: 24)");
  console.log("  --confidence <n>          Min confidence for attention (default: 0.55)");
  console.log("  --lookback-window <n>     Context messages (default: 4)");
  console.log("  --help, -h                Show help");
  process.exit(0);
}

if (Bun.argv.includes("--help") || Bun.argv.includes("-h")) helpAndExit();

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    db: { type: "string", default: DEFAULT_DB },
    weights: { type: "string", default: DEFAULT_WEIGHTS },
    "out-dir": { type: "string", default: DEFAULT_OUT },
    "recent-hours": { type: "string", default: "24" },
    confidence: { type: "string", default: "0.55" },
    "lookback-window": { type: "string", default: "4" },
  },
  strict: true,
});

const DB_PATH = values.db!;
const WEIGHTS_PATH = values.weights!;
const OUT_DIR = values["out-dir"]!;
const RECENT_HOURS = Math.max(1, Number(values["recent-hours"] || "24"));
const CONFIDENCE_THRESHOLD = Math.max(0.1, Math.min(1, Number(values.confidence || "0.55")));
const LOOKBACK_WINDOW = Math.max(1, Number(values["lookback-window"] || "4"));

// ── Load model ───────────────────────────────────────────────────────

if (!existsSync(WEIGHTS_PATH)) {
  console.error(`Weights not found: ${WEIGHTS_PATH}`);
  console.error("Run the training script first: bun run scripts/train-interaction-quality-bayes.ts");
  process.exit(2);
}

const weightsPayload = JSON.parse(readFileSync(WEIGHTS_PATH, "utf-8"));
const model: Model = weightsPayload.model;

if (!model || !model.classes || !model.logPriors) {
  console.error("Invalid weights file — missing model structure.");
  process.exit(2);
}

console.log(`Loaded model: ${model.classes.length} classes, ${model.vocab.length} vocab, trained on ${model.totalDocs} docs`);

// ── Tokenization ─────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  const lower = text
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ");

  const raw = lower.match(/[a-z][a-z0-9_\-./:]{1,}/g) || [];
  const tokens: string[] = [];
  for (const tok of raw) {
    if (tok.length < 2) continue;
    if (/^\d+$/.test(tok)) continue;
    if (STOPWORDS.has(tok)) continue;
    tokens.push(tok);
  }
  return tokens;
}

function buildFeatureTokens(msg: MessageRow, prevMessages: MessageRow[]): string[] {
  const base = tokenize(msg.content);
  const features = [...base];

  for (let i = 0; i < base.length - 1; i++) {
    features.push(`${base[i]}__${base[i + 1]}`);
  }

  const trimmed = msg.content.trim();
  const len = trimmed.length;
  if (len <= 20) features.push("__len_tiny");
  else if (len <= 80) features.push("__len_short");
  else if (len <= 250) features.push("__len_medium");
  else features.push("__len_long");

  if (trimmed.endsWith("?")) features.push("__ends_question");
  if (trimmed.endsWith("!")) features.push("__ends_exclamation");
  if (trimmed.startsWith("/")) features.push("__slash_command");

  if (prevMessages.length > 0) {
    const prev = prevMessages[prevMessages.length - 1];
    const prevIsAgent = prev.sender !== msg.sender;
    features.push(prevIsAgent ? "__after_agent" : "__after_user");

    if (prevIsAgent) {
      const prevLen = (prev.content || "").length;
      if (prevLen > 2000) features.push("__prev_agent_very_long");
      else if (prevLen > 500) features.push("__prev_agent_long");
      else if (prevLen < 100) features.push("__prev_agent_short");
    }

    if (prevMessages.length >= 2) {
      const prevPrev = prevMessages[prevMessages.length - 2];
      if (prevPrev.sender === msg.sender && prev.sender !== msg.sender) {
        features.push("__turn_pair_complete");
      }
    }
  }

  const prevUserMsg = [...prevMessages].reverse().find(m => m.sender === msg.sender);
  if (prevUserMsg) {
    const prevTokens = new Set(tokenize(prevUserMsg.content));
    const overlap = base.filter(t => prevTokens.has(t)).length;
    const overlapRatio = base.length > 0 ? overlap / base.length : 0;
    if (overlapRatio > 0.6) features.push("__high_self_repeat");
    else if (overlapRatio > 0.3) features.push("__some_self_repeat");
  }

  return features;
}

// ── Prediction ───────────────────────────────────────────────────────

function predict(tokens: string[]): { label: string; confidence: number } {
  const V = model.vocab.length || 1;
  const counts: Record<string, number> = {};
  for (const t of tokens) counts[t] = (counts[t] || 0) + 1;

  const logScores: Record<string, number> = {};
  for (const c of model.classes) {
    let score = model.logPriors[c];
    const denom = model.classTokenTotals[c] + model.alpha * V;
    const classTok = model.tokenCounts[c];
    for (const [tok, cnt] of Object.entries(counts)) {
      const n = ((classTok[tok] as number) || 0) + model.alpha;
      score += cnt * Math.log(n / denom);
    }
    logScores[c] = score;
  }

  const entries = Object.entries(logScores).sort((a, b) => b[1] - a[1]);
  const [bestLabel, bestLog] = entries[0];
  const expSum = entries.reduce((acc, [, s]) => acc + Math.exp(s - bestLog), 0);
  const confidence = 1 / expSum;

  return { label: bestLabel, confidence };
}

function truncate(text: string, max = 200): string {
  const one = (text || "").replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max - 1)}…`;
}

// ── Main ─────────────────────────────────────────────────────────────

const db = new Database(DB_PATH, { readonly: true });

// Load recent messages + a lookback buffer for context
const bufferHours = RECENT_HOURS + 2; // extra 2h for context on earliest messages
const rows = db.query<MessageRow, []>(
  `SELECT m.rowid, m.chat_jid, COALESCE(m.sender, '') AS sender,
          COALESCE(m.sender_name, '') AS sender_name,
          m.timestamp, COALESCE(m.content, '') AS content
   FROM messages m
   WHERE TRIM(COALESCE(m.content, '')) != ''
     AND m.timestamp >= datetime('now', '-${bufferHours} hours')
   ORDER BY m.chat_jid, m.timestamp ASC`
).all();
db.close();

const cutoff = new Date(Date.now() - RECENT_HOURS * 60 * 60 * 1000).toISOString();
console.log(`Loaded ${rows.length} messages (buffer). Classifying after ${cutoff}`);

// Group by chat
const chatGroups = new Map<string, MessageRow[]>();
for (const row of rows) {
  const group = chatGroups.get(row.chat_jid) || [];
  group.push(row);
  chatGroups.set(row.chat_jid, group);
}

// Classify
const predictions: Prediction[] = [];

for (const [, chatMessages] of chatGroups) {
  for (let i = 0; i < chatMessages.length; i++) {
    const msg = chatMessages[i];

    // Only classify messages within the recent window
    if (msg.timestamp < cutoff) continue;

    // Only classify user messages after agent turns
    const isUser = msg.sender !== "agent" && msg.sender !== "web-agent" && msg.sender_name !== "Smith";
    if (!isUser) continue;

    const prevStart = Math.max(0, i - LOOKBACK_WINDOW);
    const prevMessages = chatMessages.slice(prevStart, i);

    const hasPrecedingAgent = prevMessages.length > 0 &&
      (prevMessages[prevMessages.length - 1].sender === "agent" ||
       prevMessages[prevMessages.length - 1].sender === "web-agent" ||
       prevMessages[prevMessages.length - 1].sender_name === "Smith");
    if (!hasPrecedingAgent) continue;

    const tokens = buildFeatureTokens(msg, prevMessages);
    const pred = predict(tokens);

    const precedingAgent = [...prevMessages].reverse().find(m =>
      m.sender === "agent" || m.sender === "web-agent" || m.sender_name === "Smith"
    );

    predictions.push({
      rowid: msg.rowid,
      timestamp: msg.timestamp,
      chat_jid: msg.chat_jid,
      sender: msg.sender,
      predicted_label: pred.label,
      confidence: pred.confidence,
      message_preview: truncate(msg.content, 220),
      preceding_agent_preview: truncate(precedingAgent?.content || "", 300),
    });
  }
}

// Filter attention-worthy
const attentionWorthy = predictions
  .filter(p => !["neutral", "successful_execution"].includes(p.predicted_label) && p.confidence >= CONFIDENCE_THRESHOLD)
  .sort((a, b) => b.confidence - a.confidence);

// Stats
const predCounts: Record<string, number> = {};
for (const p of predictions) predCounts[p.predicted_label] = (predCounts[p.predicted_label] || 0) + 1;

console.log(`\nClassified ${predictions.length} user messages from last ${RECENT_HOURS}h:`);
for (const [label, count] of Object.entries(predCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${label}: ${count}`);
}
console.log(`\nAttention-worthy: ${attentionWorthy.length}`);

// Write outputs
mkdirSync(OUT_DIR, { recursive: true });

const stamp = new Date().toISOString().replace(/[:]/g, "").replace(/\..+/, "Z");

const attentionPath = `${OUT_DIR}/interaction-quality-attention-${stamp}.jsonl`;
const attentionLatest = `${OUT_DIR}/interaction-quality-attention-latest.jsonl`;
const attentionText = attentionWorthy.map(p => JSON.stringify(p)).join("\n") + "\n";
writeFileSync(attentionPath, attentionText);
writeFileSync(attentionLatest, attentionText);

const predsPath = `${OUT_DIR}/interaction-quality-recent-${stamp}.jsonl`;
const predsLatest = `${OUT_DIR}/interaction-quality-recent-latest.jsonl`;
const predsText = predictions.map(p => JSON.stringify(p)).join("\n") + "\n";
writeFileSync(predsPath, predsText);
writeFileSync(predsLatest, predsText);

console.log(`\nDone.`);
console.log(`  Attention: ${attentionLatest}`);
console.log(`  Recent predictions: ${predsLatest}`);

if (attentionWorthy.length === 0) {
  console.log("\nNo attention-worthy messages in the last ${RECENT_HOURS}h. Clean run.");
}

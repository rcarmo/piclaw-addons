#!/usr/bin/env bun
/**
 * train-interaction-quality-bayes.ts
 *
 * Trains a Multinomial Naive Bayes classifier on chat messages to detect
 * interaction quality signals — whether the user had to correct, repeat,
 * or steer the agent vs. whether the interaction succeeded smoothly.
 *
 * Unlike the topic classifier (train-chat-classifiers.ts), this one classifies
 * the RELATIONSHIP between consecutive messages to detect behavioral patterns.
 *
 * Categories:
 *   - successful_execution: agent did it right, user approved or moved on
 *   - course_correction: user had to steer or clarify
 *   - misinterpretation: agent misread intent, user explicitly corrected
 *   - over_engineering: agent did too much, user asked to simplify
 *   - under_delivery: agent gave too little, user pushed for more
 *   - context_failure: agent forgot/lost prior context, user had to repeat
 *   - good_proactive: agent anticipated a need, user approved
 *   - neutral: normal conversational flow, no strong signal
 *
 * Usage:
 *   bun run /workspace/scripts/train-interaction-quality-bayes.ts [options]
 *
 * Options:
 *   --db <path>               SQLite DB path
 *   --out-dir <path>          Output directory
 *   --alpha <n>               Laplace smoothing (default: 1)
 *   --min-class-samples <n>   Min samples/class (default: 15)
 *   --lookback-window <n>     Messages to consider for context (default: 4)
 *   --recent-hours <n>        Only classify messages from last N hours (0=all) (default: 0)
 *   --help, -h                Show help
 */

import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
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

interface AnnotatedMessage extends MessageRow {
  tokens: string[];
  isUser: boolean;
  isAgent: boolean;
  weakLabel: string | null;
  weakScore: number;
  weakReasons: string[];
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
  weak_label: string | null;
  weak_reasons: string[];
  context_preview: string;
  message_preview: string;
  preceding_agent_preview: string;
}

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_DB = `${process.env.PICLAW_STORE || "/workspace/.piclaw/store"}/messages.db`;
const DEFAULT_OUT = "/workspace/exports/interaction-quality";

const CATEGORIES = [
  { id: "successful_execution", label: "Successful execution", description: "Agent fulfilled the request correctly; user approved or moved on." },
  { id: "course_correction", label: "Course correction", description: "User had to steer, clarify, or redirect the agent." },
  { id: "misinterpretation", label: "Misinterpretation", description: "Agent misread intent; user explicitly corrected." },
  { id: "over_engineering", label: "Over-engineering", description: "Agent did too much; user asked to simplify or stop." },
  { id: "under_delivery", label: "Under-delivery", description: "Agent gave too little; user pushed for more." },
  { id: "context_failure", label: "Context failure", description: "Agent forgot or lost prior context; user had to repeat." },
  { id: "good_proactive", label: "Good proactive", description: "Agent anticipated a need; user approved." },
  { id: "neutral", label: "Neutral", description: "Normal conversational flow, no strong quality signal." },
];

const STOPWORDS = new Set([
  "the","and","for","that","with","this","from","have","your","you","are","was","were","will","would",
  "can","could","should","has","had","not","but","all","any","our","out","into","about","just","here",
  "then","than","them","they","their","there","what","when","where","which","while","also","been","after",
  "before","over","under","more","most","some","very","much","many","how","why","who","did","does","done",
  "let","lets","its","it","to","of","in","on","at","as","by","an","a","is","be","or","if","we",
  "i","me","my","so","no","yes","ok","now","up","off","do","go","get","got","ll","ve","re",
]);

// ── Weak labeling rules ──────────────────────────────────────────────

// These patterns match against the USER's follow-up message after an agent turn.
// The label describes the quality signal that user message represents.

const CORRECTION_PATTERNS = [
  "not that", "that's not what", "no i meant", "i meant", "i said", "what i want",
  "wrong", "incorrect", "that's wrong", "no no", "not what i asked",
  "try again", "redo", "start over", "let me rephrase", "to clarify",
  "you misunderstood", "you misread", "that's not right", "nope", "not quite",
  "i didn't ask for", "i don't want", "don't do that",
];

const OVER_ENGINEERING_PATTERNS = [
  "too much", "simpler", "just do", "just the", "only the", "stop",
  "that's overkill", "way too", "unnecessarily", "over-complicat",
  "i just want", "i only need", "keep it simple", "shorter",
  "don't need all", "skip the", "trim", "less verbose",
];

const UNDER_DELIVERY_PATTERNS = [
  "what about", "you forgot", "also need", "missing", "incomplete",
  "more detail", "expand", "elaborate", "and also", "don't forget",
  "you missed", "there's more", "continue", "keep going", "finish",
  "what else", "anything else", "the rest",
];

const CONTEXT_FAILURE_PATTERNS = [
  "i already said", "i told you", "we discussed", "remember",
  "as i mentioned", "like i said", "we already", "earlier i",
  "you already know", "i already gave", "from before", "same as before",
  "again,", "repeating:", "for the third time",
];

const APPROVAL_PATTERNS = [
  "perfect", "exactly", "that's it", "nice", "great", "good job",
  "thanks", "thank you", "looks good", "well done", "correct",
  "yes that's", "spot on", "nailed it", "love it", "awesome",
];

const PROACTIVE_APPROVAL_PATTERNS = [
  "good idea", "smart", "yes do that", "go ahead", "nice catch",
  "good thinking", "yes please", "that's helpful", "anticipated",
];

// ── CLI ──────────────────────────────────────────────────────────────

function helpAndExit(): never {
  console.log("Usage: bun run /workspace/scripts/train-interaction-quality-bayes.ts [options]");
  console.log("");
  console.log(`  --db <path>               SQLite DB path (default: ${DEFAULT_DB})`);
  console.log(`  --out-dir <path>          Output directory (default: ${DEFAULT_OUT})`);
  console.log("  --alpha <n>               Laplace smoothing alpha (default: 1)");
  console.log("  --min-class-samples <n>   Min weak-labeled samples/class (default: 15)");
  console.log("  --lookback-window <n>     Context messages for features (default: 4)");
  console.log("  --recent-hours <n>        Only classify last N hours (0=all) (default: 0)");
  console.log("  --help, -h                Show help");
  process.exit(0);
}

if (Bun.argv.includes("--help") || Bun.argv.includes("-h")) helpAndExit();

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    db: { type: "string", default: DEFAULT_DB },
    "out-dir": { type: "string", default: DEFAULT_OUT },
    alpha: { type: "string", default: "1" },
    "min-class-samples": { type: "string", default: "15" },
    "lookback-window": { type: "string", default: "4" },
    "recent-hours": { type: "string", default: "0" },
  },
  strict: true,
});

const DB_PATH = values.db!;
const OUT_DIR = values["out-dir"]!;
const ALPHA = Math.max(0.01, Number(values.alpha || "1"));
const MIN_CLASS_SAMPLES = Math.max(2, Number(values["min-class-samples"] || "15"));
const LOOKBACK_WINDOW = Math.max(1, Number(values["lookback-window"] || "4"));
const RECENT_HOURS = Math.max(0, Number(values["recent-hours"] || "0"));

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

  // Add bigrams
  for (let i = 0; i < base.length - 1; i++) {
    features.push(`${base[i]}__${base[i + 1]}`);
  }

  // Structural features
  const trimmed = msg.content.trim();
  const len = trimmed.length;
  if (len <= 20) features.push("__len_tiny");
  else if (len <= 80) features.push("__len_short");
  else if (len <= 250) features.push("__len_medium");
  else features.push("__len_long");

  // Punctuation signals
  if (trimmed.endsWith("?")) features.push("__ends_question");
  if (trimmed.endsWith("!")) features.push("__ends_exclamation");
  if (trimmed.startsWith("/")) features.push("__slash_command");

  // Sequence features: was the previous message from the agent?
  if (prevMessages.length > 0) {
    const prev = prevMessages[prevMessages.length - 1];
    const prevIsAgent = prev.sender !== msg.sender;
    features.push(prevIsAgent ? "__after_agent" : "__after_user");

    // If previous was agent, how long was it?
    if (prevIsAgent) {
      const prevLen = (prev.content || "").length;
      if (prevLen > 2000) features.push("__prev_agent_very_long");
      else if (prevLen > 500) features.push("__prev_agent_long");
      else if (prevLen < 100) features.push("__prev_agent_short");
    }

    // Was there a back-and-forth (user→agent→user)?
    if (prevMessages.length >= 2) {
      const prevPrev = prevMessages[prevMessages.length - 2];
      if (prevPrev.sender === msg.sender && prev.sender !== msg.sender) {
        features.push("__turn_pair_complete");
      }
    }
  }

  // Repetition detection: does user repeat tokens from their last message?
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

// ── Weak labeling ────────────────────────────────────────────────────

function matchesAny(textLower: string, patterns: string[]): boolean {
  return patterns.some(p => textLower.includes(p));
}

function weakLabelMessage(
  msg: MessageRow,
  prevMessages: MessageRow[],
  tokens: string[],
): { label: string | null; score: number; reasons: string[] } {
  // Only label USER messages that follow an AGENT message
  const isUser = msg.sender !== "agent" && msg.sender !== "web-agent" && msg.sender_name !== "Smith";
  if (!isUser) return { label: null, score: 0, reasons: [] };

  const hasPrecedingAgent = prevMessages.length > 0 &&
    (prevMessages[prevMessages.length - 1].sender === "agent" ||
     prevMessages[prevMessages.length - 1].sender === "web-agent" ||
     prevMessages[prevMessages.length - 1].sender_name === "Smith");

  if (!hasPrecedingAgent) return { label: null, score: 0, reasons: [] };

  const textLower = msg.content.toLowerCase().trim();
  const reasons: string[] = [];
  let label: string | null = null;
  let score = 0;

  // Check patterns in priority order
  if (matchesAny(textLower, CONTEXT_FAILURE_PATTERNS)) {
    label = "context_failure";
    score = 3;
    reasons.push("context_failure_pattern");
  } else if (matchesAny(textLower, CORRECTION_PATTERNS)) {
    label = "misinterpretation";
    score = 3;
    reasons.push("correction_pattern");
    // Distinguish course_correction (mild) from misinterpretation (strong)
    if (/wrong|incorrect|misunderstood|misread|not right/i.test(textLower)) {
      label = "misinterpretation";
      reasons.push("strong_correction");
    } else {
      label = "course_correction";
      score = 2;
    }
  } else if (matchesAny(textLower, OVER_ENGINEERING_PATTERNS)) {
    label = "over_engineering";
    score = 2;
    reasons.push("over_engineering_pattern");
  } else if (matchesAny(textLower, UNDER_DELIVERY_PATTERNS)) {
    label = "under_delivery";
    score = 2;
    reasons.push("under_delivery_pattern");
  } else if (matchesAny(textLower, PROACTIVE_APPROVAL_PATTERNS)) {
    label = "good_proactive";
    score = 2;
    reasons.push("proactive_approval_pattern");
  } else if (matchesAny(textLower, APPROVAL_PATTERNS)) {
    label = "successful_execution";
    score = 2;
    reasons.push("approval_pattern");
  } else if (textLower.length <= 30 && /^(ok|okay|sure|yes|yep|go|do it|proceed|fine|alright)$/i.test(textLower.replace(/[.!?,]*/g, ""))) {
    label = "successful_execution";
    score = 1;
    reasons.push("short_affirmative");
  }

  // Repetition signal overrides
  if (!label) {
    const prevUserMsg = [...prevMessages].reverse().find(m =>
      m.sender !== "agent" && m.sender !== "web-agent" && m.sender_name !== "Smith"
    );
    if (prevUserMsg) {
      const prevTokens = new Set(tokenize(prevUserMsg.content));
      const overlap = tokens.filter(t => prevTokens.has(t)).length;
      const overlapRatio = tokens.length > 0 ? overlap / tokens.length : 0;
      if (overlapRatio > 0.6 && tokens.length >= 3) {
        label = "context_failure";
        score = 2;
        reasons.push("high_repetition_of_own_prior_message");
      }
    }
  }

  // Default: if user message follows agent and has no strong signal, it's neutral
  if (!label && textLower.length > 20) {
    label = "neutral";
    score = 1;
    reasons.push("no_strong_signal");
  }

  return { label, score, reasons };
}

// ── Model ────────────────────────────────────────────────────────────

function trainModel(data: AnnotatedMessage[]): Model {
  const classes = [...new Set(data.map(d => d.weakLabel!).filter(Boolean))];
  const classDocCounts: Record<string, number> = Object.fromEntries(classes.map(c => [c, 0]));
  const classTokenTotals: Record<string, number> = Object.fromEntries(classes.map(c => [c, 0]));
  const tokenCounts: Record<string, Record<string, number>> = Object.fromEntries(classes.map(c => [c, {}]));
  const vocabSet = new Set<string>();

  for (const row of data) {
    const c = row.weakLabel!;
    classDocCounts[c]++;
    for (const t of row.tokens) {
      vocabSet.add(t);
      tokenCounts[c][t] = (tokenCounts[c][t] || 0) + 1;
      classTokenTotals[c]++;
    }
  }

  const totalDocs = data.length;
  const logPriors: Record<string, number> = {};
  for (const c of classes) {
    logPriors[c] = Math.log((classDocCounts[c] + 1) / (totalDocs + classes.length));
  }

  return { classes, classDocCounts, classTokenTotals, tokenCounts, vocab: [...vocabSet], alpha: ALPHA, totalDocs, logPriors };
}

function predict(model: Model, tokens: string[]): { label: string; confidence: number; scores: Record<string, number> } {
  const V = model.vocab.length || 1;
  const counts: Record<string, number> = {};
  for (const t of tokens) counts[t] = (counts[t] || 0) + 1;

  const logScores: Record<string, number> = {};
  for (const c of model.classes) {
    let score = model.logPriors[c];
    const denom = model.classTokenTotals[c] + model.alpha * V;
    const classTok = model.tokenCounts[c];
    for (const [tok, cnt] of Object.entries(counts)) {
      const n = (classTok[tok] || 0) + model.alpha;
      score += cnt * Math.log(n / denom);
    }
    logScores[c] = score;
  }

  const entries = Object.entries(logScores).sort((a, b) => b[1] - a[1]);
  const [bestLabel, bestLog] = entries[0];
  const expSum = entries.reduce((acc, [, s]) => acc + Math.exp(s - bestLog), 0);
  const confidence = 1 / expSum;

  return { label: bestLabel, confidence, scores: logScores };
}

function stableBucket(n: number): number {
  return ((n * 1103515245 + 12345) >>> 0) % 100;
}

function truncate(text: string, max = 200): string {
  const one = (text || "").replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max - 1)}…`;
}

function categoryLabel(id: string): string {
  return CATEGORIES.find(c => c.id === id)?.label || id;
}

function categoryDescription(id: string): string {
  return CATEGORIES.find(c => c.id === id)?.description || "";
}

// ── Main ─────────────────────────────────────────────────────────────

const db = new Database(DB_PATH, { readonly: true });

const recentFilter = RECENT_HOURS > 0
  ? ` AND m.timestamp >= datetime('now', '-${RECENT_HOURS} hours')`
  : "";

const rows = db.query<MessageRow, []>(
  `SELECT m.rowid, m.chat_jid, COALESCE(m.sender, '') AS sender,
          COALESCE(m.sender_name, '') AS sender_name,
          m.timestamp, COALESCE(m.content, '') AS content
   FROM messages m
   WHERE TRIM(COALESCE(m.content, '')) != ''${recentFilter}
   ORDER BY m.chat_jid, m.timestamp ASC`
).all();
db.close();

console.log(`Loaded ${rows.length} messages from ${DB_PATH}`);

// Group by chat for sequential context
const chatGroups = new Map<string, MessageRow[]>();
for (const row of rows) {
  const group = chatGroups.get(row.chat_jid) || [];
  group.push(row);
  chatGroups.set(row.chat_jid, group);
}

// Annotate messages with weak labels using sequential context
const annotated: AnnotatedMessage[] = [];

for (const [, chatMessages] of chatGroups) {
  for (let i = 0; i < chatMessages.length; i++) {
    const msg = chatMessages[i];
    const prevStart = Math.max(0, i - LOOKBACK_WINDOW);
    const prevMessages = chatMessages.slice(prevStart, i);
    const tokens = buildFeatureTokens(msg, prevMessages);
    const weak = weakLabelMessage(msg, prevMessages, tokens);

    annotated.push({
      ...msg,
      tokens,
      isUser: msg.sender !== "agent" && msg.sender !== "web-agent" && msg.sender_name !== "Smith",
      isAgent: msg.sender === "agent" || msg.sender === "web-agent" || msg.sender_name === "Smith",
      weakLabel: weak.label,
      weakScore: weak.score,
      weakReasons: weak.reasons,
    });
  }
}

const weakLabeled = annotated.filter(m => m.weakLabel !== null);
const weakCounts: Record<string, number> = {};
for (const m of weakLabeled) {
  weakCounts[m.weakLabel!] = (weakCounts[m.weakLabel!] || 0) + 1;
}

console.log("Weak label distribution:");
for (const [label, count] of Object.entries(weakCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${label}: ${count}`);
}

const activeClasses = new Set(
  Object.entries(weakCounts)
    .filter(([, n]) => n >= MIN_CLASS_SAMPLES)
    .map(([k]) => k)
);

const filtered = weakLabeled.filter(m => m.weakLabel && activeClasses.has(m.weakLabel));

if (filtered.length < 50 || activeClasses.size < 2) {
  console.error(`Not enough weak-labeled samples to train (${filtered.length} samples, ${activeClasses.size} classes). Try lowering --min-class-samples.`);
  process.exit(2);
}

// Split
const trainSet = filtered.filter(m => stableBucket(m.rowid) < 80);
const testSet = filtered.filter(m => stableBucket(m.rowid) >= 80);

console.log(`Train: ${trainSet.length}, Test: ${testSet.length}`);

const model = trainModel(trainSet);

// Evaluate
let testCorrect = 0;
for (const row of testSet) {
  const pred = predict(model, row.tokens);
  if (pred.label === row.weakLabel) testCorrect++;
}
const testAccuracy = testSet.length > 0 ? testCorrect / testSet.length : 0;
console.log(`Test accuracy vs weak labels: ${(testAccuracy * 100).toFixed(2)}%`);

// Predict all messages (not just user messages — classify everything for the report)
const predictions: Prediction[] = [];
for (const [, chatMessages] of chatGroups) {
  for (let i = 0; i < chatMessages.length; i++) {
    const msg = chatMessages[i];
    const prevStart = Math.max(0, i - LOOKBACK_WINDOW);
    const prevMessages = chatMessages.slice(prevStart, i);
    const tokens = buildFeatureTokens(msg, prevMessages);
    const pred = predict(model, tokens);

    // Find preceding agent message for context
    const precedingAgent = [...prevMessages].reverse().find(m =>
      m.sender === "agent" || m.sender === "web-agent" || m.sender_name === "Smith"
    );

    // Only include non-neutral predictions for user messages following agent turns
    const isUser = msg.sender !== "agent" && msg.sender !== "web-agent" && msg.sender_name !== "Smith";
    if (!isUser) continue;
    if (!precedingAgent) continue;

    const weak = weakLabelMessage(msg, prevMessages, tokens);

    predictions.push({
      rowid: msg.rowid,
      timestamp: msg.timestamp,
      chat_jid: msg.chat_jid,
      sender: msg.sender,
      predicted_label: pred.label,
      confidence: pred.confidence,
      weak_label: weak.label,
      weak_reasons: weak.reasons,
      context_preview: truncate(prevMessages.map(m => `[${m.sender}] ${m.content}`).join(" → "), 300),
      message_preview: truncate(msg.content, 220),
      preceding_agent_preview: truncate(precedingAgent?.content || "", 300),
    });
  }
}

const predCounts: Record<string, number> = {};
for (const p of predictions) predCounts[p.predicted_label] = (predCounts[p.predicted_label] || 0) + 1;

// Attention-worthy: non-neutral, non-successful predictions with decent confidence
const attentionWorthy = predictions
  .filter(p => !["neutral", "successful_execution"].includes(p.predicted_label) && p.confidence >= 0.55)
  .sort((a, b) => b.confidence - a.confidence);

console.log(`\nPrediction distribution:`);
for (const [label, count] of Object.entries(predCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${label}: ${count}`);
}
console.log(`\nAttention-worthy messages: ${attentionWorthy.length}`);

// ── Persist artifacts ────────────────────────────────────────────────

const stamp = new Date().toISOString().replace(/[:]/g, "").replace(/\..+/, "Z");
mkdirSync(OUT_DIR, { recursive: true });

// Weights
const weightsPayload = {
  metadata: {
    generated_at: new Date().toISOString(),
    db_path: DB_PATH,
    total_messages: rows.length,
    annotated_messages: annotated.length,
    weak_labeled: filtered.length,
    train_set: trainSet.length,
    test_set: testSet.length,
    test_accuracy: Number(testAccuracy.toFixed(4)),
    active_classes: [...activeClasses],
    params: { alpha: ALPHA, min_class_samples: MIN_CLASS_SAMPLES, lookback_window: LOOKBACK_WINDOW, recent_hours: RECENT_HOURS },
  },
  model,
  categories: CATEGORIES.filter(c => activeClasses.has(c.id)),
};

const weightsPath = `${OUT_DIR}/interaction-quality-weights-${stamp}.json`;
const weightsLatest = `${OUT_DIR}/interaction-quality-weights-latest.json`;
writeFileSync(weightsPath, JSON.stringify(weightsPayload));
writeFileSync(weightsLatest, JSON.stringify(weightsPayload));

// Predictions
const predsPath = `${OUT_DIR}/interaction-quality-predictions-${stamp}.jsonl`;
const predsLatest = `${OUT_DIR}/interaction-quality-predictions-latest.jsonl`;
const predsText = predictions.map(p => JSON.stringify(p)).join("\n") + "\n";
writeFileSync(predsPath, predsText);
writeFileSync(predsLatest, predsText);

// Attention-worthy subset
const attentionPath = `${OUT_DIR}/interaction-quality-attention-${stamp}.jsonl`;
const attentionLatest = `${OUT_DIR}/interaction-quality-attention-latest.jsonl`;
const attentionText = attentionWorthy.map(p => JSON.stringify(p)).join("\n") + "\n";
writeFileSync(attentionPath, attentionText);
writeFileSync(attentionLatest, attentionText);

// Report
const report: string[] = [];
report.push("# Interaction Quality Classifier Report");
report.push("");
report.push(`Generated: ${new Date().toISOString()}`);
report.push("");
report.push("## Dataset");
report.push("");
report.push(`- Total messages: **${rows.length}**`);
report.push(`- Annotated (with context): **${annotated.length}**`);
report.push(`- Weak-labeled: **${filtered.length}**`);
report.push(`- Train/Test: **${trainSet.length}/${testSet.length}**`);
report.push(`- Test accuracy: **${(testAccuracy * 100).toFixed(2)}%**`);
report.push(`- Active classes: **${activeClasses.size}**`);
report.push("");
report.push("## Weak label distribution");
report.push("");
report.push("| Category | Count | Description |");
report.push("|---|---:|---|");
for (const [label, count] of Object.entries(weakCounts).sort((a, b) => b[1] - a[1])) {
  report.push(`| ${categoryLabel(label)} | ${count} | ${categoryDescription(label)} |`);
}
report.push("");
report.push("## Prediction distribution (all user messages after agent turns)");
report.push("");
report.push("| Category | Count | Share |");
report.push("|---|---:|---:|");
const totalPred = predictions.length;
for (const [label, count] of Object.entries(predCounts).sort((a, b) => b[1] - a[1])) {
  const share = totalPred > 0 ? (100 * count / totalPred).toFixed(1) : "0.0";
  report.push(`| ${categoryLabel(label)} | ${count} | ${share}% |`);
}
report.push("");
report.push("## Attention-worthy messages (non-neutral, non-success, confidence ≥ 0.55)");
report.push("");
report.push(`Total: **${attentionWorthy.length}**`);
report.push("");

const topAttention = attentionWorthy.slice(0, 20);
if (topAttention.length > 0) {
  report.push("### Top examples");
  report.push("");
  for (const a of topAttention) {
    report.push(`- **${categoryLabel(a.predicted_label)}** (${(a.confidence * 100).toFixed(1)}%) [${a.chat_jid}] ${a.timestamp}`);
    report.push(`  - User: ${a.message_preview}`);
    report.push(`  - Agent before: ${a.preceding_agent_preview.slice(0, 120)}`);
    report.push("");
  }
}

report.push("## Artifacts");
report.push("");
report.push(`- Weights: \`${weightsLatest}\``);
report.push(`- Predictions: \`${predsLatest}\``);
report.push(`- Attention: \`${attentionLatest}\``);
report.push(`- Report: \`${OUT_DIR}/interaction-quality-report-latest.md\``);

const reportPath = `${OUT_DIR}/interaction-quality-report-${stamp}.md`;
const reportLatest = `${OUT_DIR}/interaction-quality-report-latest.md`;
writeFileSync(reportPath, report.join("\n") + "\n");
writeFileSync(reportLatest, report.join("\n") + "\n");

console.log(`\nDone. Report: ${reportPath}`);
console.log(`Attention-worthy: ${attentionPath}`);

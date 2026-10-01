// Frozen context-v5 feature extractor; no training or threshold decisions.
import { readFileSync } from "node:fs";
export interface RankModel {
  bias: number;
  weights: Record<string, number>;
  options: { context: boolean };
}
export function loadRanker(path: string): RankModel | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    const m = value.model;
    if (
      !m ||
      !Number.isFinite(m.bias) ||
      typeof m.options?.context !== "boolean" ||
      !m.weights ||
      typeof m.weights !== "object" ||
      Array.isArray(m.weights) ||
      !Object.values(m.weights).every(
        (x) => typeof x === "number" && Number.isFinite(x),
      )
    )
      return;
    return m;
  } catch {
    return;
  }
}
import type { Exchange } from "./review.js";
type Row = {
  state: {
    target: { content: string };
    context: { speaker: string; content: string }[];
    explicit_reference?: boolean;
  };
};
const patterns: Record<string, RegExp> = {
  direct:
    /\byou (?:keep|did|didn't|forgot|missed|should|are|were|broke|have)|\byour (?:change|fix|code|answer)/,
  wrong: /wrong|incorrect|misunderstood|not what|i meant|misread/,
  broken:
    /still (?:can|cannot|doesn't|isn't|not)|not work|doesn't work|broke|failed|missing|incomplete|unreadable|stuck|flicker|nothing happens/,
  excess:
    /over.?complicat|too (?:much|many|complex)|overkill|simpler|yagni|overthink|indirection|overboard/,
  memory:
    /already (?:said|told|gave|provided|discussed)|we (?:already|agreed|discussed)|remember/,
  refusal: /^(?:no[,! .]|don't|stop|not |wrong)/,
  swear: /\bffs\b|fuck|shit|crap/,
  question: /\?/,
  ordinary:
    /^(?:can you|please |add |create |build |implement |work on|show |list |what is|how |merge|go |yes|ok|upgrade)/,
  approval: /perfect|looks good|well done|thank|great|nice|works fine/,
  negation: /\bnot\b|\bno\b|n't\b/,
  repetition: /still|again|already/,
  instruction: /should|must|need|want|ensure|make sure/,
};
export function words(text: string) {
  return (
    text
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .replace(
        /\[[^\]]+\]|```[\s\S]*?```|https?:\/\/\S+|#[0-9]+|\b[0-9a-f]{8,}\b|message:\d+/g,
        " ",
      )
      .match(/[a-z]+(?:'[a-z]+)?/g) || []
  ).slice(0, 200);
}
export function tokens(r: Row, context: boolean) {
  const text = r.state.target.content.toLowerCase().replace(/[’‘]/g, "'"),
    w = words(text);
  const t = w.map((x) => "w:" + x);
  for (let i = 1; i < w.length; i++) t.push("b:" + w[i - 1] + " " + w[i]);
  for (const [k, re] of Object.entries(patterns))
    if (re.test(text)) t.push("sig:" + k);
  t.push(
    "len:" +
      (text.length < 30
        ? "tiny"
        : text.length < 120
          ? "short"
          : text.length < 350
            ? "medium"
            : "long"),
  );
  if (context) {
    const prev =
      [...r.state.context].reverse().find((x) => x.speaker === "assistant")
        ?.content || "";
    const last = prev.toLowerCase();
    if (
      /done|fixed|implemented|verified|completed|merged|deployed|passed/.test(
        last,
      )
    )
      t.push("ctx:claimed_success");
    if (/would you|if you want|should i|which|\?\s*$/.test(last))
      t.push("ctx:choice");
    if (/can.t|cannot|unable|not available|no access/.test(last))
      t.push("ctx:cannot");
    if (/failed|not yet|not done|pending|not complete|still needs/.test(last))
      t.push("ctx:unfinished");
    if (r.state.explicit_reference) t.push("ctx:reference");
    const p = new Set(words(last));
    const shared = w.filter((x) => p.has(x)).length / Math.max(1, w.length);
    t.push(
      "ctx:overlap:" +
        (shared > 0.5 ? "high" : shared > 0.2 ? "medium" : "low"),
    );
    for (const flag of t.filter((x) => x.startsWith("ctx:")))
      for (const signal of t.filter((x) => x.startsWith("sig:")))
        t.push(flag + "|" + signal);
  }
  return new Set(t);
}

export function rankExchange(e: Exchange, model: RankModel): number {
  const row: Row = {
    state: {
      target: e.target,
      context: e.context.filter((m) => m.rowid < e.rowid),
    },
  };
  let score = model.bias;
  for (const token of tokens(row, model.options.context)) {
    if (Object.hasOwn(model.weights, token))
      score += (model.weights as Record<string, number>)[token];
  }
  return score; // log odds used for ordering only
}

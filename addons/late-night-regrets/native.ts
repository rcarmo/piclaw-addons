/** Native contract: ports are invocation-local, never ambient SDK contexts. */
import { resolve, relative, isAbsolute, join } from "node:path";
import { Type } from "typebox";
import { DEFAULT_CONFIG, normaliseConfig, type RegretsConfig } from "./config.js";
import { selectReview, compactPacket, type ReviewPacket, type Exchange } from "./review.js";
import { decideReview, type DecisionRuntime } from "./decision.js";
import { parseRanker, rankExchange } from "./ranker.js";
import { reflectionPrompt } from "./reflection-prompt.js";

export interface RegretsNativePorts {
  chat: string;
  cwd: string;
  assertCurrent(): void;
  assertSingleUser(): void;
  config: { get(): Partial<RegretsConfig>; set(value: RegretsConfig): void };
  /** Host enforces explicit cross-chat opt-in independently of config defaults. */
  history(window: ReviewPacket["window"]): Promise<{ exchanges: Exchange[]; excluded: Record<string, number> }>;
  readFile(path: string): Promise<string | undefined>;
  /** Must reserve/request/settle using the host model ledger, including failed calls. */
  accountedDecision: DecisionRuntime;
  /** Admit ordinary conversation input through the host source admission path. */
  admitConversationInput(text: string): Promise<unknown>;
}
export const regretsResources = Object.freeze({
  skillPaths: [join(import.meta.dir, "skills/late-night-regrets/SKILL.md")],
});
export function createLateNightRegrets(ports: RegretsNativePorts) {
  const check = () => { ports.assertCurrent(); if (!ports.chat) throw Error("Current chat required"); };
  const config = () => { check(); return normaliseConfig(ports.config.get(), DEFAULT_CONFIG); };
  const file = (path: string) => {
    const result = resolve(ports.cwd, path), rel = relative(ports.cwd, result);
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw Error("Regrets path escapes workspace");
    return result;
  };
  const api = {
    resources: regretsResources,
    getConfig: config,
    setConfig(patch: Partial<RegretsConfig>) {
      const next = normaliseConfig(patch, config());
      file(next.exports_dir); file(next.reflections_path);
      if (next.decision_model && !ports.accountedDecision.getAvailable().some(m => `${m.provider}/${m.id}` === next.decision_model))
        throw Error("Select an available provider/model from the model picker");
      check(); ports.config.set(next); check(); return { ok: true, config: next };
    },
    settings: {
      config: { get: () => ({ ok: true, config: config() }), set: (patch: Partial<RegretsConfig>) => api.setConfig(patch) },
      models: { get: () => ({ ok: true, models: api.models() }) },
    },
    models() { check(); return ports.accountedDecision.getAvailable().map(m => ({ id: `${m.provider}/${m.id}`, name: m.name })); },
    prompt(systemPrompt: string) {
      const c = config();
      return !c.enabled ? systemPrompt : `${systemPrompt}\n\n## Late Night Regrets\nBudgeted contextual review available through regrets_review. Reflections: \`${c.reflections_path}\`. Configured schedule: ${c.cron_schedule} UTC. Schedule changes require task setup; Settings alone does not reschedule existing tasks.`;
    },
    async command() {
      if (!config().enabled) return { disabled: true };
      check(); const result = await ports.admitConversationInput(reflectionPrompt()); check(); return result;
    },
    tool: {
      name: "regrets_review", label: "regrets_review",
      description: "Build a budgeted recent human-exchange packet for contextual reflection.",
      parameters: Type.Object({}),
      async execute(_id: string, _params: unknown, signal?: AbortSignal) {
        const reviewCheck = () => { check(); ports.assertSingleUser(); };
        const c = config();
        if (!c.enabled) return { content: [{ type: "text" as const, text: "Late Night Regrets is disabled. Stop without writing notes." }], details: { disabled: true } };
        ports.assertSingleUser(); reviewCheck();
        const end = new Date();
        const window = { start: new Date(end.getTime() - c.recent_hours_for_reflection * 3600000).toISOString(), end: end.toISOString(), chat_jid: c.review_scope === "all" ? "*" : ports.chat };
        const { exchanges, excluded } = await ports.history(window); reviewCheck();
        const text = await ports.readFile(file(join(c.exports_dir, "interaction-quality-review-ranker.json"))); reviewCheck();
        const ranker = text ? parseRanker(text) : undefined;
        const packet = selectReview(exchanges, window, c.review_budget_tokens, excluded, ranker ? e => rankExchange(e, ranker) : undefined);
        const decision = await decideReview(packet, c.decision_model, {
          getAvailable: () => { reviewCheck(); return ports.accountedDecision.getAvailable(); },
          complete: async (...args) => { reviewCheck(); const result = await ports.accountedDecision.complete(...args); reviewCheck(); return result; },
        }, signal);
        reviewCheck();
        const { usage, ...suggestions } = decision;
        const result = { reflections_path: c.reflections_path, feedback_path: "notes/memory/feedback.md", packet: compactPacket(packet), decision: suggestions };
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result, ...(usage ? { usage } : {}) };
      },
    },
  };
  return api;
}

// Host supplies its owned SQLite handle, never an ambient messages.db path.
export { readExchanges } from "./review.js";

/** Budgeted nightly contextual review. No training or model calls at startup. */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig, saveConfig, type RegretsConfig } from "./config.js";
import { readExchanges, selectReview, compactPacket } from "./review.js";
import { decideReview, decisionRuntime } from "./decision.js";
import { reflectionPrompt } from "./reflection-prompt.js";
import { loadRanker, rankExchange } from "./ranker.js";
import { assertSingleUser } from "./access.js";
export type { RegretsConfig } from "./config.js";

const EXTENSION_ID = "late-night-regrets";
const baseDir = dirname(fileURLToPath(import.meta.url));
interface Bridge {
  getModelRegistry?: () => ModelRegistry;
  getChatJid?: () => string;
}
const bridge = () =>
  (globalThis as { __piclawRuntimeInterop?: Bridge }).__piclawRuntimeInterop;
export const getTrainScriptPath = () =>
  join(baseDir, "scripts", "train-interaction-quality-bayes.ts");
export const getAttentionFilePath = (c: RegretsConfig) =>
  join(
    process.env.PICLAW_WORKSPACE || process.cwd(),
    c.exports_dir,
    "interaction-quality-attention-latest.jsonl",
  );
export const getReportFilePath = (c: RegretsConfig) =>
  join(
    process.env.PICLAW_WORKSPACE || process.cwd(),
    c.exports_dir,
    "interaction-quality-report-latest.md",
  );
export const getReflectionsFilePath = (c: RegretsConfig) =>
  join(process.env.PICLAW_WORKSPACE || process.cwd(), c.reflections_path);
export function availableModels() {
  return (bridge()?.getModelRegistry?.().getAvailable() || []).map((m) => ({
    id: `${m.provider}/${m.id}`,
    name: m.name,
  }));
}
export function setConfig(payload: unknown) {
  const patch =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Partial<RegretsConfig>)
      : {};
  if (
    typeof patch.decision_model === "string" &&
    patch.decision_model.trim() &&
    !availableModels().some((m) => m.id === patch.decision_model!.trim())
  ) {
    throw new Error("Select an available provider/model from the model picker");
  }
  return { ok: true, config: saveConfig(patch) };
}

type Registrar = (
  id: string,
  action: string,
  handlers: { get?: () => unknown; set?: (payload: unknown) => unknown },
  path?: string,
) => unknown;
const register = (globalThis as { __piclaw_registerAddonConfigApi?: Registrar })
  .__piclaw_registerAddonConfigApi;
register?.(
  EXTENSION_ID,
  "config",
  { get: () => ({ ok: true, config: loadConfig() }), set: setConfig },
  import.meta.dir,
);
register?.(
  EXTENSION_ID,
  "models",
  { get: () => ({ ok: true, models: availableModels() }) },
  import.meta.dir,
);

export default function lateNightRegretsExtension(pi: ExtensionAPI): void {
  pi.on("resources_discover", () => ({
    skillPaths: [join(baseDir, "skills", "late-night-regrets", "SKILL.md")],
  }));
  pi.registerTool({
    name: "regrets_review",
    label: "regrets_review",
    description:
      "Build a budgeted recent human-exchange packet for nightly contextual reflection. Optional configured decision model annotates it; never writes notes or treats classifications as lessons.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _update, ctx) {
      const config = loadConfig();
      if (!config.enabled)
        return {
          content: [
            {
              type: "text" as const,
              text: "Late Night Regrets is disabled. Stop without writing notes.",
            },
          ],
          details: { disabled: true },
        };
      const chat = bridge()?.getChatJid?.();
      if (!chat)
        throw new Error(
          "Current chat is unavailable; refusing to read another chat's history",
        );
      const end = new Date();
      const window = {
        start: new Date(
          end.getTime() - config.recent_hours_for_reflection * 3600000,
        ).toISOString(),
        end: end.toISOString(),
        chat_jid: config.review_scope === "all" ? "*" : chat,
      };
      const workspace = process.env.PICLAW_WORKSPACE || ctx.cwd;
      assertSingleUser(workspace);
      const db = join(
        process.env.PICLAW_STORE || join(workspace, ".piclaw", "store"),
        "messages.db",
      );
      const { exchanges, excluded } = readExchanges(db, window);
      const model = loadRanker(
        join(
          workspace,
          config.exports_dir,
          "interaction-quality-review-ranker.json",
        ),
      );
      const packet = selectReview(
        exchanges,
        window,
        config.review_budget_tokens,
        excluded,
        model ? (e) => rankExchange(e, model) : undefined,
      );
      const decision = await decideReview(
        packet,
        config.decision_model,
        decisionRuntime(ctx.modelRegistry),
        signal,
      );
      const { usage, ...suggestions } = decision;
      const result = {
        reflections_path: config.reflections_path,
        feedback_path: "notes/memory/feedback.md",
        packet: compactPacket(packet),
        decision: suggestions,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: result,
        ...(usage ? { usage } : {}),
      };
    },
  });
  pi.registerCommand("regrets", {
    description: "Review recent human feedback within the configured budget",
    handler: async (_args, ctx) => {
      if (!loadConfig().enabled) {
        ctx.ui.notify("Late Night Regrets is disabled in settings.", "warning");
        return;
      }
      pi.sendUserMessage(reflectionPrompt());
    },
  });
  pi.on("before_agent_start", async (event) => {
    const c = loadConfig();
    return {
      systemPrompt: !c.enabled
        ? event.systemPrompt
        : `${event.systemPrompt}\n\n## Late Night Regrets\nBudgeted contextual review available through regrets_review. Reflections: \`${c.reflections_path}\`. Configured schedule: ${c.cron_schedule} UTC. Schedule changes require task setup; Settings alone does not reschedule existing tasks.`,
    };
  });
}

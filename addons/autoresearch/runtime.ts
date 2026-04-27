import {
  consumePendingLaunch,
  dismissAutoresearchWidget,
  getAutoresearchWidgetPayload,
  startAutoresearchFromCard,
  stopAutoresearchFromWeb,
} from "./supervisor.js";

type AddonAdaptiveCardIntentContext = {
  chatJid: string;
  threadId?: string | null;
  rawSubmissionData: Record<string, unknown>;
  sendMessage: (content: string, options?: { threadId?: string | null }) => Promise<void>;
};

type PiclawRuntimeAddonApi = {
  registerStatusPanelProvider?: (provider: {
    key: string;
    getPayload: (chatJid: string) => Promise<unknown> | unknown;
    runAction?: (action: string, payload: Record<string, unknown>) => Promise<unknown> | unknown;
  }) => () => void;
  registerAdaptiveCardIntentHandler?: (intent: string, handler: (context: AddonAdaptiveCardIntentContext) => Promise<void> | void) => () => void;
};

type RuntimeGlobal = typeof globalThis & {
  __piclaw_runtime?: PiclawRuntimeAddonApi;
  __piclaw_autoresearch_runtime_registered__?: boolean;
};

function getResultText(result: unknown, fallback: string): string {
  const blocks = (result && typeof result === "object" && Array.isArray((result as { content?: unknown[] }).content))
    ? (result as { content: Array<{ type?: string; text?: string }> }).content
    : [];
  const textBlock = blocks.find((entry) => entry?.type === "text" && typeof entry?.text === "string");
  return textBlock?.text || fallback;
}

function install(): void {
  const runtimeGlobal = globalThis as RuntimeGlobal;
  if (runtimeGlobal.__piclaw_autoresearch_runtime_registered__) return;

  const api = runtimeGlobal.__piclaw_runtime;
  if (!api) return;

  api.registerStatusPanelProvider?.({
    key: "autoresearch",
    getPayload(chatJid: string) {
      return getAutoresearchWidgetPayload(chatJid);
    },
    async runAction(action: string, payload: Record<string, unknown>) {
      if (action === "stop") {
        return await stopAutoresearchFromWeb({
          chat_jid: typeof payload.chat_jid === "string" ? payload.chat_jid : undefined,
          generate_report: payload.generate_report !== false,
        });
      }
      if (action === "dismiss") {
        return dismissAutoresearchWidget(typeof payload.chat_jid === "string" ? payload.chat_jid : undefined);
      }
      return null;
    },
  });

  api.registerAdaptiveCardIntentHandler?.("autoresearch-launch", async (context) => {
    const selectedModel = typeof context.rawSubmissionData.model === "string"
      ? context.rawSubmissionData.model.trim()
      : "";
    const sandboxToggle = context.rawSubmissionData.sandbox;
    const useSandbox = sandboxToggle === "true" || sandboxToggle === true;

    if (!selectedModel) {
      await context.sendMessage("No model selected.", { threadId: context.threadId });
      return;
    }

    const pending = consumePendingLaunch();
    if (!pending) {
      await context.sendMessage("No pending experiment launch found. Use start_autoresearch to set one up.", { threadId: context.threadId });
      return;
    }

    await context.sendMessage(`Launching with model **${selectedModel}**…`, { threadId: context.threadId });
    const result = await startAutoresearchFromCard({
      project_dir: pending.project_dir,
      prompt: pending.prompt,
      model: selectedModel,
      sandbox: useSandbox,
      max_iterations: pending.max_iterations,
      variables: pending.variables,
      chat_jid: pending.chat_jid || context.chatJid,
    });
    await context.sendMessage(result, { threadId: context.threadId });
  });

  api.registerAdaptiveCardIntentHandler?.("autoresearch-stop", async (context) => {
    const experimentId = typeof context.rawSubmissionData.experiment_id === "string"
      ? context.rawSubmissionData.experiment_id
      : "";
    await context.sendMessage(
      `Stopping autoresearch experiment${experimentId ? ` ${experimentId}` : ""}…`,
      { threadId: context.threadId },
    );
    const result = await stopAutoresearchFromWeb({
      chat_jid: context.chatJid,
      generate_report: true,
    });
    await context.sendMessage(getResultText(result, "Stopped autoresearch experiment."), { threadId: context.threadId });
  });

  runtimeGlobal.__piclaw_autoresearch_runtime_registered__ = true;
}

install();

export {};

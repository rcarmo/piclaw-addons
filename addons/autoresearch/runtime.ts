import {
  dismissAutoresearchWidget,
  getAutoresearchWidgetPayload,
  stopAutoresearchFromWeb,
} from "./supervisor.js";

type PiclawRuntimeAddonApi = {
  registerStatusPanelProvider?: (provider: {
    key: string;
    getPayload: (chatJid: string) => Promise<unknown> | unknown;
    runAction?: (action: string, payload: Record<string, unknown>) => Promise<unknown> | unknown;
  }) => () => void;
};

type RuntimeGlobal = typeof globalThis & {
  __piclaw_runtime?: PiclawRuntimeAddonApi;
  __piclaw_autoresearch_runtime_registered__?: boolean;
};

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

  runtimeGlobal.__piclaw_autoresearch_runtime_registered__ = true;
}

install();

export {};

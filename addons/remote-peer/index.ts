import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPiclawRuntimeApi } from "./compat/runtime.js";
import { getRemotePeerFoundation } from "./foundation.js";
import { normalizeRemotePeerConfig, type RemotePeerConfig } from "./config.js";

const ADDON_ID = "remote-peer";
const baseDir = dirname(fileURLToPath(import.meta.url));

function foundation() {
  const runtime = getPiclawRuntimeApi();
  if (runtime?.messaging?.version !== 1) throw new Error("Remote Peer requires Piclaw messaging API v1.");
  return getRemotePeerFoundation(runtime.messaging.getAddonDataDir(ADDON_ID));
}

function publicState() {
  const current = foundation();
  return {
    config: current.loadConfig(),
    identity: {
      instance_id: current.identity.instance_id,
      fingerprint: current.identity.fingerprint,
      public_key: current.identity.public_key,
      created_at: current.identity.created_at,
    },
    database: {
      path: current.store.dbPath,
      schema_version: current.store.db.query("SELECT MAX(version) AS version FROM schema_migrations").get()?.version ?? 0,
    },
  };
}

function saveConfig(payload: unknown) {
  const current = foundation();
  const previous = current.loadConfig();
  const patch = payload && typeof payload === "object" ? payload as Partial<RemotePeerConfig> : {};
  const config = current.saveConfig(normalizeRemotePeerConfig({ ...previous, ...patch }));
  return { ok: true, config, identity: publicState().identity };
}

type AddonConfigApiRegistrar = (
  addonId: string,
  action: string,
  handlers: {
    get?: (payload: unknown, req: Request) => unknown | Promise<unknown>;
    set?: (payload: unknown, req: Request) => unknown | Promise<unknown>;
  },
  extensionPath?: string,
) => "created" | "updated";

const registerAddonConfigApi = (globalThis as Record<string, unknown>).__piclaw_registerAddonConfigApi as AddonConfigApiRegistrar | undefined;
if (typeof registerAddonConfigApi === "function") {
  registerAddonConfigApi(ADDON_ID, "config", {
    get: async () => publicState(),
    set: async (payload) => saveConfig(payload),
  }, baseDir);
}

export default function remotePeerAddon(pi: ExtensionAPI): void {
  pi.on("resources_discover", () => ({
    skillPaths: [join(baseDir, "skills", "remote-peer", "SKILL.md")],
  }));

  pi.registerTool({
    name: "remote_peer",
    label: "remote_peer",
    description: "Inspect the installed Remote Peer add-on foundation. Pairing and messaging actions are added in subsequent versions.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "identity"] },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params: { action?: string }) {
      try {
        const state = publicState();
        const details = params.action === "identity"
          ? { identity: state.identity }
          : state;
        const text = params.action === "identity"
          ? `Remote Peer identity: ${state.identity.fingerprint}`
          : `Remote Peer foundation is ready. Identity: ${state.identity.fingerprint}. Schema: ${state.database.schema_version}. Enabled: ${state.config.enabled ? "yes" : "no"}.`;
        return { content: [{ type: "text", text }], details };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: message }], details: { error: message }, isError: true };
      }
    },
  });
}

export const __remotePeerFoundationTestApi = {
  publicState,
  saveConfig,
};

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPiclawRuntimeApi } from "./compat/runtime.js";
import { getRemotePeerFoundation } from "./foundation.js";
import { normalizeRemotePeerConfig, type RemotePeerConfig } from "./config.js";
import { getPairingService } from "./pairing/runtime-service.js";
import { getMessagingService } from "./messaging/runtime-service.js";

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
    status: "Remote Peer foundation is ready.",
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

  async function runAction(params: { action?: string; peer?: string; url?: string; request_id?: string; alias?: string; message_id?: string }) {
    const current = foundation();
    const runtime = getPiclawRuntimeApi();
    if (runtime?.messaging?.version !== 1) throw new Error("Remote Peer requires Piclaw messaging API v1.");
    const pairing = getPairingService(current);
    const action = params.action || "status";
    if (action === "status") return publicState();
    if (action === "identity") return { identity: publicState().identity };
    if (action === "list_peers") return { peers: pairing.repository.listPeers() };
    if (action === "pending") return { pending: pairing.repository.listInbound() };
    if (action === "pair_request") return await pairing.initiatePairing(params.url || "");
    if (action === "accept_pair") return { peer: await pairing.acceptInbound(params.request_id || "") };
    if (action === "deny_pair") { pairing.denyInbound(params.request_id || ""); return { status: "denied", request_id: params.request_id }; }
    if (action === "ping") return await pairing.ping(params.peer || "");
    if (action === "set_alias") return { peer: pairing.setAlias(params.peer || "", params.alias || "") };
    if (action === "message_status") {
      const messaging = getMessagingService(current, runtime.messaging);
      const outbound = messaging.repository.findOutbound(params.message_id || "");
      const inbound = messaging.repository.findInbound(params.message_id || "");
      if (!outbound && !inbound) throw new Error("Remote message not found.");
      return { direction: outbound ? "outbound" : "inbound", message: outbound ?? inbound };
    }
    if (action === "message_failures") {
      const messaging = getMessagingService(current, runtime.messaging);
      return {
        outbound: messaging.listOutbound().filter(message => message.status === "failed"),
        inbound: messaging.listInbound().filter(message => message.status === "failed"),
      };
    }
    if (action === "revoke") return await pairing.revoke(params.peer || "");
    throw new Error(`Unsupported remote_peer action: ${action}`);
  }

  pi.registerTool({
    name: "remote_peer",
    label: "remote_peer",
    description: "Inspect and manage paired Piclaw instances. Supports identity, peer listing, pairing approval, signed ping, unique aliases, and revocation.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "identity", "list_peers", "pending", "pair_request", "accept_pair", "deny_pair", "ping", "set_alias", "message_status", "message_failures", "revoke"] },
        peer: { type: "string", description: "Exact peer alias, fingerprint, or instance ID." },
        url: { type: "string", description: "Target Piclaw base URL for pair_request." },
        request_id: { type: "string", description: "Inbound pairing request ID for accept_pair or deny_pair." },
        alias: { type: "string", description: "Unique local peer alias for set_alias." },
        message_id: { type: "string", description: "Remote message ID for message_status." },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params: { action?: string; peer?: string; url?: string; request_id?: string; alias?: string; message_id?: string }) {
      try {
        const details = await runAction(params);
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: message }], details: { error: message }, isError: true };
      }
    },
  });

  pi.registerCommand("pair", {
    description: "Manage Remote Peer pairings: request, list, pending, accept, deny, ping, alias, revoke.",
    handler: async (args: string) => {
      const [sub = "list", first = ""] = String(args || "").trim().split(/\s+/, 2);
      const action = sub === "request" ? "pair_request"
        : sub === "list" ? "list_peers"
        : sub === "pending" ? "pending"
        : sub === "accept" ? "accept_pair"
        : sub === "deny" ? "deny_pair"
        : sub === "ping" ? "ping"
        : sub === "alias" ? "set_alias"
        : sub === "revoke" ? "revoke"
        : "";
      if (!action) {
        pi.sendMessage({ customType: "remote-peer", content: "Usage: /pair request <url> | list | pending | accept <request_id> | deny <request_id> | ping <peer> | alias <peer> <alias> | revoke <peer>", display: true });
        return;
      }
      try {
        const parts = String(args || "").trim().split(/\s+/);
        const result = await runAction({
          action,
          ...(action === "pair_request" ? { url: first } : {}),
          ...(action === "accept_pair" || action === "deny_pair" ? { request_id: first } : {}),
          ...(action === "ping" || action === "revoke" ? { peer: first } : {}),
          ...(action === "set_alias" ? { peer: first, alias: parts[2] || "" } : {}),
        });
        pi.sendMessage({ customType: "remote-peer", content: `\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``, display: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        pi.sendMessage({ customType: "remote-peer", content: `Pairing error: ${message}`, display: true });
      }
    },
  });
}

export const __remotePeerFoundationTestApi = {
  publicState,
  saveConfig,
};

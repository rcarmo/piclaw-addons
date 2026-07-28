import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPiclawRuntimeApi } from "./compat/runtime.js";
import { getRemotePeerFoundation } from "./foundation.js";
import { rotateRemotePeerIdentity } from "./identity.js";
import { normalizeRemotePeerConfig, type RemotePeerConfig } from "./config.js";
import { getPairingService } from "./pairing/runtime-service.js";
import { getMessagingService } from "./messaging/runtime-service.js";
import { getRosterService } from "./messaging/runtime-roster.js";
import type { DeliveryMode, MessagingScope, ModeCeiling } from "./messaging/policy.js";
import { getWorkService } from "./work/runtime-service.js";

const ADDON_ID = "remote-peer";
const baseDir = dirname(fileURLToPath(import.meta.url));

function chatJidFromContext(ctx: any): string | null {
  const leaf = basename(String(ctx?.sessionManager?.getSessionDir?.() || "")).trim();
  if (leaf === "web_default") return "web:default";
  if (leaf.startsWith("web_") && !leaf.includes("__")) return `web:${leaf.slice(4)}`;
  return null;
}

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

function browserServices() {
  const current = foundation();
  const runtime = getPiclawRuntimeApi();
  if (runtime?.messaging?.version !== 1) throw new Error("Remote Peer requires Piclaw messaging API v1.");
  return {
    current,
    runtime,
    pairing: getPairingService(current),
    messaging: getMessagingService(current, runtime.messaging),
    roster: getRosterService(current, runtime.messaging),
    work: getWorkService(current, runtime),
  };
}

function publicPeer(peer: any, agents: string[] = []) {
  return {
    instance_id: peer.instance_id,
    peer_alias: peer.peer_alias,
    fingerprint: peer.fingerprint,
    display_name: peer.display_name,
    origin: peer.base_url,
    status: peer.status,
    trust_epoch: peer.trust_epoch,
    messaging_scope: peer.messaging_scope,
    mode_ceiling: peer.mode_ceiling,
    allowed_agents: agents,
    created_at: peer.created_at,
    updated_at: peer.updated_at,
    last_seen_at: peer.last_seen_at,
    blocked_reason: peer.blocked_reason,
  };
}

function publicPairRequest(request: any) {
  return {
    request_id: request.id,
    instance_id: request.instance_id,
    fingerprint: request.fingerprint,
    display_name: request.display_name,
    origin: (() => { const url = new URL(request.callback_url); return `${url.protocol}//${url.host}`; })(),
    status: request.status,
    expires_at: request.expires_at,
    created_at: request.created_at,
  };
}

async function dashboardState() {
  const { current, runtime, pairing, messaging, roster, work } = browserServices();
  current.store.integrityCheck();
  const peers = pairing.repository.listPeers().map(peer => publicPeer(peer, roster.policy.listPeerAgents(peer.instance_id)));
  const pending = pairing.repository.listInbound().map(publicPairRequest);
  const failures = {
    outbound: messaging.listOutbound().filter(message => message.status === "failed"),
    inbound: messaging.listInbound().filter(message => message.status === "failed"),
  };
  return {
    ok: true,
    generated_at: new Date().toISOString(),
    foundation: publicState(),
    health: {
      enabled: current.loadConfig().enabled,
      external_url_configured: Boolean(current.loadConfig().externalUrl),
      database: "ok",
      paired: peers.filter(peer => peer.status === "paired").length,
      pending: pending.length,
      failed_receipts: failures.outbound.length + failures.inbound.length,
      pending_work: work.listInbox().length,
      callback_retries: work.repository.listDueCallbacks(new Date().toISOString()).length,
    },
    peers,
    pending,
    advertised_agents: roster.policy.listAdvertisedAgents(false).map(agent => ({
      alias: agent.agent_name,
      local_agent: agent.local_agent_name,
      enabled: agent.enabled === 1,
      allowed_modes: agent.allowed_modes.split(",").filter(Boolean),
      updated_at: agent.updated_at,
    })),
    local_agents: await runtime.messaging.listAdvertisableAgents(),
    failures,
    work: {
      pending: work.listInbox(),
      recent: work.repository.list(undefined, undefined, 25).map(record => work.status(record.id)),
      capability_profiles: work.repository.listProfiles().map(profile => ({
        name: profile.name,
        capabilities: JSON.parse(profile.allowed_capabilities_json),
        max_chain_hops: profile.max_chain_hops,
        enabled: profile.enabled === 1,
      })),
    },
  };
}

async function dashboardMutation(payload: unknown) {
  const input = payload && typeof payload === "object" ? payload as Record<string, any> : {};
  const { pairing, roster } = browserServices();
  const action = String(input.action || "");
  if (action === "pair_request") await pairing.initiatePairing(String(input.url || ""));
  else if (action === "accept_pair") {
    const request = pairing.repository.getInbound(String(input.request_id || ""));
    if (!request || request.fingerprint !== input.confirmation) throw new Error("Pair acceptance requires the immutable fingerprint confirmation.");
    await pairing.acceptInbound(request.id);
  } else if (action === "deny_pair") pairing.denyInbound(String(input.request_id || ""));
  else if (action === "revoke") {
    const peer = pairing.repository.resolvePeer(String(input.peer || ""));
    if (!peer || peer.fingerprint !== input.confirmation) throw new Error("Revocation requires the immutable fingerprint confirmation.");
    await pairing.revoke(peer.instance_id);
  } else if (action === "rotate_identity") {
    const fingerprint = current.identity.fingerprint;
    if (input.confirmation !== `ROTATE ${fingerprint}`) throw new Error(`Key rotation requires typed confirmation: ROTATE ${fingerprint}`);
    const timestamp = new Date().toISOString();
    current.store.db.transaction(() => {
      for (const peer of pairing.repository.listPeers("paired")) {
        pairing.repository.updatePeer(peer.instance_id, { ...peer, status: "revoked", trust_epoch: peer.trust_epoch + 1, updated_at: timestamp, last_seen_at: peer.last_seen_at, blocked_reason: "identity-rotated" });
        pairing.repository.audit(peer.instance_id, "identity_rotation", "revoked");
      }
    }).immediate();
    const next = rotateRemotePeerIdentity(current.dataDir);
    return { ...await dashboardState(), restart_required: true, old_fingerprint: fingerprint, new_fingerprint: next.fingerprint };
  } else if (action === "set_alias") pairing.setAlias(String(input.peer || ""), String(input.alias || ""));
  else if (action === "advertise_agent") roster.policy.upsertAdvertisedAgent(String(input.alias || input.local_agent || ""), String(input.local_agent || ""), input.modes || ["queue"], new Date().toISOString());
  else if (action === "unadvertise_agent") roster.policy.disableAdvertisedAgent(String(input.alias || ""), new Date().toISOString());
  else if (action === "set_policy") {
    const peer = pairing.repository.resolvePeer(String(input.peer || ""));
    if (!peer) throw new Error("Peer not found.");
    const risky = input.scope === "all-advertised" || input.mode_ceiling === "queue-auto-steer";
    if (risky && input.confirmation !== "ALLOW REMOTE ACCESS") throw new Error("Risk-elevating policy requires typed confirmation: ALLOW REMOTE ACCESS");
    roster.policy.updatePeerPolicy(peer.instance_id, input.scope || peer.messaging_scope, input.mode_ceiling || peer.mode_ceiling, new Date().toISOString());
    if (Array.isArray(input.agents)) roster.policy.setPeerAgents(peer.instance_id, input.agents, new Date().toISOString());
  } else throw new Error(`Unsupported dashboard action: ${action}`);
  return await dashboardState();
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
  registerAddonConfigApi(ADDON_ID, "dashboard", {
    get: async () => await dashboardState(),
    set: async (payload) => await dashboardMutation(payload),
  }, baseDir);
}

export default function remotePeerAddon(pi: ExtensionAPI): void {
  pi.on("resources_discover", () => ({
    skillPaths: [join(baseDir, "skills", "remote-peer", "SKILL.md")],
  }));

  async function runAction(params: {
    action?: string;
    peer?: string;
    url?: string;
    request_id?: string;
    alias?: string;
    message_id?: string;
    local_agent?: string;
    modes?: string[];
    scope?: MessagingScope;
    mode_ceiling?: ModeCeiling;
    agents?: string[];
    prompt?: string;
    request_type?: "proposal" | "execute";
    capability_profile?: string;
    capabilities?: string[];
    chain_id?: string;
    chain_hop?: number;
    result?: string;
    reason?: string;
    timeout_ms?: number;
    max_chain_hops?: number;
    enabled?: boolean;
    origin_chat_jid?: string;
    origin_thread_id?: string;
  }, ctx?: any, signal?: AbortSignal) {
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
    if (action === "roster") {
      const roster = getRosterService(current, runtime.messaging);
      if (params.peer) {
        const peer = pairing.repository.resolvePeer(params.peer);
        if (!peer) throw new Error("Peer not found.");
        return { roster: await roster.fetchPeerRoster(peer) };
      }
      return { roster: await roster.signedRoster() };
    }
    if (action === "advertise_agent") {
      const roster = getRosterService(current, runtime.messaging);
      const known = await runtime.messaging.listAdvertisableAgents();
      const local = String(params.local_agent || "").trim().replace(/^@+/, "");
      if (!known.some(agent => agent.agent_name.toLowerCase() === local.toLowerCase())) throw new Error("Local agent is not advertisable.");
      return { agent: roster.policy.upsertAdvertisedAgent(params.alias || local, local, (params.modes || ["queue"]) as DeliveryMode[], new Date().toISOString()) };
    }
    if (action === "unadvertise_agent") {
      const roster = getRosterService(current, runtime.messaging);
      roster.policy.disableAdvertisedAgent(params.alias || "", new Date().toISOString());
      return { status: "disabled", alias: params.alias };
    }
    if (action === "set_policy") {
      const roster = getRosterService(current, runtime.messaging);
      const peer = pairing.repository.resolvePeer(params.peer || "");
      if (!peer) throw new Error("Peer not found.");
      const updated = roster.policy.updatePeerPolicy(peer.instance_id, params.scope || peer.messaging_scope, params.mode_ceiling || peer.mode_ceiling, new Date().toISOString());
      const agents = params.agents ? roster.policy.setPeerAgents(peer.instance_id, params.agents, new Date().toISOString()) : roster.policy.listPeerAgents(peer.instance_id);
      return { peer: updated, agents };
    }
    if (action === "work_send") {
      const work = getWorkService(current, runtime);
      const peer = pairing.repository.resolvePeer(params.peer || "");
      if (!peer) throw new Error("Peer not found.");
      return { work: await work.send({
        peer,
        prompt: params.prompt || "",
        requestType: params.request_type,
        capabilityProfile: params.capability_profile,
        capabilities: params.capabilities,
        chainId: params.chain_id,
        chainHop: params.chain_hop,
        originChatJid: params.origin_chat_jid || chatJidFromContext(ctx) || undefined,
        originThreadId: params.origin_thread_id,
      }) };
    }
    if (action === "work_status") return { work: getWorkService(current, runtime).status(params.request_id || "") };
    if (action === "work_wait") return { work: await getWorkService(current, runtime).wait(params.request_id || "", params.timeout_ms, signal) };
    if (action === "work_inbox") return { pending: getWorkService(current, runtime).listInbox() };
    if (action === "work_approve") return { work: await getWorkService(current, runtime).approve(params.request_id || "", params.result || "", params.capabilities || []) };
    if (action === "work_reject") return { work: await getWorkService(current, runtime).reject(params.request_id || "", params.reason || "") };
    if (action === "work_retry_callbacks") return { delivered: await getWorkService(current, runtime).retryDueCallbacks() };
    if (action === "work_profiles") return { profiles: getWorkService(current, runtime).repository.listProfiles() };
    if (action === "work_set_profile") {
      const name = String(params.capability_profile || "").trim();
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw new Error("Invalid capability profile name.");
      return { profile: getWorkService(current, runtime).repository.upsertProfile(name, params.capabilities || [], params.max_chain_hops ?? 3, params.enabled !== false, new Date().toISOString()) };
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
        action: { type: "string", enum: ["status", "identity", "list_peers", "pending", "pair_request", "accept_pair", "deny_pair", "ping", "set_alias", "roster", "advertise_agent", "unadvertise_agent", "set_policy", "message_status", "message_failures", "work_send", "work_status", "work_wait", "work_inbox", "work_approve", "work_reject", "work_retry_callbacks", "work_profiles", "work_set_profile", "revoke"] },
        peer: { type: "string", description: "Exact peer alias, fingerprint, or instance ID." },
        url: { type: "string", description: "Target Piclaw base URL for pair_request." },
        request_id: { type: "string", description: "Inbound pairing request ID for accept_pair or deny_pair." },
        alias: { type: "string", description: "Unique local peer alias for set_alias." },
        message_id: { type: "string", description: "Remote message ID for message_status." },
        local_agent: { type: "string", description: "Local agent name for advertise_agent." },
        modes: { type: "array", items: { type: "string", enum: ["queue", "auto", "steer"] }, description: "Allowed advertised-agent modes." },
        scope: { type: "string", enum: ["none", "inbox-only", "named-agents", "all-advertised"] },
        mode_ceiling: { type: "string", enum: ["queue", "queue-auto", "queue-auto-steer"] },
        agents: { type: "array", items: { type: "string" }, description: "Advertised aliases allowed for named-agents scope." },
        prompt: { type: "string", description: "Mediated work prompt." },
        request_type: { type: "string", enum: ["proposal", "execute"], description: "Both types remain operator mediated." },
        capability_profile: { type: "string", description: "Named local capability allowlist profile." },
        capabilities: { type: "array", items: { type: "string" }, description: "Requested or approved capability identifiers." },
        chain_id: { type: "string" },
        chain_hop: { type: "integer", minimum: 0, maximum: 8 },
        result: { type: "string", description: "Reviewed result supplied on work_approve." },
        reason: { type: "string", description: "Rejection reason." },
        timeout_ms: { type: "integer", minimum: 0, maximum: 120000 },
        max_chain_hops: { type: "integer", minimum: 0, maximum: 8 },
        enabled: { type: "boolean" },
        origin_chat_jid: { type: "string", description: "Optional explicit result destination when context derivation is unavailable." },
        origin_thread_id: { type: "string" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params: Parameters<typeof runAction>[0], signal, _onUpdate, ctx) {
      try {
        const details = await runAction(params, ctx, signal);
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

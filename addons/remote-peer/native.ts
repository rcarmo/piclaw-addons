import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAction, remotePeerParameters } from "./actions.js";
import type { AddonLocalContext } from "./compat/runtime.js";
import { PeerService, type PeerServiceOptions } from "./service.js";
import { RemotePeerAuthorityScope, type RemotePeerAcceptedOperation, type RemotePeerApplicationPorts } from "./native-authority.js";
export type { RemotePeerApplicationPorts, RemotePeerAcceptedOperation } from "./native-authority.js";

export interface RemotePeerNativeHostPorts {
  readonly service: PeerService;
  readonly authority: RemotePeerAuthorityScope;
  /** Must be built from the real operation source; never a fabricated extension context. */
  localContext(operation: RemotePeerAcceptedOperation): AddonLocalContext;
}
export interface RemotePeerInvocationOptions extends RemotePeerAcceptedOperation {
  readonly nativeHostPorts: RemotePeerNativeHostPorts;
}
export const remotePeerResources = Object.freeze({
  skillPaths: [join(dirname(fileURLToPath(import.meta.url)), "skills/remote-peer/SKILL.md")],
});

/** Construct once at application startup. The caller owns lifecycle and registry
 * registration, not any individual tool invocation. No global runtime swapping. */
export async function createRemotePeerNativeHostPorts(options: Omit<PeerServiceOptions, "authority" | "runtime"> & {
  /** Host implementations MUST check immediately before actual queue/steer
   * admission and exact-target resolution, including after their own awaits. */
  createRuntime(assertCurrent: () => void): PeerServiceOptions["runtime"];
  application: RemotePeerApplicationPorts;
  localContext: RemotePeerNativeHostPorts["localContext"];
}): Promise<RemotePeerNativeHostPorts> {
  const authority = new RemotePeerAuthorityScope(options.application);
  return authority.application("construct", async () => ({ service: new PeerService({ ...options, runtime: options.createRuntime(authority.assertCurrent), authority }), authority, localContext: options.localContext }));
}

export function createRemotePeerTool(options: RemotePeerInvocationOptions) {
  return {
    name: "remote_peer", label: "Remote Peer",
    description: "Manage Iroh client-ID pairing, permissions, local discovery status and delivery retries. Use chat for ordinary peer conversations.",
    parameters: remotePeerParameters,
    async execute(_id: string, params: Record<string, unknown>, _signal?: AbortSignal) {
      // Authority errors must escape, not become successful replayable tool output.
      options.assertCurrent();
      const ports = options.nativeHostPorts;
      const details = await ports.authority.run(options, async () => {
        const context = ports.localContext(options);
        const guarded = ports.authority.guard(context);
        const result = await runAction(params, ports.service, guarded);
        options.assertCurrent();
        return result;
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }], details };
    },
  };
}

/** Direct settings/dashboard/resource routes use NEW accepted application operations.
 * The parent registers these handlers on its existing authenticated route surface. */
export function createRemotePeerNativeRoutes(ports: RemotePeerNativeHostPorts) {
  const run = <T>(name: string, body: () => Promise<T>) => ports.authority.application(name, body);
  return {
    resources: remotePeerResources,
    config: {
      get: () => run("config.get", async () => ({ config: ports.service.state.config(), identity: ports.service.identity() })),
      set: (input: Parameters<PeerService["configure"]>[0]) => run("config.set", async () => ({ config: await ports.service.configure(input), identity: ports.service.identity() })),
    },
    // Dashboard exact-session authority must be supplied by the authenticated
    // request's accepted operation, using the same operation-local tool boundary.
    dashboard: (options: RemotePeerAcceptedOperation, input: Record<string, unknown> = { action: "status" }) =>
      ports.authority.run(options, async () => {
        const local = ports.authority.guard(ports.localContext(options));
        const result = await runAction(input, ports.service, local);
        return { ...await ports.service.dashboard(local), result };
      }),
    start: () => run("start", () => ports.service.start()),
    close: () => run("close", () => ports.service.close()),
    chatTransport: {
      id: "remote-peer", kind: "bang" as const,
      directory: () => run("directory", () => ports.service.directory()),
      validate: (request: Parameters<PeerService["validate"]>[0]) => run("validate", async () => ports.service.validate(request)),
      send: (request: Parameters<PeerService["send"]>[0]) => run("send", () => ports.service.send(request)),
    },
  };
}


/** Structural public bootstrap port: no AgentSession, runner or model task. */
export interface NativeRemotePeerTarget {
  readonly agentName?: string; readonly domain: string; readonly chatJid: string; readonly branchId: string;
  readonly conversationId: number; readonly sessionId: string; readonly revision: string;
}
export interface NativeRemotePeerInputPort {
  sessionTargets: { list(): readonly NativeRemotePeerTarget[]; resolve(target: NativeRemotePeerTarget): NativeRemotePeerTarget };
  steerApplicationInput?(input: Parameters<NativeRemotePeerInputPort["admitApplicationInput"]>[0]): Promise<{ rowId: number; chatJid: string; mode?: string }>;
  admitApplicationInput(input: {
    source: "remote_peer"; sourceId: string; text: string; queuedAt: string;
    principal: { id: string; revision: string }; target: NativeRemotePeerTarget;
    mode: "queue"; assertCurrent(): void;
  }): { rowId: number; chatJid: string } | Promise<{ rowId: number; chatJid: string }>;
}

/** Application startup factory. Transport handlers carry verified identity through
 * the authority scope; model-supplied source fields cannot establish a principal. */
export async function bindNativeRemotePeer(options: Omit<PeerServiceOptions, "runtime" | "authority"> & {
  bundle: NativeRemotePeerInputPort;
  nativeRootServiceOwner: { assertCurrent(): void };
  scopedRoot?<T>(assertCurrent: () => void, body: () => T): T;
  registerChatTransport?: NonNullable<PeerServiceOptions["runtime"]["messaging"]>["registerChatTransport"];
}) {
  const { bundle, nativeRootServiceOwner: owner } = options;
  let liveService: PeerService | undefined;
  const authority = new RemotePeerAuthorityScope({ assertCurrent: () => owner.assertCurrent(),
    assertPeerCurrent: source => { if (!liveService) throw Error("Remote Peer not ready"); liveService.assertNativePeerCurrent(source); } }, options.scopedRoot);
  const targets = () => { authority.assertCurrent(); return bundle.sessionTargets.list(); };
  const select = (input: { target_chat_jid?: string; target_agent_name?: string; target_incarnation?: string }) => {
    const matches = targets().filter(t => input.target_chat_jid ? t.chatJid === input.target_chat_jid : t.agentName === input.target_agent_name);
    if (matches.length !== 1 || (input.target_incarnation !== undefined && matches[0].revision !== input.target_incarnation)) throw Error("Exact native session target required");
    return bundle.sessionTargets.resolve(matches[0]);
  };
  const localContext = (): AddonLocalContext => ({
    version: 1, accessMode: "single-user", kind: "operator",
    async listTargets() { return targets().map(t => ({ chatJid: t.chatJid, incarnation: t.revision, agentName: t.agentName ?? "", label: t.chatJid, active: true })); },
    async resolveTarget(s) {
      const found = targets().filter(t => (!s.chatJid || t.chatJid === s.chatJid) && (!s.agentName || t.agentName === s.agentName) && (!s.incarnation || t.revision === s.incarnation));
      if (found.length !== 1) return null;
      const t = bundle.sessionTargets.resolve(found[0]);
      return { chatJid: t.chatJid, incarnation: t.revision, agentName: t.agentName ?? "", label: t.chatJid, active: true };
    },
  });
  const service = await authority.application("construct", async () => new PeerService({ ...options, authority, runtime: {
    async enqueueAgentMessage(input) {
      const principal = authority.verifiedPeer();
      if (input.mode !== "queue") throw Error("Native steering unavailable");
      const target = select({ target_chat_jid: input.chatJid });
      const receipt = await bundle.admitApplicationInput({ source: "remote_peer", sourceId: createHash("sha256").update(JSON.stringify(["remote_peer.work-result", principal.peer, principal.revision, input.chatJid, input.content])).digest("hex"),
        text: input.content, queuedAt: new Date().toISOString(), principal: { id: principal.peer, revision: principal.revision }, target, mode: "queue", assertCurrent: authority.assertCurrent });
      return { status: "ok" as const, chat_jid: receipt.chatJid, row_id: receipt.rowId, thread_id: null, queued: "followup" as const, created: false };
    },
    messaging: {
      version: 1, getAddonDataDir: () => options.dataDir,
      registerChatTransport: options.registerChatTransport ?? (() => { throw Error("Parent must register returned native chat transport"); }),
      async listAdvertisableAgents() { return targets().map(t => ({ agent_name: t.agentName ?? "", active: true })); },
      async listAdvertisableSessions() { return targets().map(t => ({ chatJid: t.chatJid, agentName: t.agentName ?? "", incarnation: t.revision, active: true })); },
      async resolveLocalTarget(input) { const t = select(input); return { status: "resolved", target_agent_name: t.agentName ?? "", incarnation: t.revision, active: true }; },
      deliverPeerMessage: createNativeRemotePeerDelivery({ bundle, owner, authority, select }),
    },
  } }));
  liveService = service;
  const ports: RemotePeerNativeHostPorts = { service, authority, localContext };
  return { ...ports, ...createRemotePeerNativeRoutes(ports) };
}


/** The delivery boundary used by the service, exported for network-free host qualification. */
export function createNativeRemotePeerDelivery(options: {
  bundle: NativeRemotePeerInputPort; owner: { assertCurrent(): void }; authority: RemotePeerAuthorityScope;
  select(input: { target_chat_jid?: string; target_agent_name?: string; target_incarnation?: string }): NativeRemotePeerTarget;
}) {
  const { bundle, owner, authority, select } = options;
  return async (input: Parameters<NonNullable<PeerServiceOptions["runtime"]["messaging"]>["deliverPeerMessage"]>[0]) => {
        const principal = authority.verifiedPeer();
        if (input.source.peer_instance_id !== principal.peer || input.attachments?.length) throw Error("Unsupported native peer input");
        const target = select(input);
        const assertCurrent = () => { authority.assertCurrent(); owner.assertCurrent(); if (input.signal?.aborted) throw Error("Peer authorization revoked"); };
        assertCurrent();
        const admit = input.mode === "steer" ? bundle.steerApplicationInput?.bind(bundle) : bundle.admitApplicationInput.bind(bundle);
        if (!admit) throw Error("Native steering unavailable");
        const receipt: { rowId: number; chatJid: string; mode?: string } = await admit({ source: "remote_peer", sourceId: JSON.stringify(["remote_peer", principal.peer, principal.revision, input.source.message_id]), text: input.content,
          queuedAt: new Date().toISOString(), principal: { id: principal.peer, revision: principal.revision }, target, mode: "queue", assertCurrent });
        return { status: "ok" as const, chat_jid: receipt.chatJid, row_id: receipt.rowId, thread_id: null, queued: receipt.mode === "steer" ? "steer" as const : "followup" as const, created: false };
  };
}

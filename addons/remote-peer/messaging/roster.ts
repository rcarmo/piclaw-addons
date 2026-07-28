import type { PiclawRuntimeApi } from "../compat/runtime.js";
import type { RemotePeerFoundation } from "../foundation.js";
import { buildSignedHeaders, verifyCanonical } from "../protocol/canonical.js";
import type { PeerRecord } from "../pairing/repository.js";
import { MessagingPolicyRepository, parseAllowedModes } from "./policy.js";

export const ROSTER_PATH = "/api/addons/remote-peer/v1/roster";

export interface PublicRoster {
  instance_id: string;
  fingerprint: string;
  inbox: string;
  agents: Array<{ name: string; address: string; accepts_messages: true; allowed_modes: string[] }>;
  roster_version: number;
}

export interface RosterServiceOptions {
  foundation: RemotePeerFoundation;
  messaging: NonNullable<PiclawRuntimeApi["messaging"]>;
  fetch?: typeof fetch;
  now?: () => Date;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

function rosterProof(roster: PublicRoster): string {
  return JSON.stringify(roster);
}

export class RosterService {
  readonly policy: MessagingPolicyRepository;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: RosterServiceOptions) {
    this.policy = new MessagingPolicyRepository(options.foundation.store.db);
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async publicRoster(): Promise<PublicRoster> {
    const known = new Set((await this.options.messaging.listAdvertisableAgents()).map(agent => agent.agent_name.toLowerCase()));
    const agents = this.policy.listAdvertisedAgents().filter(agent => known.has(agent.local_agent_name.toLowerCase())).map(agent => ({
      name: agent.agent_name,
      address: `peer!@${agent.agent_name}`,
      accepts_messages: true as const,
      allowed_modes: parseAllowedModes(agent.allowed_modes),
    }));
    const identity = this.options.foundation.identity;
    return {
      instance_id: identity.instance_id,
      fingerprint: identity.fingerprint,
      inbox: "peer!inbox",
      agents,
      roster_version: Math.max(1, ...this.policy.listAdvertisedAgents(false).map(agent => Date.parse(agent.updated_at) || 0)),
    };
  }

  async signedRoster(): Promise<Record<string, unknown>> {
    const roster = await this.publicRoster();
    const { signCanonical } = await import("../protocol/canonical.js");
    return { ...roster, roster_signature: signCanonical(this.options.foundation.identity, rosterProof(roster)) };
  }

  async receive(peer: PeerRecord): Promise<Response> {
    if (peer.messaging_scope === "none" || peer.messaging_scope === "inbox-only") return json({ error: "Roster access is not allowed for this peer." }, 403);
    return json(await this.signedRoster());
  }

  async fetchPeerRoster(peer: PeerRecord): Promise<PublicRoster> {
    if (!peer.base_url || peer.status !== "paired") throw new Error("Paired peer not found.");
    const body = "{}";
    const bytes = new TextEncoder().encode(body);
    const response = await this.fetchFn(`${peer.base_url}${ROSTER_PATH}`, {
      method: "POST",
      headers: buildSignedHeaders(this.options.foundation.identity, ROSTER_PATH, bytes, peer.trust_epoch, this.now().toISOString()),
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(String(payload.error || `Peer roster failed (${response.status}).`));
    const roster: PublicRoster = {
      instance_id: String(payload.instance_id || ""),
      fingerprint: String(payload.fingerprint || ""),
      inbox: String(payload.inbox || ""),
      agents: Array.isArray(payload.agents) ? payload.agents as PublicRoster["agents"] : [],
      roster_version: Number(payload.roster_version),
    };
    const signature = typeof payload.roster_signature === "string" ? payload.roster_signature : "";
    if (roster.instance_id !== peer.instance_id || roster.fingerprint !== peer.fingerprint || !Number.isFinite(roster.roster_version)
      || !verifyCanonical(peer.public_key, rosterProof(roster), signature)) throw new Error("Peer returned an invalid signed roster.");
    return roster;
  }
}

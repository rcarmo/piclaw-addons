import type { PiclawRuntimeApi } from "../compat/runtime.js";
import type { RemotePeerFoundation } from "../foundation.js";
import { buildSignedHeaders, verifyCanonical } from "../protocol/canonical.js";
import type { PeerRecord } from "../pairing/repository.js";
import { MessagingPolicyRepository, parseAllowedModes } from "./policy.js";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_TOTAL_BYTES, MAX_ATTACHMENTS_PER_MESSAGE } from "./attachments.js";

export const ROSTER_PATH = "/api/addons/remote-peer/v1/roster";
export const ROSTER_CACHE_TTL_MS = 5 * 60_000;

export interface PublicRoster {
  instance_id: string;
  fingerprint: string;
  inbox: string;
  agents: Array<{ name: string; address: string; accepts_messages: true; allowed_modes: string[] }>;
  attachments: { enabled: true; max_files: number; max_file_bytes: number; max_total_bytes: number };
  roster_version: number;
}

export interface CachedPeerRoster {
  roster: PublicRoster | null;
  fetched_at: string | null;
  stale: boolean;
  error: string | null;
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

function parseRoster(payload: Record<string, unknown>, peer: PeerRecord): PublicRoster {
  const attachmentValue = payload.attachments && typeof payload.attachments === "object" ? payload.attachments as Record<string, unknown> : {};
  const roster: PublicRoster = {
    instance_id: String(payload.instance_id || ""),
    fingerprint: String(payload.fingerprint || ""),
    inbox: String(payload.inbox || ""),
    agents: Array.isArray(payload.agents) ? payload.agents as PublicRoster["agents"] : [],
    attachments: {
      enabled: true,
      max_files: Number(attachmentValue.max_files),
      max_file_bytes: Number(attachmentValue.max_file_bytes),
      max_total_bytes: Number(attachmentValue.max_total_bytes),
    },
    roster_version: Number(payload.roster_version),
  };
  const signature = typeof payload.roster_signature === "string" ? payload.roster_signature : "";
  const attachmentShapeValid = roster.attachments.enabled
    ? roster.attachments.max_files === MAX_ATTACHMENTS_PER_MESSAGE
      && Number.isInteger(roster.attachments.max_file_bytes) && roster.attachments.max_file_bytes > 0 && roster.attachments.max_file_bytes <= MAX_ATTACHMENT_BYTES
      && roster.attachments.max_total_bytes === MAX_ATTACHMENT_TOTAL_BYTES
    : roster.attachments.max_files === 0 && roster.attachments.max_file_bytes === 0 && roster.attachments.max_total_bytes === 0;
  if (roster.instance_id !== peer.instance_id || roster.fingerprint !== peer.fingerprint || roster.inbox !== "peer!inbox"
    || !Number.isFinite(roster.roster_version) || !attachmentShapeValid
    || !verifyCanonical(peer.public_key, rosterProof(roster), signature)) throw new Error("Peer returned an invalid signed roster.");
  return roster;
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

  async publicRoster(options: { includeAgents?: boolean; attachmentsEnabled?: boolean; maxAttachmentBytes?: number } = {}): Promise<PublicRoster> {
    const known = new Set((await this.options.messaging.listAdvertisableAgents()).map(agent => agent.agent_name.toLowerCase()));
    const agents = options.includeAgents === false ? [] : this.policy.listAdvertisedAgents().filter(agent => known.has(agent.local_agent_name.toLowerCase())).map(agent => ({
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
      attachments: { enabled: options.attachmentsEnabled !== false, max_files: options.attachmentsEnabled === false ? 0 : MAX_ATTACHMENTS_PER_MESSAGE, max_file_bytes: options.attachmentsEnabled === false ? 0 : Math.min(options.maxAttachmentBytes ?? MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_BYTES), max_total_bytes: options.attachmentsEnabled === false ? 0 : MAX_ATTACHMENT_TOTAL_BYTES },
      roster_version: Math.max(1, ...this.policy.listAdvertisedAgents(false).map(agent => Date.parse(agent.updated_at) || 0)),
    };
  }

  async signedRoster(peer?: PeerRecord): Promise<Record<string, unknown>> {
    const roster = await this.publicRoster({
      includeAgents: !peer || (peer.messaging_scope !== "none" && peer.messaging_scope !== "inbox-only"),
      attachmentsEnabled: !peer || peer.attachments_enabled === 1,
      maxAttachmentBytes: peer?.max_attachment_bytes,
    });
    const { signCanonical } = await import("../protocol/canonical.js");
    return { ...roster, roster_signature: signCanonical(this.options.foundation.identity, rosterProof(roster)) };
  }

  async receive(peer: PeerRecord): Promise<Response> {
    if (peer.messaging_scope === "none") return json({ error: "Roster access is not allowed for this peer." }, 403);
    return json(await this.signedRoster(peer));
  }

  cachedPeerRoster(peer: PeerRecord): CachedPeerRoster {
    const row = this.options.foundation.store.db.query("SELECT roster_json, fetched_at, last_error, last_error_at FROM peer_roster_cache WHERE peer_instance_id = ?").get(peer.instance_id) as any;
    if (!row) return { roster: null, fetched_at: null, stale: true, error: null };
    const fetchedAt = String(row.fetched_at || "");
    return { roster: JSON.parse(row.roster_json), fetched_at: fetchedAt, stale: this.now().getTime() - Date.parse(fetchedAt) > ROSTER_CACHE_TTL_MS, error: row.last_error || null };
  }

  async refreshPeerRoster(peer: PeerRecord): Promise<CachedPeerRoster> {
    try {
      const roster = await this.fetchPeerRoster(peer);
      const fetchedAt = this.now().toISOString();
      this.options.foundation.store.db.query(`INSERT INTO peer_roster_cache (peer_instance_id, roster_json, roster_version, fetched_at, last_error, last_error_at)
        VALUES (?, ?, ?, ?, NULL, NULL) ON CONFLICT(peer_instance_id) DO UPDATE SET roster_json=excluded.roster_json,
        roster_version=excluded.roster_version, fetched_at=excluded.fetched_at, last_error=NULL, last_error_at=NULL`)
        .run(peer.instance_id, JSON.stringify(roster), roster.roster_version, fetchedAt);
      return { roster, fetched_at: fetchedAt, stale: false, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedAt = this.now().toISOString();
      this.options.foundation.store.db.query("UPDATE peer_roster_cache SET last_error = ?, last_error_at = ? WHERE peer_instance_id = ?")
        .run(message, failedAt, peer.instance_id);
      return { ...this.cachedPeerRoster(peer), stale: true, error: message };
    }
  }

  async getPeerRoster(peer: PeerRecord, refresh = false): Promise<CachedPeerRoster> {
    const cached = this.cachedPeerRoster(peer);
    if (!refresh && cached.roster && !cached.stale) return cached;
    return await this.refreshPeerRoster(peer);
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
    return parseRoster(payload, peer);
  }
}

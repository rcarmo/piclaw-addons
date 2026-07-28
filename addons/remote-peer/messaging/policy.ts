import type Database from "bun:sqlite";
import type { PeerRecord } from "../pairing/repository.js";

export type MessagingScope = PeerRecord["messaging_scope"];
export type ModeCeiling = PeerRecord["mode_ceiling"];
export type DeliveryMode = "queue" | "auto" | "steer";

export interface AdvertisedAgentRecord {
  agent_name: string;
  local_agent_name: string;
  enabled: number;
  allowed_modes: string;
  updated_at: string;
}

const ALIAS_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,63})$/;

export function parseAgentAlias(value: string): string | null {
  const alias = value.trim().toLowerCase().replace(/^@+/, "");
  return ALIAS_PATTERN.test(alias) ? alias : null;
}

export function normalizeAgentAlias(value: string): string {
  const alias = parseAgentAlias(value);
  if (!alias) throw new Error("Agent alias must be 1-64 lowercase letters, digits, underscores, or hyphens.");
  return alias;
}

export function parseAllowedModes(value: string): DeliveryMode[] {
  const modes = value.split(",").map(mode => mode.trim()).filter(Boolean) as DeliveryMode[];
  return modes.filter((mode, index) => ["queue", "auto", "steer"].includes(mode) && modes.indexOf(mode) === index);
}

export function modesForCeiling(ceiling: ModeCeiling): DeliveryMode[] {
  if (ceiling === "queue-auto-steer") return ["queue", "auto", "steer"];
  if (ceiling === "queue-auto") return ["queue", "auto"];
  return ["queue"];
}

export function isModeAllowed(peer: PeerRecord, agent: AdvertisedAgentRecord | null, mode: DeliveryMode): boolean {
  return modesForCeiling(peer.mode_ceiling).includes(mode) && (!agent || parseAllowedModes(agent.allowed_modes).includes(mode));
}

export class MessagingPolicyRepository {
  constructor(private readonly db: Database) {}

  listAdvertisedAgents(enabledOnly = true): AdvertisedAgentRecord[] {
    return (enabledOnly
      ? this.db.query("SELECT * FROM advertised_agents WHERE enabled = 1 ORDER BY agent_name").all()
      : this.db.query("SELECT * FROM advertised_agents ORDER BY agent_name").all()) as AdvertisedAgentRecord[];
  }

  getAdvertisedAgent(alias: string): AdvertisedAgentRecord | null {
    return this.db.query("SELECT * FROM advertised_agents WHERE agent_name = ? COLLATE NOCASE AND enabled = 1")
      .get(alias) as AdvertisedAgentRecord | null;
  }

  upsertAdvertisedAgent(alias: string, localAgentName: string, allowedModes: DeliveryMode[], now: string): AdvertisedAgentRecord {
    const agentName = normalizeAgentAlias(alias);
    const local = normalizeAgentAlias(localAgentName);
    const modes = [...new Set(allowedModes)];
    if (!modes.length || modes.some(mode => !["queue", "auto", "steer"].includes(mode))) throw new Error("Advertised agent must allow at least one valid mode.");
    this.db.query(`INSERT INTO advertised_agents (agent_name, local_agent_name, enabled, allowed_modes, updated_at)
      VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(agent_name) DO UPDATE SET local_agent_name=excluded.local_agent_name,
        enabled=1, allowed_modes=excluded.allowed_modes, updated_at=excluded.updated_at`)
      .run(agentName, local, modes.join(","), now);
    return this.getAdvertisedAgent(agentName)!;
  }

  disableAdvertisedAgent(alias: string, now: string): void {
    const result = this.db.query("UPDATE advertised_agents SET enabled = 0, updated_at = ? WHERE agent_name = ? COLLATE NOCASE")
      .run(now, normalizeAgentAlias(alias));
    if (result.changes === 0) throw new Error("Advertised agent not found.");
  }

  listPeerAgents(instanceId: string): string[] {
    return (this.db.query("SELECT agent_name FROM peer_agent_permissions WHERE peer_instance_id = ? ORDER BY agent_name")
      .all(instanceId) as Array<{ agent_name: string }>).map(row => row.agent_name);
  }

  setPeerAgents(instanceId: string, aliases: string[], now: string): string[] {
    const normalized = [...new Set(aliases.map(normalizeAgentAlias))];
    for (const alias of normalized) {
      if (!this.getAdvertisedAgent(alias)) throw new Error(`Advertised agent not found: ${alias}`);
    }
    this.db.transaction(() => {
      this.db.query("DELETE FROM peer_agent_permissions WHERE peer_instance_id = ?").run(instanceId);
      const insert = this.db.query("INSERT INTO peer_agent_permissions (peer_instance_id, agent_name, created_at) VALUES (?, ?, ?)");
      for (const alias of normalized) insert.run(instanceId, alias, now);
    }).immediate();
    return normalized;
  }

  peerAllowsAgent(peer: PeerRecord, alias: string): boolean {
    if (peer.messaging_scope === "all-advertised") return true;
    if (peer.messaging_scope !== "named-agents") return false;
    return this.db.query("SELECT 1 FROM peer_agent_permissions WHERE peer_instance_id = ? AND agent_name = ?")
      .get(peer.instance_id, alias) !== null;
  }

  updatePeerPolicy(instanceId: string, scope: MessagingScope, ceiling: ModeCeiling, now: string): PeerRecord {
    if (!["none", "inbox-only", "named-agents", "all-advertised"].includes(scope)) throw new Error("Invalid messaging scope.");
    if (!["queue", "queue-auto", "queue-auto-steer"].includes(ceiling)) throw new Error("Invalid mode ceiling.");
    this.db.query("UPDATE peers SET messaging_scope = ?, mode_ceiling = ?, updated_at = ? WHERE instance_id = ?")
      .run(scope, ceiling, now, instanceId);
    const peer = this.db.query("SELECT * FROM peers WHERE instance_id = ?").get(instanceId) as PeerRecord | null;
    if (!peer) throw new Error("Peer not found.");
    return peer;
  }
}

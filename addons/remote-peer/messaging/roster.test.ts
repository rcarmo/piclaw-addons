import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiclawRuntimeApi } from "../compat/runtime.js";
import type { RemotePeerFoundation } from "../foundation.js";
import { createRemotePeerIdentity } from "../identity.js";
import { verifyCanonical } from "../protocol/canonical.js";
import { openRemotePeerStore } from "../store/index.js";
import { RosterService, type PublicRoster } from "./roster.js";

const roots: string[] = [];
const foundations: RemotePeerFoundation[] = [];
const now = new Date("2026-01-01T00:00:00.000Z");

function foundation(): RemotePeerFoundation {
  const root = mkdtempSync(join(tmpdir(), "remote-peer-roster-"));
  roots.push(root);
  const store = openRemotePeerStore(root);
  const value: RemotePeerFoundation = {
    dataDir: root,
    identity: createRemotePeerIdentity(now),
    store,
    loadConfig: () => store.loadConfig(),
    saveConfig: config => store.saveConfig(config),
    close: () => store.close(),
  };
  foundations.push(value);
  return value;
}

function messaging(): NonNullable<PiclawRuntimeApi["messaging"]> {
  return {
    version: 1,
    registerChatTransport: () => () => {},
    getAddonDataDir: () => "",
    listAdvertisableAgents: async () => [
      { agent_name: "research-local", active: true },
      { agent_name: "other", active: false },
    ],
    resolveLocalTarget: async () => ({ status: "not_found" }),
    deliverPeerMessage: async () => { throw new Error("not used"); },
  };
}

afterEach(() => {
  foundations.splice(0).forEach(value => value.close());
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

describe("remote-peer advertised roster", () => {
  test("publishes only operator-selected aliases and signs the public projection", async () => {
    const local = foundation();
    const roster = new RosterService({ foundation: local, messaging: messaging(), now: () => now });
    roster.policy.upsertAdvertisedAgent("research", "research-local", ["queue", "auto"], now.toISOString());
    roster.policy.upsertAdvertisedAgent("stale", "missing-local", ["queue"], now.toISOString());

    const signed = await roster.signedRoster({ attachments_enabled: 1, max_attachment_bytes: 16 * 1024 * 1024 } as any);
    expect(signed.agents).toEqual([{
      name: "research",
      address: "peer!@research",
      accepts_messages: true,
      allowed_modes: ["queue", "auto"],
    }]);
    expect(signed.attachments).toEqual({ enabled: true, max_files: 4, max_file_bytes: 16 * 1024 * 1024, max_total_bytes: 32 * 1024 * 1024 });
    const inboxOnly = await roster.signedRoster({ attachments_enabled: 0, max_attachment_bytes: 0, messaging_scope: "inbox-only" } as any);
    expect(inboxOnly.agents).toEqual([]);
    expect(inboxOnly.attachments).toEqual({ enabled: false, max_files: 0, max_file_bytes: 0, max_total_bytes: 0 });
    const { roster_signature, ...unsigned } = signed;
    expect(verifyCanonical(local.identity.public_key, JSON.stringify(unsigned as PublicRoster), String(roster_signature))).toBe(true);
    expect(JSON.stringify(signed)).not.toContain("research-local");
  });

  test("caches the last verified peer roster and marks refresh failures stale", async () => {
    const local = foundation();
    const remote = foundation();
    const remoteRoster = new RosterService({ foundation: remote, messaging: messaging(), now: () => now });
    remoteRoster.policy.upsertAdvertisedAgent("research", "research-local", ["queue"], now.toISOString());
    let fail = false;
    const fetchFn: typeof fetch = async (_input, init) => {
      if (fail) return new Response(JSON.stringify({ error: "offline" }), { status: 503 });
      return await remoteRoster.receive({ instance_id: local.identity.instance_id, messaging_scope: "named-agents", attachments_enabled: 1, max_attachment_bytes: 16 * 1024 * 1024 } as any);
    };
    const localRoster = new RosterService({ foundation: local, messaging: messaging(), fetch: fetchFn, now: () => now });
    const peer = { instance_id: remote.identity.instance_id, peer_alias: "remote", public_key: remote.identity.public_key, fingerprint: remote.identity.fingerprint, display_name: "Remote", base_url: "https://remote.test", status: "paired", trust_epoch: 1, messaging_scope: "named-agents", mode_ceiling: "queue", created_at: now.toISOString(), updated_at: now.toISOString(), last_seen_at: now.toISOString(), blocked_reason: null } as any;
    local.store.db.query(`INSERT INTO peers (instance_id, peer_alias, public_key, fingerprint, display_name, base_url, status, trust_epoch, messaging_scope, mode_ceiling, created_at, updated_at, last_seen_at, blocked_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(peer.instance_id, peer.peer_alias, peer.public_key, peer.fingerprint, peer.display_name, peer.base_url, peer.status, peer.trust_epoch, peer.messaging_scope, peer.mode_ceiling, peer.created_at, peer.updated_at, peer.last_seen_at, peer.blocked_reason);
    const fresh = await localRoster.refreshPeerRoster(peer);
    expect(fresh.stale).toBe(false);
    expect(fresh.roster?.agents[0]?.name).toBe("research");
    fail = true;
    const stale = await localRoster.refreshPeerRoster(peer);
    expect(stale.stale).toBe(true);
    expect(stale.error).toContain("offline");
    expect(stale.roster?.agents[0]?.name).toBe("research");
  });

  test("rejects disabled aliases and keeps configured aliases unique", async () => {
    const local = foundation();
    const roster = new RosterService({ foundation: local, messaging: messaging(), now: () => now });
    roster.policy.upsertAdvertisedAgent("research", "research-local", ["queue"], now.toISOString());
    roster.policy.upsertAdvertisedAgent("research", "other", ["queue", "auto"], now.toISOString());
    expect(roster.policy.listAdvertisedAgents()).toHaveLength(1);
    expect(roster.policy.getAdvertisedAgent("research")?.local_agent_name).toBe("other");
    roster.policy.disableAdvertisedAgent("research", now.toISOString());
    expect((await roster.publicRoster()).agents).toEqual([]);
  });
});

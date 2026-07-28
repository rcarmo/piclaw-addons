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

    const signed = await roster.signedRoster();
    expect(signed.agents).toEqual([{
      name: "research",
      address: "peer!@research",
      accepts_messages: true,
      allowed_modes: ["queue", "auto"],
    }]);
    const { roster_signature, ...unsigned } = signed;
    expect(verifyCanonical(local.identity.public_key, JSON.stringify(unsigned as PublicRoster), String(roster_signature))).toBe(true);
    expect(JSON.stringify(signed)).not.toContain("research-local");
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

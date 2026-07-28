import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRemotePeerIdentity,
  deriveInstanceId,
  loadOrCreateRemotePeerIdentity,
  rotateRemotePeerIdentity,
  validateRemotePeerIdentity,
} from "./identity.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "remote-peer-identity-"));
  roots.push(root);
  return root;
}

describe("remote-peer identity", () => {
  test("creates a stable Ed25519 identity with a key-derived instance id", () => {
    const identity = createRemotePeerIdentity(new Date("2026-07-28T00:00:00Z"));
    expect(identity.version).toBe(1);
    expect(identity.instance_id).toBe(deriveInstanceId(identity.public_key));
    expect(identity.fingerprint).toHaveLength(20);
    expect(identity.private_key).not.toBe(identity.public_key);
    expect(validateRemotePeerIdentity(identity)).toEqual(identity);
  });

  test("writes mode 0600 and reuses the stored identity", () => {
    const root = tempRoot();
    const first = loadOrCreateRemotePeerIdentity(root);
    const second = loadOrCreateRemotePeerIdentity(root);
    expect(second).toEqual(first);
    if (process.platform !== "win32") {
      expect(statSync(join(root, "identity.json")).mode & 0o777).toBe(0o600);
    }
  });

  test("rotates through a mode-0600 backup and writes a fresh identity", () => {
    const root = tempRoot();
    const first = loadOrCreateRemotePeerIdentity(root);
    const second = rotateRemotePeerIdentity(root, new Date("2026-01-02T00:00:00.000Z"));
    expect(second.instance_id).not.toBe(first.instance_id);
    expect(loadOrCreateRemotePeerIdentity(root).instance_id).toBe(second.instance_id);
    const backups = readdirSync(join(root, "backups")).filter(name => name.startsWith("identity-"));
    expect(backups).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(root, "backups", backups[0]), "utf8")).instance_id).toBe(first.instance_id);
    if (process.platform !== "win32") expect(statSync(join(root, "backups", backups[0])).mode & 0o777).toBe(0o600);
  });

  test("rejects tampered identity data", () => {
    const root = tempRoot();
    const identity = loadOrCreateRemotePeerIdentity(root);
    writeFileSync(join(root, "identity.json"), JSON.stringify({ ...identity, instance_id: "tampered" }));
    expect(() => loadOrCreateRemotePeerIdentity(root)).toThrow("does not match public_key");
    expect(readFileSync(join(root, "identity.json"), "utf8")).toContain("tampered");
  });
});

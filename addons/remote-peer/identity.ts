import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";

export interface RemotePeerIdentity {
  version: 1;
  instance_id: string;
  fingerprint: string;
  public_key: string;
  private_key: string;
  created_at: string;
}

function b64url(value: Buffer): string {
  return value.toString("base64url");
}

export function deriveInstanceId(publicKey: string): string {
  return b64url(createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest());
}

export function formatFingerprint(instanceId: string): string {
  return `${instanceId.slice(0, 6)}-${instanceId.slice(6, 12)}-${instanceId.slice(12, 18)}`;
}

export function isValidRemotePeerPublicKey(publicKey: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, "base64url"), format: "der", type: "spki" });
    return key.asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

export function createRemotePeerIdentity(now = new Date()): RemotePeerIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { format: "der", type: "spki" },
    privateKeyEncoding: { format: "der", type: "pkcs8" },
  });
  const publicKeyEncoded = b64url(publicKey);
  const instanceId = deriveInstanceId(publicKeyEncoded);
  return {
    version: 1,
    instance_id: instanceId,
    fingerprint: formatFingerprint(instanceId),
    public_key: publicKeyEncoded,
    private_key: b64url(privateKey),
    created_at: now.toISOString(),
  };
}

export function validateRemotePeerIdentity(value: unknown): RemotePeerIdentity {
  if (!value || typeof value !== "object") throw new Error("Invalid remote-peer identity file.");
  const identity = value as Record<string, unknown>;
  if (identity.version !== 1) throw new Error("Unsupported remote-peer identity version.");
  for (const field of ["instance_id", "fingerprint", "public_key", "private_key", "created_at"] as const) {
    if (typeof identity[field] !== "string" || !identity[field]) throw new Error(`Remote-peer identity is missing ${field}.`);
  }
  const instanceId = deriveInstanceId(String(identity.public_key));
  if (instanceId !== identity.instance_id) throw new Error("Remote-peer identity instance_id does not match public_key.");
  if (formatFingerprint(instanceId) !== identity.fingerprint) throw new Error("Remote-peer identity fingerprint does not match instance_id.");
  return identity as unknown as RemotePeerIdentity;
}

export function loadOrCreateRemotePeerIdentity(dataDir: string): RemotePeerIdentity {
  const path = join(dataDir, "identity.json");
  if (existsSync(path)) {
    return validateRemotePeerIdentity(JSON.parse(readFileSync(path, "utf8")));
  }

  mkdirSync(dirname(path), { recursive: true });
  const identity = createRemotePeerIdentity();
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  if (process.platform !== "win32") chmodSync(path, 0o600);
  return identity;
}

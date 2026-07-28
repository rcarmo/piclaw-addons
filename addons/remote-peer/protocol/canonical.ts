import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify } from "node:crypto";
import type { RemotePeerIdentity } from "../identity.js";

export const REMOTE_PROTOCOL_VERSION = 1;
export const REMOTE_SIGNATURE_VERSION = "v1";
export const DEFAULT_TIMESTAMP_SKEW_MS = 90_000;

export interface CanonicalRequestInput {
  method: string;
  pathWithQuery: string;
  contentType: string;
  bodyHash: string;
  timestamp: string;
  nonce: string;
  instanceId: string;
  trustEpoch: string;
}

export function hashBody(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

export function buildCanonicalRequest(input: CanonicalRequestInput): string {
  return [
    input.method.toUpperCase(),
    input.pathWithQuery,
    input.contentType,
    input.bodyHash,
    input.timestamp,
    input.nonce,
    input.instanceId,
    REMOTE_SIGNATURE_VERSION,
    input.trustEpoch,
  ].join("\n");
}

export function signCanonical(identity: RemotePeerIdentity, canonical: string): string {
  const key = createPrivateKey({ key: Buffer.from(identity.private_key, "base64url"), format: "der", type: "pkcs8" });
  return sign(null, Buffer.from(canonical, "utf8"), key).toString("base64url");
}

export function verifyCanonical(publicKey: string, canonical: string, signature: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, "base64url"), format: "der", type: "spki" });
    return verify(null, Buffer.from(canonical, "utf8"), key, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

export function buildSignedHeaders(
  identity: RemotePeerIdentity,
  pathWithQuery: string,
  body: Uint8Array,
  trustEpoch = 1,
  timestamp = new Date().toISOString(),
  nonce = randomUUID(),
): Record<string, string> {
  const canonical = buildCanonicalRequest({
    method: "POST",
    pathWithQuery,
    contentType: "application/json",
    bodyHash: hashBody(body),
    timestamp,
    nonce,
    instanceId: identity.instance_id,
    trustEpoch: String(trustEpoch),
  });
  return {
    "Content-Type": "application/json",
    "X-Instance-Id": identity.instance_id,
    "X-Timestamp": timestamp,
    "X-Nonce": nonce,
    "X-Sig-Version": REMOTE_SIGNATURE_VERSION,
    "X-Signature": signCanonical(identity, canonical),
    "X-Trust-Epoch": String(trustEpoch),
  };
}

export function buildCallbackProof(requestId: string, challenge: string, receiverInstanceId: string): string {
  return `${requestId}\n${challenge}\n${receiverInstanceId}`;
}

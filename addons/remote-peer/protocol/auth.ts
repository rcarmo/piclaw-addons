import { buildCanonicalRequest, DEFAULT_TIMESTAMP_SKEW_MS, hashBody, verifyCanonical } from "./canonical.js";
import type { NonceReplayCache } from "./nonce-cache.js";

export interface SignedPeer {
  instance_id: string;
  public_key: string;
  trust_epoch: number;
}

export type SignatureResult = { ok: true } | { ok: false; error: string };

function parseTimestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function verifySignedRequestHash(
  req: Request,
  bodyHash: string,
  peer: SignedPeer,
  nonceCache: NonceReplayCache,
  now = Date.now(),
): SignatureResult {
  const instanceId = req.headers.get("x-instance-id") || "";
  const timestamp = req.headers.get("x-timestamp") || "";
  const nonce = req.headers.get("x-nonce") || "";
  const sigVersion = req.headers.get("x-sig-version") || "";
  const signature = req.headers.get("x-signature") || "";
  const trustEpoch = req.headers.get("x-trust-epoch") || "";
  if (!instanceId || !timestamp || !nonce || !sigVersion || !signature || !trustEpoch) return { ok: false, error: "Missing signature headers." };
  if (instanceId !== peer.instance_id) return { ok: false, error: "Mismatched instance id." };
  if (sigVersion !== "v1") return { ok: false, error: "Unsupported signature version." };
  if (Number(trustEpoch) !== peer.trust_epoch) return { ok: false, error: "Stale trust epoch." };
  const parsed = parseTimestamp(timestamp);
  if (parsed === null || Math.abs(now - parsed) > DEFAULT_TIMESTAMP_SKEW_MS) return { ok: false, error: "Timestamp skew too large." };

  const url = new URL(req.url);
  const canonical = buildCanonicalRequest({
    method: req.method,
    pathWithQuery: `${url.pathname}${url.search}`,
    contentType: req.headers.get("content-type") || "",
    bodyHash,
    timestamp,
    nonce,
    instanceId,
    trustEpoch,
  });
  if (!verifyCanonical(peer.public_key, canonical, signature)) return { ok: false, error: "Signature verification failed." };
  if (!nonceCache.checkAndStore(peer.instance_id, nonce, now)) return { ok: false, error: "Replay detected." };
  return { ok: true };
}

export function verifySignedRequest(
  req: Request,
  body: Uint8Array,
  peer: SignedPeer,
  nonceCache: NonceReplayCache,
  now = Date.now(),
): SignatureResult {
  return verifySignedRequestHash(req, hashBody(body), peer, nonceCache, now);
}

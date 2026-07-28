import { randomUUID } from "node:crypto";
import type { RemotePeerFoundation } from "../foundation.js";
import { deriveInstanceId, formatFingerprint, isValidRemotePeerPublicKey } from "../identity.js";
import {
  buildCallbackProof,
  buildSignedHeaders,
  REMOTE_PROTOCOL_VERSION,
  signCanonical,
  verifyCanonical,
} from "../protocol/canonical.js";
import { verifySignedRequest } from "../protocol/auth.js";
import { NonceReplayCache } from "../protocol/nonce-cache.js";
import { baseUrl, validatePeerUrl, type ResolveHost } from "./ssrf.js";
import { PairingRepository, type InboundPairRecord, type PeerRecord } from "./repository.js";

const MAX_BODY_BYTES = 32 * 1024;
const PAIR_TTL_MS = 60 * 60_000;
const CALLBACK_TIMEOUT_MS = 5_000;

class SlidingLimiter {
  private readonly entries = new Map<string, number[]>();
  constructor(private readonly limit: number, private readonly windowMs: number, private readonly maxKeys = 10_000) {}
  allow(key: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const live = (this.entries.get(key) ?? []).filter(value => value > cutoff);
    if (live.length >= this.limit) { this.entries.set(key, live); return false; }
    live.push(now);
    this.entries.delete(key);
    this.entries.set(key, live);
    while (this.entries.size > this.maxKeys) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return true;
  }
}

export interface PairingServiceOptions {
  foundation: RemotePeerFoundation;
  fetch?: typeof fetch;
  resolveHost?: ResolveHost;
  now?: () => Date;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = await response.json();
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch (error) {
    if (response.ok) throw new Error("Peer returned invalid JSON.", { cause: error });
  }
  return {};
}

type ParsedJsonBody = { body: Record<string, unknown>; bytes: Uint8Array };

async function readJson(req: Request): Promise<ParsedJsonBody | Response> {
  if (!(req.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) return json({ error: "Content-Type must be application/json." }, 415);
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) return json({ error: "Request body too large." }, 413);
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === "object" && !Array.isArray(value)
      ? { body: value as Record<string, unknown>, bytes }
      : json({ error: "JSON body must be an object." }, 400);
  } catch { return json({ error: "Invalid JSON body." }, 400); }
}

function stringField(body: Record<string, unknown>, key: string, max = 2048): string {
  const value = typeof body[key] === "string" ? body[key].trim() : "";
  return value.length <= max ? value : "";
}

function slug(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

export class PairingService {
  readonly repository: PairingRepository;
  readonly nonceCache = new NonceReplayCache();
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;
  private readonly pairLimiter = new SlidingLimiter(3, 10 * 60_000);
  private readonly signedLimiter = new SlidingLimiter(60, 60_000);

  constructor(private readonly options: PairingServiceOptions) {
    this.repository = new PairingRepository(options.foundation.store.db);
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  private uniqueAlias(preferred: string, instanceId: string): string {
    const base = slug(preferred) || `peer-${instanceId.slice(0, 8).toLowerCase()}`;
    let candidate = base;
    let suffix = 1;
    while (true) {
      const existing = this.repository.getPeerByAlias(candidate);
      if (!existing || existing.instance_id === instanceId) return candidate;
      suffix += 1;
      candidate = `${base.slice(0, 54)}-${suffix}`;
    }
  }

  private peerFromPair(input: {
    instanceId: string; publicKey: string; fingerprint: string; displayName: string | null; baseUrl: string; trustEpoch?: number;
  }): PeerRecord {
    const existing = this.repository.getPeer(input.instanceId);
    const now = this.now().toISOString();
    return {
      instance_id: input.instanceId,
      peer_alias: existing?.peer_alias ?? this.uniqueAlias(input.displayName || "", input.instanceId),
      public_key: input.publicKey,
      fingerprint: input.fingerprint,
      display_name: input.displayName,
      base_url: input.baseUrl,
      status: "paired",
      trust_epoch: input.trustEpoch ?? (existing ? existing.trust_epoch + 1 : 1),
      messaging_scope: existing?.messaging_scope ?? "inbox-only",
      mode_ceiling: existing?.mode_ceiling ?? "queue",
      created_at: existing?.created_at ?? now,
      updated_at: now,
      last_seen_at: now,
      blocked_reason: null,
    };
  }

  private requireEnabled(): Response | null {
    return this.options.foundation.loadConfig().enabled ? null : json({ error: "Remote Peer is disabled." }, 503);
  }

  async initiatePairing(targetUrl: string): Promise<Record<string, unknown>> {
    const config = this.options.foundation.loadConfig();
    if (!config.enabled) throw new Error("Remote Peer is disabled in Settings.");
    if (!config.externalUrl) throw new Error("Configure this instance's external URL before pairing.");
    const target = await validatePeerUrl(targetUrl, config, this.options.resolveHost);
    if (!target.ok) throw new Error(target.error);
    const callbackBase = await validatePeerUrl(config.externalUrl, config, this.options.resolveHost);
    if (!callbackBase.ok) throw new Error(`Configured external URL is invalid: ${callbackBase.error}`);

    const identity = this.options.foundation.identity;
    const targetBaseUrl = baseUrl(target.url);
    const previousTarget = this.repository.getPeerByBaseUrl(targetBaseUrl);
    const nonce = randomUUID();
    const expiresAt = new Date(this.now().getTime() + PAIR_TTL_MS).toISOString();
    const body = {
      instance_id: identity.instance_id,
      public_key: identity.public_key,
      display_name: config.instanceName || null,
      callback_url: `${baseUrl(callbackBase.url)}/api/addons/remote-peer/v1/pair-callback`,
      protocol_version: REMOTE_PROTOCOL_VERSION,
      trust_epoch: (previousTarget?.trust_epoch ?? 0) + 1,
      nonce,
      expires_at: expiresAt,
    };
    const response = await this.fetchFn(`${baseUrl(target.url)}/api/addons/remote-peer/v1/pair-request`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
    });
    const result = await responseJson(response);
    if (!response.ok) throw new Error(String(result.error || `Pair request failed (${response.status}).`));
    const requestId = stringField(result, "request_id", 128);
    const receiverId = stringField(result, "receiver_instance_id", 256);
    const receiverKey = stringField(result, "receiver_public_key", 4096);
    if (!requestId || !receiverId || !receiverKey || !isValidRemotePeerPublicKey(receiverKey) || deriveInstanceId(receiverKey) !== receiverId) throw new Error("Peer returned invalid pairing identity.");
    const previous = this.repository.getPeer(receiverId);
    if (previousTarget && previousTarget.instance_id !== receiverId) throw new Error("Peer URL now identifies a different instance.");
    this.repository.createOutbound({
      id: requestId, instance_id: receiverId, public_key: receiverKey, fingerprint: formatFingerprint(receiverId),
      base_url: targetBaseUrl, nonce, status: "pending", trust_epoch: (previous?.trust_epoch ?? 0) + 1, expires_at: expiresAt,
      created_at: this.now().toISOString(), updated_at: this.now().toISOString(),
    });
    this.repository.audit(receiverId, "pair_request_outbound", "pending", undefined, { request_id: requestId });
    return { status: "pending", request_id: requestId, peer_instance_id: receiverId, peer_fingerprint: formatFingerprint(receiverId) };
  }

  async acceptInbound(requestId: string): Promise<PeerRecord> {
    const record = this.repository.getInbound(requestId);
    if (!record || record.status !== "pending") throw new Error("Pending pair request not found.");
    if (Date.parse(record.expires_at) <= this.now().getTime()) { this.repository.updateInbound(requestId, "expired"); throw new Error("Pair request expired."); }
    const config = this.options.foundation.loadConfig();
    const receiver = this.options.foundation.identity;
    const callbackBody = JSON.stringify({
      request_id: record.id, challenge: record.nonce, receiver_instance_id: receiver.instance_id,
    });
    const proofResponse = await this.fetchFn(record.callback_url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: callbackBody,
      signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
    });
    const proof = await responseJson(proofResponse);
    const signature = stringField(proof, "signature", 4096);
    if (!proofResponse.ok || stringField(proof, "request_id", 128) !== record.id
      || stringField(proof, "challenge", 256) !== record.nonce
      || stringField(proof, "instance_id", 256) !== record.instance_id
      || !verifyCanonical(record.public_key, buildCallbackProof(record.id, record.nonce, receiver.instance_id), signature)) {
      this.repository.updateInbound(requestId, "failed");
      throw new Error("Peer URL ownership proof failed.");
    }
    const callbackUrl = new URL(record.callback_url);
    const peer = this.peerFromPair({
      instanceId: record.instance_id, publicKey: record.public_key, fingerprint: record.fingerprint,
      displayName: record.display_name, baseUrl: `${callbackUrl.protocol}//${callbackUrl.host}`, trustEpoch: record.trust_epoch,
    });
    this.options.foundation.store.db.transaction(() => {
      this.repository.upsertPeer(peer);
      this.repository.updateInbound(requestId, "accepted");
    }).immediate();

    const confirmPath = "/api/addons/remote-peer/v1/pair-confirm";
    const confirmBody = JSON.stringify({
      request_id: record.id,
      receiver_display_name: config.instanceName || null,
      trust_epoch: record.trust_epoch,
    });
    const bytes = new TextEncoder().encode(confirmBody);
    const response = await this.fetchFn(`${peer.base_url}${confirmPath}`, {
      method: "POST", headers: buildSignedHeaders(receiver, confirmPath, bytes, record.trust_epoch, this.now().toISOString()), body: confirmBody,
      signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
    });
    if (!response.ok) {
      this.options.foundation.store.db.transaction(() => {
        this.repository.updateInbound(requestId, "failed");
        this.repository.updatePeer(peer.instance_id, { ...peer, status: "revoked", trust_epoch: peer.trust_epoch + 1, updated_at: this.now().toISOString(), last_seen_at: peer.last_seen_at, blocked_reason: "pair-confirm-failed" });
      }).immediate();
      this.repository.audit(peer.instance_id, "pair_confirm_outbound", "failed", `HTTP ${response.status}`, { request_id: requestId });
      throw new Error(`Peer pairing confirmation failed (${response.status}).`);
    }
    this.repository.audit(peer.instance_id, "pair_accept", "paired", undefined, { request_id: requestId });
    return peer;
  }

  denyInbound(requestId: string): void {
    const record = this.repository.getInbound(requestId);
    if (!record || record.status !== "pending") throw new Error("Pending pair request not found.");
    this.repository.updateInbound(requestId, "denied");
    this.repository.audit(record.instance_id, "pair_deny", "denied", undefined, { request_id: requestId });
  }

  setAlias(reference: string, value: string): PeerRecord {
    const peer = this.repository.resolvePeer(reference);
    if (!peer) throw new Error("Peer not found.");
    const alias = slug(value);
    if (!alias || alias !== value.trim().toLowerCase() || alias.length > 48) throw new Error("Alias must be 1-48 lowercase letters, digits, dots, underscores, or hyphens.");
    const existing = this.repository.getPeerByAlias(alias);
    if (existing && existing.instance_id !== peer.instance_id) throw new Error("Peer alias is already in use.");
    const updated = { ...peer, peer_alias: alias, updated_at: this.now().toISOString() };
    this.repository.updatePeerAlias(peer.instance_id, alias, updated.updated_at);
    this.repository.audit(peer.instance_id, "alias_update", "updated", undefined, { alias });
    return updated;
  }

  async ping(reference: string): Promise<Record<string, unknown>> {
    const peer = this.repository.resolvePeer(reference);
    if (!peer || peer.status !== "paired" || !peer.base_url) throw new Error("Paired peer not found.");
    const path = "/api/addons/remote-peer/v1/ping";
    const body = JSON.stringify({ time: this.now().toISOString() });
    const bytes = new TextEncoder().encode(body);
    const response = await this.fetchFn(`${peer.base_url}${path}`, {
      method: "POST", headers: buildSignedHeaders(this.options.foundation.identity, path, bytes, peer.trust_epoch, this.now().toISOString()), body,
      signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
    });
    const result = await responseJson(response);
    if (!response.ok) throw new Error(String(result.error || `Peer ping failed (${response.status}).`));
    this.repository.updatePeer(peer.instance_id, { ...peer, status: "paired", updated_at: this.now().toISOString(), last_seen_at: this.now().toISOString(), blocked_reason: null });
    this.repository.audit(peer.instance_id, "ping_outbound", "ok");
    return result;
  }

  async revoke(reference: string): Promise<{ peer: PeerRecord; remote_notified: boolean }> {
    const peer = this.repository.resolvePeer(reference);
    if (!peer || peer.status !== "paired") throw new Error("Paired peer not found.");
    let remoteNotified = false;
    if (peer.base_url) {
      const path = "/api/addons/remote-peer/v1/revoke";
      const body = JSON.stringify({ reason: "operator-revoked" });
      const bytes = new TextEncoder().encode(body);
      try {
        const response = await this.fetchFn(`${peer.base_url}${path}`, {
          method: "POST", headers: buildSignedHeaders(this.options.foundation.identity, path, bytes, peer.trust_epoch, this.now().toISOString()), body,
          signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
        });
        remoteNotified = response.ok;
        if (!response.ok) this.repository.audit(peer.instance_id, "revoke_outbound", "failed", `HTTP ${response.status}`);
      } catch (error) {
        this.repository.audit(peer.instance_id, "revoke_outbound", "failed", error instanceof Error ? error.message : String(error));
      }
    }
    const updated = { ...peer, status: "revoked" as const, trust_epoch: peer.trust_epoch + 1, updated_at: this.now().toISOString(), last_seen_at: peer.last_seen_at, blocked_reason: "operator-revoked" };
    this.repository.updatePeer(peer.instance_id, updated);
    this.repository.audit(peer.instance_id, "revoke_local", "revoked");
    return { peer: updated, remote_notified: remoteNotified };
  }

  async handle(req: Request, pathname: string): Promise<Response> {
    const disabled = this.requireEnabled();
    if (disabled) return disabled;
    if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
    const route = pathname.replace(/\/+$/, "");
    const prefix = "/api/addons/remote-peer/v1";
    if (route === `${prefix}/pair-request`) return await this.handlePairRequest(req, "external");
    if (route === `${prefix}/pair-callback`) return await this.handlePairCallback(req);
    if (route === `${prefix}/pair-confirm`) return await this.handlePairConfirm(req);
    if (route === `${prefix}/ping`) return await this.handlePing(req);
    if (route === `${prefix}/revoke`) return await this.handleRevoke(req);
    return json({ error: "Not found." }, 404);
  }

  private async handlePairRequest(req: Request, sourceKey: string): Promise<Response> {
    const parsed = await readJson(req); if (parsed instanceof Response) return parsed;
    const body = parsed.body;
    const instanceId = stringField(body, "instance_id", 256);
    const publicKey = stringField(body, "public_key", 4096);
    const displayName = stringField(body, "display_name", 128) || null;
    const proposedTrustEpoch = Number(body.trust_epoch);
    const callbackUrl = stringField(body, "callback_url", 2048);
    const nonce = stringField(body, "nonce", 256);
    const expiresAt = stringField(body, "expires_at", 64);
    if (Number(body.protocol_version) !== REMOTE_PROTOCOL_VERSION || !Number.isInteger(proposedTrustEpoch) || proposedTrustEpoch < 1 || !instanceId || !publicKey || !callbackUrl || !nonce || !expiresAt) return json({ error: "Missing or invalid pairing fields." }, 400);
    if (!isValidRemotePeerPublicKey(publicKey) || deriveInstanceId(publicKey) !== instanceId) return json({ error: "instance_id does not match a valid Ed25519 public_key." }, 400);
    const existing = this.repository.getPeer(instanceId);
    if (existing?.status === "blocked") return json({ error: "Peer is blocked." }, 403);
    if (existing?.status === "paired") return json({ error: "Peer is already paired." }, 409);
    if (!this.pairLimiter.allow(`${sourceKey}:${instanceId}`)) return json({ error: "Pairing rate limit exceeded." }, 429);
    const expiry = Date.parse(expiresAt);
    if (!Number.isFinite(expiry) || expiry <= this.now().getTime() || expiry > this.now().getTime() + 24 * 60 * 60_000) return json({ error: "expires_at is out of range." }, 400);
    const config = this.options.foundation.loadConfig();
    const checked = await validatePeerUrl(callbackUrl, config, this.options.resolveHost);
    if (!checked.ok) return json({ error: checked.error }, 400);
    const requestId = `pair_${randomUUID()}`;
    const now = this.now().toISOString();
    const record: InboundPairRecord = {
      id: requestId, instance_id: instanceId, public_key: publicKey, fingerprint: formatFingerprint(instanceId),
      display_name: displayName, callback_url: checked.url.toString(), protocol_version: REMOTE_PROTOCOL_VERSION,
      nonce,
      status: "pending",
      source_key: sourceKey,
      trust_epoch: Math.max(proposedTrustEpoch, (existing?.trust_epoch ?? 0) + 1),
      expires_at: expiresAt, created_at: now, updated_at: now,
    };
    this.repository.createInbound(record);
    this.repository.audit(instanceId, "pair_request_inbound", "pending", undefined, { request_id: requestId });
    const identity = this.options.foundation.identity;
    return json({
      status: "pending", request_id: requestId, expires_at: expiresAt,
      receiver_instance_id: identity.instance_id, receiver_public_key: identity.public_key,
      receiver_fingerprint: identity.fingerprint,
    }, 202);
  }

  private async handlePairCallback(req: Request): Promise<Response> {
    const parsed = await readJson(req); if (parsed instanceof Response) return parsed;
    const requestId = stringField(parsed.body, "request_id", 128);
    const challenge = stringField(parsed.body, "challenge", 256);
    const receiverId = stringField(parsed.body, "receiver_instance_id", 256);
    const outbound = this.repository.getOutbound(requestId);
    if (!outbound || outbound.status !== "pending") return json({ error: "Pair request not found." }, 404);
    if (Date.parse(outbound.expires_at) <= this.now().getTime()) { this.repository.updateOutbound(requestId, "expired"); return json({ error: "Pair request expired." }, 410); }
    if (challenge !== outbound.nonce || receiverId !== outbound.instance_id) return json({ error: "Pair challenge mismatch." }, 400);
    const identity = this.options.foundation.identity;
    return json({ request_id: requestId, challenge, instance_id: identity.instance_id, signature: signCanonical(identity, buildCallbackProof(requestId, challenge, receiverId)) });
  }

  private async signedBody(req: Request): Promise<{ peer: PeerRecord; body: Record<string, unknown> } | Response> {
    const parsed = await readJson(req); if (parsed instanceof Response) return parsed;
    const instanceId = req.headers.get("x-instance-id") || "";
    const peer = this.repository.getPeer(instanceId);
    if (!peer || peer.status !== "paired") return json({ error: "Peer not paired." }, 403);
    if (!this.signedLimiter.allow(instanceId)) return json({ error: "Signed endpoint rate limit exceeded." }, 429);
    const verified = verifySignedRequest(req, parsed.bytes, peer, this.nonceCache, this.now().getTime());
    if (!verified.ok) return json({ error: verified.error }, 401);
    return { peer, body: parsed.body };
  }

  private async handlePairConfirm(req: Request): Promise<Response> {
    const parsed = await readJson(req); if (parsed instanceof Response) return parsed;
    const requestId = stringField(parsed.body, "request_id", 128);
    const outbound = this.repository.getOutbound(requestId);
    if (!outbound || outbound.status !== "pending") return json({ error: "Pair request not found." }, 404);
    if (Date.parse(outbound.expires_at) <= this.now().getTime()) { this.repository.updateOutbound(requestId, "expired"); return json({ error: "Pair request expired." }, 410); }
    const trustEpoch = Number(parsed.body.trust_epoch);
    if (!Number.isInteger(trustEpoch) || trustEpoch < outbound.trust_epoch) return json({ error: "Invalid trust epoch." }, 400);
    const pseudo = { instance_id: outbound.instance_id, public_key: outbound.public_key, trust_epoch: trustEpoch };
    const verified = verifySignedRequest(req, parsed.bytes, pseudo, this.nonceCache, this.now().getTime());
    if (!verified.ok) return json({ error: verified.error }, 401);
    const displayName = stringField(parsed.body, "receiver_display_name", 128) || null;
    const peer = this.peerFromPair({
      instanceId: outbound.instance_id,
      publicKey: outbound.public_key,
      fingerprint: outbound.fingerprint,
      displayName,
      baseUrl: outbound.base_url,
      trustEpoch,
    });
    this.options.foundation.store.db.transaction(() => { this.repository.upsertPeer(peer); this.repository.updateOutbound(requestId, "accepted"); }).immediate();
    this.repository.audit(peer.instance_id, "pair_confirm_inbound", "paired", undefined, { request_id: requestId });
    return json({ status: "paired", peer_instance_id: peer.instance_id, peer_fingerprint: peer.fingerprint });
  }

  private async handlePing(req: Request): Promise<Response> {
    const verified = await this.signedBody(req); if (verified instanceof Response) return verified;
    this.repository.updatePeer(verified.peer.instance_id, { ...verified.peer, status: "paired", updated_at: this.now().toISOString(), last_seen_at: this.now().toISOString(), blocked_reason: null });
    const identity = this.options.foundation.identity;
    return json({ status: "ok", instance_id: identity.instance_id, fingerprint: identity.fingerprint, instance_name: this.options.foundation.loadConfig().instanceName || null, time: this.now().toISOString() });
  }

  private async handleRevoke(req: Request): Promise<Response> {
    const verified = await this.signedBody(req); if (verified instanceof Response) return verified;
    this.repository.updatePeer(verified.peer.instance_id, { ...verified.peer, status: "revoked", trust_epoch: verified.peer.trust_epoch + 1, updated_at: this.now().toISOString(), last_seen_at: verified.peer.last_seen_at, blocked_reason: "peer-revoked" });
    this.repository.audit(verified.peer.instance_id, "revoke_inbound", "revoked");
    return json({ status: "revoked", trust_epoch: verified.peer.trust_epoch + 1 });
  }
}

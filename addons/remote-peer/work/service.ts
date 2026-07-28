import { createHash, randomUUID } from "node:crypto";
import type { PiclawRuntimeApi } from "../compat/runtime.js";
import type { RemotePeerFoundation } from "../foundation.js";
import type { PeerRecord } from "../pairing/repository.js";
import { buildSignedHeaders } from "../protocol/canonical.js";
import { WorkRepository, type WorkRecord, type WorkStatus } from "./repository.js";

const PROPOSAL_PATH = "/api/addons/remote-peer/v1/proposal";
const EXECUTE_PATH = "/api/addons/remote-peer/v1/execute";
const RESULT_PATH = "/api/addons/remote-peer/v1/result";
const MAX_PROMPT_BYTES = 32 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;
const CALLBACK_TIMEOUT_MS = 10_000;
const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 3_600_000];

export interface WorkServiceOptions {
  foundation: RemotePeerFoundation;
  runtime: PiclawRuntimeApi;
  fetch?: typeof fetch;
  now?: () => Date;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function clean(value: unknown, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length <= max ? text : "";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter(item => typeof item === "string").map(item => item.trim()).filter(Boolean))] : [];
}

function publicWork(record: WorkRecord): Record<string, unknown> {
  return {
    request_id: record.id,
    peer_instance_id: record.peer_instance_id,
    direction: record.direction,
    status: record.status,
    request_type: record.request_type,
    prompt: record.prompt,
    capability_profile: record.capability_profile,
    requested_capabilities: JSON.parse(record.requested_capabilities_json),
    allowed_capabilities: JSON.parse(record.allowed_capabilities_json),
    chain: record.chain_id ? { id: record.chain_id, hop: record.chain_hop } : null,
    result: record.result,
    error: record.error,
    created_at: record.created_at,
    updated_at: record.updated_at,
    completed_at: record.completed_at,
  };
}

export class WorkService {
  readonly repository: WorkRepository;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: WorkServiceOptions) {
    this.repository = new WorkRepository(options.foundation.store.db);
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  listInbox(): Array<Record<string, unknown>> {
    return this.repository.list("inbound", "pending").map(publicWork);
  }

  status(requestId: string): Record<string, unknown> {
    const record = this.repository.get(requestId);
    if (!record) throw new Error("Remote work request not found.");
    return publicWork(record);
  }

  async wait(requestId: string, timeoutMs = 30_000, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const deadline = Date.now() + Math.max(0, Math.min(timeoutMs, 120_000));
    while (true) {
      const record = this.repository.get(requestId);
      if (!record) throw new Error("Remote work request not found.");
      if (["completed", "rejected", "failed"].includes(record.status)) return publicWork(record);
      if (Date.now() >= deadline) return publicWork(record);
      await Bun.sleep(250, signal);
    }
  }

  async send(input: {
    peer: PeerRecord;
    prompt: string;
    requestType?: "proposal" | "execute";
    capabilityProfile?: string;
    capabilities?: string[];
    chainId?: string;
    chainHop?: number;
    originChatJid?: string;
    originThreadId?: string | number | null;
  }): Promise<Record<string, unknown>> {
    if (input.peer.status !== "paired" || !input.peer.base_url) throw new Error("Paired peer not found.");
    const prompt = input.prompt.trim();
    if (!prompt || Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) throw new Error("Prompt is empty or exceeds 32 KiB.");
    const profile = clean(input.capabilityProfile || "restricted", 64);
    const capabilities = stringList(input.capabilities);
    const requestId = `rwork_${randomUUID()}`;
    const chainId = clean(input.chainId, 128) || `chain_${randomUUID()}`;
    const chainHop = Number.isInteger(input.chainHop) ? Number(input.chainHop) : 0;
    if (chainHop < 0 || chainHop > 8) throw new Error("Invalid chain hop.");
    const now = this.now().toISOString();
    const callbackUrl = `${this.options.foundation.loadConfig().externalUrl}/api/addons/remote-peer/v1/result`;
    if (!this.options.foundation.loadConfig().externalUrl) throw new Error("Configure this instance's external URL before sending remote work.");
    this.repository.create({
      id: requestId, peer_instance_id: input.peer.instance_id, direction: "outbound", status: "pending",
      request_type: input.requestType || "proposal", prompt_sha256: hash(prompt), prompt,
      capability_profile: profile, requested_capabilities_json: JSON.stringify(capabilities), allowed_capabilities_json: "[]",
      chain_id: chainId, chain_hop: chainHop, callback_url: callbackUrl,
      origin_chat_jid: input.originChatJid || null, origin_thread_id: input.originThreadId == null ? null : String(input.originThreadId),
      result: null, error: null, created_at: now, updated_at: now, completed_at: null,
      callback_received_at: null, callback_payload_sha256: null,
    });
    const path = input.requestType === "execute" ? EXECUTE_PATH : PROPOSAL_PATH;
    const body = JSON.stringify({
      protocol_version: 1, request_id: requestId, prompt, capability_profile: profile,
      requested_capabilities: capabilities, chain: { id: chainId, hop: chainHop }, callback_url: callbackUrl,
    });
    const bytes = new TextEncoder().encode(body);
    const response = await this.fetchFn(`${input.peer.base_url}${path}`, {
      method: "POST", headers: buildSignedHeaders(this.options.foundation.identity, path, bytes, input.peer.trust_epoch, this.now().toISOString()),
      body, signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
    });
    let payload: Record<string, unknown> = {};
    try {
      const value = await response.json();
      if (value && typeof value === "object" && !Array.isArray(value)) payload = value as Record<string, unknown>;
    } catch (error) {
      if (response.ok) throw new Error("Peer returned invalid JSON.", { cause: error });
    }
    if (!response.ok) {
      this.repository.decide(requestId, "pending", "failed", null, String(payload.error || `HTTP ${response.status}`), "[]", this.now().toISOString());
      throw new Error(String(payload.error || `Remote work request failed (${response.status}).`));
    }
    return this.status(requestId);
  }

  receive(peer: PeerRecord, body: Record<string, unknown>, requestType: "proposal" | "execute"): Response {
    const requestId = clean(body.request_id, 128);
    const prompt = clean(body.prompt, MAX_PROMPT_BYTES);
    const profileName = clean(body.capability_profile || "restricted", 64);
    const capabilities = stringList(body.requested_capabilities);
    const chain = body.chain && typeof body.chain === "object" ? body.chain as Record<string, unknown> : {};
    const chainId = clean(chain.id, 128);
    const chainHop = Number(chain.hop);
    const callbackUrl = clean(body.callback_url, 2048);
    const expectedCallbackUrl = peer.base_url ? `${peer.base_url}${RESULT_PATH}` : "";
    if (Number(body.protocol_version) !== 1 || !/^rwork_[A-Za-z0-9_-]{16,128}$/.test(requestId)
      || !prompt || !chainId || !Number.isInteger(chainHop) || chainHop < 0 || callbackUrl !== expectedCallbackUrl) return json({ error: "Missing or invalid work fields." }, 400);
    if (this.repository.get(requestId)) return json({ error: "Work request already exists." }, 409);
    if (this.repository.list("inbound").some(record => record.chain_id === chainId && record.status !== "completed" && record.status !== "rejected" && record.status !== "failed")) {
      return json({ error: "Work chain loop detected." }, 409);
    }
    const profile = this.repository.getProfile(profileName);
    if (!profile) return json({ error: "Capability profile is not allowed." }, 403);
    if (chainHop >= profile.max_chain_hops) return json({ error: "Work chain hop limit exceeded." }, 409);
    const profileCapabilities = JSON.parse(profile.allowed_capabilities_json) as string[];
    if (capabilities.some(capability => !profileCapabilities.includes(capability))) return json({ error: "Requested capability exceeds the profile allowlist." }, 403);
    const now = this.now().toISOString();
    this.repository.create({
      id: requestId, peer_instance_id: peer.instance_id, direction: "inbound", status: "pending", request_type: requestType,
      prompt_sha256: hash(prompt), prompt, capability_profile: profileName,
      requested_capabilities_json: JSON.stringify(capabilities), allowed_capabilities_json: "[]",
      chain_id: chainId, chain_hop: chainHop, callback_url: callbackUrl, origin_chat_jid: null, origin_thread_id: null,
      result: null, error: null, created_at: now, updated_at: now, completed_at: null,
      callback_received_at: null, callback_payload_sha256: null,
    });
    return json({ status: "human_required", request_id: requestId, decision: "pending" }, 202);
  }

  async approve(requestId: string, result: string, capabilities: string[]): Promise<Record<string, unknown>> {
    const record = this.repository.get(requestId);
    if (!record || record.direction !== "inbound" || record.status !== "pending") throw new Error("Pending inbound work request not found.");
    const output = result.trim();
    if (!output || Buffer.byteLength(output, "utf8") > MAX_RESULT_BYTES) throw new Error("Reviewed result is empty or exceeds 256 KiB.");
    const requested = JSON.parse(record.requested_capabilities_json) as string[];
    const allowed = stringList(capabilities);
    if (allowed.some(capability => !requested.includes(capability))) throw new Error("Approved capabilities must be a subset of the request.");
    if (!this.repository.decide(requestId, "pending", "approved", output, null, JSON.stringify(allowed), this.now().toISOString())) throw new Error("Work request state changed.");
    await this.pushCallback(requestId);
    return this.status(requestId);
  }

  async reject(requestId: string, reason: string): Promise<Record<string, unknown>> {
    const record = this.repository.get(requestId);
    if (!record || record.direction !== "inbound" || record.status !== "pending") throw new Error("Pending inbound work request not found.");
    const error = reason.trim() || "Rejected by operator.";
    if (!this.repository.decide(requestId, "pending", "rejected", null, error, "[]", this.now().toISOString())) throw new Error("Work request state changed.");
    await this.pushCallback(requestId);
    return this.status(requestId);
  }

  async receiveResult(peer: PeerRecord, body: Record<string, unknown>): Promise<Response> {
    const requestId = clean(body.request_id, 128);
    const status = body.status === "completed" ? "completed" : body.status === "rejected" ? "rejected" : body.status === "failed" ? "failed" : "";
    const result = typeof body.result === "string" ? body.result : null;
    const error = typeof body.error === "string" ? body.error : null;
    const allowedCapabilities = stringList(body.allowed_capabilities);
    const record = this.repository.get(requestId);
    if (!record || record.direction !== "outbound" || record.peer_instance_id !== peer.instance_id) return json({ error: "Unknown work callback." }, 404);
    const payloadHash = hash(JSON.stringify(body));
    if (record.callback_received_at) return json({ error: record.callback_payload_sha256 === payloadHash ? "Duplicate work callback." : "Conflicting work callback." }, 409);
    if (!status || (status === "completed" && (!result || Buffer.byteLength(result, "utf8") > MAX_RESULT_BYTES))) return json({ error: "Invalid work callback." }, 400);
    const requested = JSON.parse(record.requested_capabilities_json) as string[];
    if (allowedCapabilities.some(capability => !requested.includes(capability))) return json({ error: "Work callback capabilities exceed the request." }, 400);
    await this.routeResult({
      ...record,
      status: status as WorkStatus,
      result,
      error,
      allowed_capabilities_json: JSON.stringify(allowedCapabilities),
    });
    if (!this.repository.markCallbackReceived(requestId, status as WorkStatus, result, error, JSON.stringify(allowedCapabilities), payloadHash, this.now().toISOString())) return json({ error: "Work callback state changed." }, 409);
    return json({ status: "accepted", request_id: requestId });
  }

  async retryDueCallbacks(): Promise<number> {
    const due = this.repository.listDueCallbacks(this.now().toISOString());
    let delivered = 0;
    for (const attempt of due) {
      try { await this.pushCallback(attempt.request_id); delivered += 1; }
      catch (error) {
        this.options.foundation.store.db.query(`INSERT INTO transport_audit (peer_instance_id, event, outcome, error, created_at)
          VALUES (?, 'work_callback_retry', 'failed', ?, ?)`)
          .run(attempt.peer_instance_id, error instanceof Error ? error.message : String(error), this.now().toISOString());
      }
    }
    return delivered;
  }

  private async pushCallback(requestId: string): Promise<void> {
    const record = this.repository.get(requestId);
    if (!record || record.direction !== "inbound" || !record.callback_url) throw new Error("Inbound work callback is unavailable.");
    const peer = this.options.foundation.store.db.query("SELECT * FROM peers WHERE instance_id = ?").get(record.peer_instance_id) as PeerRecord | null;
    if (!peer || peer.status !== "paired") throw new Error("Paired peer not found for callback.");
    const body = JSON.stringify({
      protocol_version: 1, request_id: record.id,
      status: record.status === "approved" ? "completed" : record.status,
      result: record.result, error: record.error,
      allowed_capabilities: JSON.parse(record.allowed_capabilities_json),
      chain: record.chain_id ? { id: record.chain_id, hop: record.chain_hop } : null,
    });
    const bytes = new TextEncoder().encode(body);
    const attempt = this.repository.nextCallbackAttempt(record.id);
    try {
      const response = await this.fetchFn(record.callback_url, {
        method: "POST", headers: buildSignedHeaders(this.options.foundation.identity, RESULT_PATH, bytes, peer.trust_epoch, this.now().toISOString()),
        body, signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.repository.createCallbackAttempt(peer.instance_id, record.id, "result", attempt, "delivered", null, null, this.now().toISOString());
      this.repository.markCallbackDelivered(record.id, record.status, record.status === "approved" ? "completed" : record.status, this.now().toISOString());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
      this.repository.createCallbackAttempt(peer.instance_id, record.id, "result", attempt, "failed", message, new Date(this.now().getTime() + delay).toISOString(), this.now().toISOString());
      throw error;
    }
  }

  private async routeResult(record: WorkRecord): Promise<void> {
    if (!record.origin_chat_jid || !this.options.runtime.enqueueAgentMessage) return;
    const content = record.status === "completed"
      ? `Remote work ${record.id} completed.\n\n${record.result || ""}`
      : `Remote work ${record.id} ${record.status}: ${record.error || "no details"}`;
    await this.options.runtime.enqueueAgentMessage({
      chatJid: record.origin_chat_jid,
      content,
      mode: "queue",
      ...(record.origin_thread_id ? { threadId: record.origin_thread_id } : {}),
      source: "addon.remote-peer",
      queuedBy: { kind: "peer", clientId: record.peer_instance_id, displayName: "Remote Peer result" },
    });
  }
}

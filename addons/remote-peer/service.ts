import { createHash, randomUUID, randomBytes } from "node:crypto";
import type {
  ChatTransportRequest,
  PiclawRuntimeApi,
  ChatTransportAttachment,
  ChatTransportDirectoryEntry,
} from "./compat/runtime.js";
import { clientId, endpointId } from "./client-id.js";
import { PeerState, type Peer, type Mode } from "./state.js";
import {
  IrohTransport,
  MAX_BYTES,
  iroh,
  type Packet,
  type Reply,
} from "./transport.js";
import { PeerDiscovery } from "./discovery.js";
import { normalizeRemotePeerConfig, type RemotePeerConfig } from "./config.js";
const id = () => randomUUID();
const hash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const alias = (s: string) => {
  if (!/^[a-z0-9][a-z0-9_.-]{0,47}$/.test(s))
    throw new Error(
      "Alias must be 1–48 lowercase letters, digits, dots, underscores or hyphens.",
    );
  return s;
};
function modes(value: unknown): Mode[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.some((v) => !["queue", "auto", "steer"].includes(v))
  )
    throw new Error("Invalid delivery modes.");
  return [...new Set(value)] as Mode[];
}
function text(value: unknown, max: number) {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > max ||
    value.includes("\0")
  )
    throw new Error("Invalid text field.");
  return value;
}
export interface PeerServiceOptions {
  dataDir: string;
  runtime: PiclawRuntimeApi;
  bindAddr?: string;
  transportFactory?: (options: any) => IrohTransport;
  discoveryFactory?: (options: any) => PeerDiscovery;
}
export class PeerService {
  readonly state: PeerState;
  transport: IrohTransport;
  discovery: PeerDiscovery | null = null;
  private closing = false;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private transitions: Promise<void> = Promise.resolve();
  private rate = new Map<string, { count: number; until: number }>();
  constructor(private options: PeerServiceOptions) {
    this.state = new PeerState(options.dataDir);
    try {
      this.transport = this.createTransport();
    } catch (error) {
      this.state.close();
      throw error;
    }
  }
  private createTransport() {
    const factory =
      this.options.transportFactory ?? ((opts) => new IrohTransport(opts));
    return factory({
      keyBytes: this.state.keyBytes,
      config: this.state.config(),
      bindAddr: this.options.bindAddr,
      handler: (peer: string, p: Packet, b: Uint8Array) =>
        this.receive(peer, p, b),
      authorize: (id: string, p: Packet) => {
        if (!this.state.config().enabled) return false;
        const peer = this.state.peer(id);
        if (["pair", "confirm"].includes(p.op)) return p.size === 0;
        return (
          peer?.status === "paired" &&
          p.body?.epoch === peer.epoch &&
          (p.size === 0 || peer.files)
        );
      },
    });
  }
  private enabled() {
    if (this.closing || this.closed || !this.state.config().enabled)
      throw new Error("Remote Peer is disabled.");
  }
  private transition<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing || this.closed)
      return Promise.reject(new Error("Remote Peer is closing."));
    // Once accepted, an operation runs before a later close. closing gates only
    // operations submitted after close begins.
    const result = this.transitions.then(operation);
    this.transitions = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  private async startUnlocked() {
    if (!this.state.config().enabled) return;
    await this.transport.start();
    await this.refreshDiscovery();
  }
  async start() {
    return this.transition(() => this.startUnlocked());
  }
  async configure(patch: Partial<RemotePeerConfig>) {
    return this.transition(async () => {
      const previous = this.state.config();
      const next = normalizeRemotePeerConfig({ ...previous, ...patch });
      await this.discovery?.stop();
      this.discovery = null;
      await this.transport.close();
      try {
        this.state.saveConfig(next);
        this.transport = this.createTransport();
        await this.startUnlocked();
        return next;
      } catch (error) {
        this.state.saveConfig(previous);
        this.transport = this.createTransport();
        await this.startUnlocked().catch(() => undefined);
        throw error;
      }
    });
  }
  private async refreshDiscovery() {
    const c = this.state.config();
    if (!c.enabled || !c.mdnsEnabled || this.discovery) return;
    const factory =
      this.options.discoveryFactory ?? ((opts) => new PeerDiscovery(opts));
    try {
      this.discovery = factory({
        endpointId: this.transport.id,
        instanceId: this.transport.id,
        port: this.transport.port(),
        name: c.instanceName || "Piclaw-" + this.transport.id.slice(0, 8),
        ...(c.mdnsInterface ? { interfaceAddress: c.mdnsInterface } : {}),
      });
      await this.discovery.start();
    } catch (error) {
      this.state.audit(
        "mdns-error",
        null,
        "Local discovery unavailable; manual pairing remains available.",
      );
    }
  }
  async close() {
    if (this.closed) return;
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.transitions.then(async () => {
      const errors: unknown[] = [];
      try {
        await this.discovery?.stop();
      } catch (error) {
        errors.push(error);
      }
      this.discovery = null;
      try {
        await this.transport.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        this.state.close();
      } catch (error) {
        errors.push(error);
      }
      this.closed = true;
      if (errors.length)
        throw new AggregateError(errors, "Remote Peer cleanup failed");
    });
    this.transitions = this.closePromise.then(
      () => undefined,
      () => undefined,
    );
    return this.closePromise;
  }
  identity() {
    return { clientId: this.transport.clientId, endpointId: this.transport.id };
  }
  private peer(reference: string) {
    let p = this.state.peer(reference);
    if (!p) {
      try {
        p = this.state.peer(endpointId(reference));
      } catch {}
    }
    if (!p) throw new Error("Peer not found.");
    return p;
  }
  private paired(reference: string) {
    const p = this.peer(reference);
    if (p.status !== "paired") throw new Error("Peer is not paired.");
    return p;
  }
  private async call(
    peer: Peer,
    op: string,
    body: any = {},
    bytes = new Uint8Array(),
    signal?: AbortSignal,
  ) {
    this.enabled();
    return this.transport.request(
      peer.id,
      op,
      { ...body, epoch: peer.epoch },
      bytes,
      peer.ticket ?? undefined,
      undefined,
      signal,
    );
  }
  async pair(input: { clientId: string; alias?: string; ticket?: string }) {
    this.enabled();
    const target = endpointId(input.clientId);
    if (target === this.transport.id)
      throw new Error("Cannot pair with this client.");
    const prior = this.state.peer(target);
    if (prior?.status === "paired") throw new Error("Peer already paired.");
    if (
      this.state
        .peers()
        .filter((p) => p.status === "outgoing" || p.status === "incoming")
        .length >= 64
    )
      throw new Error("Too many pending peers; deny stale requests first.");
    if (prior && prior.status !== "outgoing")
      throw new Error(
        "Remove the revoked/pending record explicitly before starting a new pairing.",
      );
    const peer: Peer = prior ?? {
      id: target,
      alias: alias(input.alias || "peer-" + target.slice(0, 10)),
      name: "",
      status: "outgoing",
      request: id(),
      expires: Date.now() + 3600000,
      epoch: id(),
      ticket: input.ticket || null,
      scope: "inbox-only",
      modes: ["queue"],
      agents: [],
      files: false,
      lastSeen: null,
    };
    if (peer.expires < Date.now())
      throw new Error(
        "Pair request expired; cancel and remove it before retrying.",
      );
    if (input.ticket) peer.ticket = input.ticket;
    this.state.put(peer);
    await this.transport.start();
    const candidate = this.discovery?.candidates().find((c) => c.id === target);
    const addresses = candidate?.addresses.map((a) =>
      a.includes(":") ? `[${a}]:${candidate.port}` : `${a}:${candidate.port}`,
    );
    const reply = await this.transport.request(
      target,
      "pair",
      {
        request: peer.request,
        expires: peer.expires,
        epoch: peer.epoch,
        name: this.state.config().instanceName,
        ticket: this.transport.ticket(),
      },
      new Uint8Array(),
      peer.ticket ?? undefined,
      addresses,
    );
    const latest = this.state.peer(target);
    if (
      !latest ||
      !["outgoing", "paired"].includes(latest.status) ||
      latest.request !== peer.request ||
      latest.epoch !== peer.epoch
    )
      throw new Error("Pairing was cancelled while the request was in flight.");
    peer.status = latest.status;
    peer.name = text(reply.body.name ?? "", 63);
    if (reply.body.ticket) {
      const ticket = text(reply.body.ticket, 8192);
      if (
        iroh()
          .EndpointTicket.fromString(ticket)
          .endpointAddr()
          .id()
          .toString() !== target
      )
        throw new Error("Response ticket identity mismatch.");
      peer.ticket = ticket;
    }
    this.state.put(peer);
    this.state.audit("pair-outgoing", target, "Awaiting remote approval");
    return { status: "outgoing", clientId: clientId(target) };
  }
  async accept(reference: string, confirmation: string) {
    this.enabled();
    const peer = this.peer(reference);
    if (peer.status !== "incoming" || peer.expires < Date.now())
      throw new Error("Pending request missing or expired.");
    if (endpointId(confirmation) !== peer.id)
      throw new Error("Confirm the full client ID before accepting.");
    await this.transport.start();
    await this.transport.request(
      peer.id,
      "confirm",
      {
        request: peer.request,
        epoch: peer.epoch,
        name: this.state.config().instanceName,
      },
      new Uint8Array(),
      peer.ticket ?? undefined,
    );
    const latest = this.state.peer(peer.id);
    if (
      !latest ||
      latest.status !== "incoming" ||
      latest.request !== peer.request ||
      latest.epoch !== peer.epoch
    )
      throw new Error("Pairing was cancelled while approval was in flight.");
    peer.status = "paired";
    peer.lastSeen = Date.now();
    this.state.put(peer);
    this.state.audit("pair-accepted", peer.id, "Explicit approval");
  }
  deny(reference: string) {
    const peer = this.peer(reference);
    if (!["incoming", "outgoing"].includes(peer.status))
      throw new Error("No pending request.");
    peer.status = "revoked";
    peer.epoch = id();
    this.state.put(peer);
    this.state.db.query("DELETE FROM replies WHERE peer=?").run(peer.id);
  }
  async revoke(reference: string, confirmation: string) {
    const peer = this.paired(reference);
    if (endpointId(confirmation) !== peer.id)
      throw new Error("Confirm the full client ID before revoking.");
    this.enabled();
    const oldEpoch = peer.epoch;
    peer.status = "revoked";
    peer.epoch = id();
    this.state.put(peer);
    this.state.db.query("DELETE FROM replies WHERE peer=?").run(peer.id);
    try {
      await this.transport.request(
        peer.id,
        "revoke",
        { epoch: oldEpoch },
        new Uint8Array(),
        peer.ticket ?? undefined,
      );
    } catch {}
    this.state.audit("revoked", peer.id, "Operator revoked");
  }
  forget(reference: string, confirmation: string) {
    const peer = this.peer(reference);
    if (peer.status !== "revoked" || endpointId(confirmation) !== peer.id)
      throw new Error(
        "Revoke first, then confirm the full client ID to remove the record.",
      );
    this.state.db
      .transaction(() => {
        this.state.db.query("DELETE FROM replies WHERE peer=?").run(peer.id);
        this.state.db.query("DELETE FROM peers WHERE id=?").run(peer.id);
      })
      .immediate();
    this.state.audit(
      "peer-removed",
      peer.id,
      "Operator removed block; new approval required",
    );
  }
  async rotateIdentity(confirmation: string) {
    return this.transition(async () => {
      this.enabled();
      if (endpointId(confirmation) !== this.transport.id)
        throw new Error(
          "Confirm the full current client ID before rotating identity.",
        );
      // Preflight before stopping networking. A rejected rotation must leave the
      // current endpoint and discovery service running.
      this.state.assertIdentityRotationAllowed();
      await this.discovery?.stop();
      this.discovery = null;
      await this.transport.close();
      try {
        this.state.rotateIdentity();
      } finally {
        // Recreate from the durable key (old or new) after any rotation fault.
        this.transport = this.createTransport();
        await this.startUnlocked().catch(() => undefined);
      }
      return this.identity();
    });
  }
  setPolicy(reference: string, input: any) {
    const peer = this.paired(reference);
    if (
      !["none", "inbox-only", "named-agents", "all-advertised"].includes(
        input.scope,
      )
    )
      throw new Error("Invalid peer scope.");
    const selectedModes = modes(input.modes);
    const agents = (input.agents ?? []).map((v: string) => alias(v));
    if (agents.length > 64) throw new Error("Too many agent aliases.");
    if (
      ((input.scope !== "none" && input.scope !== "inbox-only") ||
        selectedModes.some((m) => m !== "queue") ||
        input.files === true) &&
      input.confirmation !== "ALLOW REMOTE ACCESS"
    )
      throw new Error("Type ALLOW REMOTE ACCESS to grant wider permissions.");
    this.state.put({
      ...peer,
      scope: input.scope,
      modes: selectedModes,
      agents,
      files: input.files === true,
    });
  }
  setAlias(reference: string, value: string) {
    const p = this.peer(reference);
    p.alias = alias(value);
    this.state.put(p);
  }
  async advertise(local: string, name: string, allowed: Mode[]) {
    const list = await this.options.runtime.messaging!.listAdvertisableAgents();
    if (!list.some((a) => a.agent_name === local))
      throw new Error("Local agent is not advertisable.");
    this.state.db
      .query("INSERT OR REPLACE INTO advertised VALUES (?,?,?)")
      .run(alias(name), local, JSON.stringify(modes(allowed)));
  }
  unadvertise(name: string) {
    this.state.db.query("DELETE FROM advertised WHERE alias=?").run(name);
  }
  private roster(peer: Peer) {
    return {
      agents:
        peer.scope === "none" || peer.scope === "inbox-only"
          ? []
          : (this.state.db.query("SELECT * FROM advertised").all() as any[])
              .filter(
                (a) =>
                  peer.scope === "all-advertised" ||
                  peer.agents.includes(a.alias),
              )
              .map((a) => ({
                name: a.alias,
                modes: JSON.parse(a.modes).filter((m: Mode) =>
                  peer.modes.includes(m),
                ),
              })),
      inbox: peer.scope !== "none",
      modes: peer.modes,
      files: peer.files,
    };
  }
  async directory() {
    const entries: ChatTransportDirectoryEntry[] = [];
    if (this.state.config().enabled)
      for (const peer of this.state
        .peers()
        .filter((p) => p.status === "paired")) {
        try {
          const { body: roster } = await this.call(peer, "roster");
          const attachments = {
            enabled: roster.files === true,
            max_files: 4,
            max_file_bytes: 16 * 1024 * 1024,
            max_total_bytes: MAX_BYTES,
          };
          if (roster.inbox)
            entries.push({
              address: peer.alias + "!inbox",
              label: peer.name || peer.alias,
              peer_alias: peer.alias,
              peer_fingerprint: clientId(peer.id),
              target_kind: "inbox",
              modes: modes(roster.modes),
              status: "ready",
              attachments,
            });
          for (const agent of Array.isArray(roster.agents)
            ? roster.agents.slice(0, 64)
            : [])
            entries.push({
              address: peer.alias + "!@" + alias(agent.name),
              label: peer.alias + " @" + agent.name,
              peer_alias: peer.alias,
              peer_fingerprint: clientId(peer.id),
              target_kind: "agent",
              modes: modes(agent.modes),
              status: "ready",
              attachments,
            });
        } catch {
          /* Unreachable peers are not directly usable addresses. */
        }
      }
    return {
      transport: "remote-peer",
      generated_at: new Date().toISOString(),
      entries,
      notes: ["Only explicitly paired Iroh peers are exposed."],
    };
  }
  async validate(request: ChatTransportRequest) {
    this.enabled();
    const peer = this.paired(request.address.peer);
    if (!["queue", "auto", "steer"].includes(request.mode))
      throw new Error("Invalid mode.");
    const directory = await this.directory();
    const address = request.address.target.startsWith("reply.")
      ? peer.alias + "!inbox"
      : request.address.raw;
    const entry = directory.entries.find((e) => e.address === address);
    if (!entry || !entry.modes.includes(request.mode))
      throw new Error("Address/mode not available. Refresh chat directory.");
    if (request.attachments?.length && !entry.attachments?.enabled)
      throw new Error("Receiver has disabled files.");
  }
  private encodeMessage(request: ChatTransportRequest) {
    text(request.content, 32768);
    if (!request.content && !request.attachments?.length)
      throw new Error("Empty message.");
    if (!["queue", "auto", "steer"].includes(request.mode))
      throw new Error("Invalid delivery mode.");
    text(request.address.target, 256);
    if (request.source_agent_name) text(request.source_agent_name, 256);
    if (request.source_agent_display_name)
      text(request.source_agent_display_name, 256);
    const files = request.attachments ?? [];
    if (files.length > 4) throw new Error("At most four files.");
    let total = 0;
    const descriptors = files.map((f) => {
      text(f.filename, 240);
      text(f.content_type, 160);
      if (
        !f.filename ||
        /[\\/]/.test(f.filename) ||
        !Number.isSafeInteger(f.size) ||
        f.size < 0 ||
        f.size > 16 * 1024 * 1024 ||
        f.data.byteLength !== f.size ||
        hash(f.data) !== f.sha256
      )
        throw new Error("Invalid attachment.");
      total += f.size;
      return {
        filename: f.filename,
        content_type: f.content_type,
        size: f.size,
        sha256: f.sha256,
      };
    });
    if (total > MAX_BYTES) throw new Error("Files exceed 32 MiB.");
    return {
      descriptors,
      bytes: Buffer.concat(files.map((f) => Buffer.from(f.data))),
    };
  }
  async send(
    request: ChatTransportRequest,
    existingId?: string,
  ): Promise<Record<string, unknown>> {
    this.enabled();
    const peer = this.paired(request.address.peer);
    const { descriptors, bytes } = this.encodeMessage(request);
    const idem = request.idempotency_key
      ? text(request.idempotency_key, 256)
      : null;
    const semantic = {
      target: request.address.target,
      content: request.content,
      mode: request.mode,
      files: descriptors,
      sourceAgent: request.source_agent_name ?? null,
      sourceDisplay: request.source_agent_display_name ?? null,
    };
    let row = existingId
      ? (this.state.db
          .query("SELECT * FROM outbound WHERE id=? AND peer=?")
          .get(existingId, peer.id) as any)
      : idem
        ? (this.state.db
            .query("SELECT * FROM outbound WHERE peer=? AND idem=?")
            .get(peer.id, idem) as any)
        : null;
    if (row) {
      if (
        JSON.stringify(JSON.parse(row.payload).semantic) !==
        JSON.stringify(semantic)
      )
        throw new Error("Idempotency key used with different content.");
      if (row.status === "delivered")
        return {
          relayed: true,
          receipt: JSON.parse(row.receipt),
          message_id: row.id,
        };
      if (row.status === "sending")
        throw new Error("Delivery already in progress.");
    } else {
      const queued = this.state.db
        .query(
          "SELECT COUNT(*) AS n,COALESCE(SUM(length(bytes)),0) AS size FROM outbound WHERE status!='delivered'",
        )
        .get() as any;
      if (queued.n >= 256 || queued.size + bytes.length > 128 * 1024 * 1024)
        throw new Error(
          "Outbound queue limit reached; resolve failed deliveries first.",
        );
      const token = randomBytes(24).toString("base64url");
      this.state.db
        .query("DELETE FROM replies WHERE expires<?")
        .run(Date.now());
      this.state.db
        .query("INSERT INTO replies VALUES (?,?,?,?,?)")
        .run(
          token,
          peer.id,
          peer.epoch,
          request.source_chat_jid,
          Date.now() + 7 * 86400000,
        );
      const payload = { semantic, reply: "reply." + token };
      row = {
        id: id(),
        peer: peer.id,
        idem,
        payload: JSON.stringify(payload),
        bytes,
        status: "queued",
        created: Date.now(),
      };
      this.state.db
        .query(
          "INSERT INTO outbound(id,peer,idem,payload,bytes,status,created) VALUES (?,?,?,?,?,?,?)",
        )
        .run(row.id, peer.id, idem, row.payload, bytes, "queued", row.created);
    }
    this.state.db
      .query("UPDATE outbound SET status='sending',error=NULL WHERE id=?")
      .run(row.id);
    try {
      const response = await this.call(
        peer,
        "message",
        { ...JSON.parse(row.payload), messageId: row.id },
        bytes,
      );
      if (
        response.body.messageId !== row.id ||
        response.body.status !== "queued"
      )
        throw new Error("Invalid delivery receipt.");
      this.state.db
        .query(
          "UPDATE outbound SET status='delivered',receipt=?,bytes=NULL WHERE id=?",
        )
        .run(JSON.stringify(response.body), row.id);
      return {
        relayed: true,
        message_id: row.id,
        peer_alias: peer.alias,
        receipt: response.body,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state.db
        .query("UPDATE outbound SET status='failed',error=? WHERE id=?")
        .run(message.slice(0, 500), row.id);
      throw error;
    }
  }
  async retry(messageId: string) {
    const row = this.state.db
      .query("SELECT * FROM outbound WHERE id=? AND status='failed'")
      .get(messageId) as any;
    if (!row) throw new Error("Failed message not found.");
    const peer = this.paired(row.peer),
      payload = JSON.parse(row.payload),
      s = payload.semantic;
    let offset = 0;
    const attachments = s.files.map((f: any) => {
      const data = new Uint8Array(row.bytes).slice(offset, offset + f.size);
      offset += f.size;
      return { ...f, data };
    });
    return this.send(
      {
        source_chat_jid: "",
        source_agent_name: s.sourceAgent ?? undefined,
        source_agent_display_name: s.sourceDisplay ?? undefined,
        address: {
          kind: "bang",
          raw: peer.alias + "!" + s.target,
          peer: peer.alias,
          target: s.target,
        },
        content: s.content,
        mode: s.mode,
        attachments,
        ...(row.idem ? { idempotency_key: row.idem } : {}),
      },
      row.id,
    );
  }
  private allowPair(remote: string) {
    const now = Date.now();
    for (const [key, value] of this.rate)
      if (value.until < now) this.rate.delete(key);
    const old = this.rate.get(remote) ?? { count: 0, until: now + 600000 };
    if (++old.count > 5 || this.rate.size >= 1024)
      throw new Error("Pairing rate limit.");
    this.rate.set(remote, old);
  }
  async receive(
    remote: string,
    packet: Packet,
    bytes: Uint8Array,
  ): Promise<Reply> {
    this.enabled();
    const body = packet.body;
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error("Invalid operation body.");
    if (packet.op !== "message" && bytes.length)
      throw new Error("Unexpected binary data.");
    let peer = this.state.peer(remote);
    if (packet.op === "pair") {
      this.allowPair(remote);
      if (peer?.status === "revoked" || peer?.status === "paired")
        throw new Error("Peer is blocked or already paired.");
      if (
        peer?.status === "incoming" &&
        peer.request === body.request &&
        peer.epoch === body.epoch
      )
        return {
          body: {
            ok: true,
            name: this.state.config().instanceName,
            ticket: this.transport.ticket(),
          },
        };
      if (peer) throw new Error("Another pairing request is pending.");
      if (this.state.peers().length >= 256)
        throw new Error("Peer limit reached.");
      if (
        !Number.isFinite(body.expires) ||
        body.expires <= Date.now() - 90000 ||
        body.expires > Date.now() + 3600000 + 90000 ||
        !body.request ||
        !body.epoch
      )
        throw new Error("Invalid pairing request.");
      text(body.request, 80);
      text(body.epoch, 80);
      const name = text(body.name ?? "", 63);
      const ticket = text(body.ticket, 8192);
      if (
        iroh()
          .EndpointTicket.fromString(ticket)
          .endpointAddr()
          .id()
          .toString() !== remote
      )
        throw new Error("Pairing ticket identity mismatch.");
      // Reply address information is supplied on the authenticated channel, never via a public HTTP callback.
      peer = {
        id: remote,
        alias: "peer-" + remote.slice(0, 10),
        name,
        status: "incoming",
        request: body.request,
        epoch: body.epoch,
        expires: body.expires,
        ticket,
        scope: "inbox-only",
        modes: ["queue"],
        agents: [],
        files: false,
        lastSeen: Date.now(),
      };
      this.state.put(peer);
      return {
        body: {
          ok: true,
          name: this.state.config().instanceName,
          ticket: this.transport.ticket(),
        },
      };
    }
    if (packet.op === "confirm") {
      if (
        !peer ||
        !["outgoing", "paired"].includes(peer.status) ||
        peer.request !== body.request ||
        peer.epoch !== body.epoch ||
        peer.expires < Date.now()
      )
        throw new Error("Pair confirmation does not match an active request.");
      peer.status = "paired";
      peer.name = text(body.name ?? "", 63);
      peer.lastSeen = Date.now();
      this.state.put(peer);
      return { body: { ok: true } };
    }
    if (!peer || peer.status !== "paired" || body.epoch !== peer.epoch)
      throw new Error("Peer not paired or stale authorization epoch.");
    peer.lastSeen = Date.now();
    this.state.put(peer);
    if (packet.op === "ping")
      return { body: { ok: true, clientId: this.transport.clientId } };
    if (packet.op === "roster") return { body: this.roster(peer) };
    if (packet.op === "revoke") {
      peer.status = "revoked";
      peer.epoch = id();
      this.state.put(peer);
      this.state.db.query("DELETE FROM replies WHERE peer=?").run(peer.id);
      return { body: { ok: true } };
    }
    if (packet.op === "message")
      return { body: await this.receiveMessage(peer, body, bytes) };
    if (packet.op === "work") return { body: this.receiveWork(peer, body) };
    if (packet.op === "work-result")
      return { body: await this.receiveWorkResult(peer, body) };
    throw new Error("Unknown Iroh operation.");
  }
  private async receiveMessage(peer: Peer, body: any, bytes: Uint8Array) {
    const s = body.semantic;
    const messageId = text(body.messageId, 80);
    if (s?.sourceAgent) text(s.sourceAgent, 256);
    if (s?.sourceDisplay) text(s.sourceDisplay, 256);
    if (!messageId || !s) throw new Error("Invalid message.");
    const content = text(s.content, 32768),
      target = text(s.target, 256),
      mode = s.mode as Mode;
    if (!peer.modes.includes(mode) || peer.scope === "none")
      throw new Error("Message mode/scope denied.");
    let local = "default",
      targetChat: string | undefined;
    if (target.startsWith("@")) {
      const name = alias(target.slice(1));
      const a = this.state.db
        .query("SELECT * FROM advertised WHERE alias=?")
        .get(name) as any;
      if (
        !a ||
        peer.scope === "inbox-only" ||
        (peer.scope === "named-agents" && !peer.agents.includes(name)) ||
        !JSON.parse(a.modes).includes(mode)
      )
        throw new Error("Agent access denied.");
      local = a.local_agent;
    } else if (target.startsWith("reply.")) {
      const reply = this.state.db
        .query(
          "SELECT target FROM replies WHERE token=? AND peer=? AND epoch=? AND expires>?",
        )
        .get(target.slice(6), peer.id, peer.epoch, Date.now()) as any;
      if (!reply) throw new Error("Reply capability expired or invalid.");
      targetChat = reply.target;
    } else if (target !== "inbox") throw new Error("Invalid target.");
    if (
      !Array.isArray(s.files) ||
      s.files.length > 4 ||
      (s.files.length && !peer.files)
    )
      throw new Error("File transfer denied.");
    let offset = 0;
    const attachments: ChatTransportAttachment[] = s.files.map((f: any) => {
      const size = f.size;
      if (!Number.isSafeInteger(size) || size < 0 || size > 16 * 1024 * 1024)
        throw new Error("File size invalid.");
      text(f.filename, 240);
      text(f.content_type, 160);
      if (!f.filename || /[\\/]/.test(f.filename))
        throw new Error("Invalid filename.");
      const data = bytes.slice(offset, offset + size);
      offset += size;
      if (data.length !== size || hash(data) !== f.sha256)
        throw new Error("File hash mismatch.");
      return { ...f, data };
    });
    if (offset !== bytes.length || (!content && !attachments.length))
      throw new Error("Invalid payload size/content.");
    const digest = hash(JSON.stringify(s) + hash(bytes)),
      previous = this.state.db
        .query("SELECT * FROM inbound WHERE peer=? AND id=?")
        .get(peer.id, messageId) as any;
    if (previous) {
      if (previous.hash !== digest)
        throw new Error("Message ID reused with different content.");
      if (previous.receipt) return JSON.parse(previous.receipt);
      throw new Error(
        "Delivery outcome unknown; inspect receiver before retrying.",
      );
    }
    this.state.db
      .query("INSERT INTO inbound VALUES (?,?,?,'delivering',NULL)")
      .run(peer.id, messageId, digest);
    const reply =
      typeof body.reply === "string" &&
      /^reply\.[A-Za-z0-9_-]{32}$/.test(body.reply)
        ? peer.alias + "!" + body.reply
        : undefined;
    const result = await this.options.runtime.messaging!.deliverPeerMessage({
      ...(targetChat
        ? { target_chat_jid: targetChat }
        : { target_agent_name: local }),
      content,
      mode,
      attachments,
      source: {
        peer_instance_id: peer.id,
        peer_fingerprint: clientId(peer.id),
        peer_alias: peer.alias,
        message_id: messageId,
        ...(reply ? { reply_address: reply } : {}),
        ...(s.sourceAgent ? { agent_name: text(s.sourceAgent, 256) } : {}),
        ...(s.sourceDisplay
          ? { agent_display_name: text(s.sourceDisplay, 256) }
          : {}),
      },
    });
    const receipt = {
      messageId,
      status: "queued",
      rowId: result.row_id ?? null,
      receivedAt: Date.now(),
    };
    this.state.db
      .query(
        "UPDATE inbound SET status='queued',receipt=? WHERE peer=? AND id=?",
      )
      .run(JSON.stringify(receipt), peer.id, messageId);
    return receipt;
  }
  private receiveWork(peer: Peer, body: any) {
    if (peer.scope === "none")
      throw new Error("Remote work disabled for this peer.");
    const workId = text(body.id, 80);
    if (!workId || !["proposal", "execute"].includes(body.type))
      throw new Error("Invalid work request.");
    const prompt = text(body.prompt, 32768);
    if (!Array.isArray(body.capabilities) || body.capabilities.length > 32)
      throw new Error("Invalid capabilities.");
    body.capabilities.forEach((s: unknown) => text(s, 128));
    const previous = this.state.db
      .query("SELECT * FROM work WHERE id=?")
      .get(workId) as any;
    if (previous) {
      if (
        previous.peer !== peer.id ||
        previous.direction !== "inbound" ||
        previous.data !==
          JSON.stringify({
            prompt,
            type: body.type,
            capabilities: body.capabilities,
          })
      )
        throw new Error("Conflicting work ID");
      return { ok: true };
    }
    if (
      (
        this.state.db
          .query("SELECT COUNT(*) AS n FROM work WHERE status='pending'")
          .get() as any
      ).n >= 128
    )
      throw new Error("Work inbox full.");
    this.state.db.query("INSERT INTO work VALUES (?,?,?,?,?)").run(
      workId,
      peer.id,
      "inbound",
      "pending",
      JSON.stringify({
        prompt,
        type: body.type,
        capabilities: body.capabilities,
      }),
    );
    return { ok: true };
  }
  async workSend(
    reference: string,
    prompt: string,
    type: "proposal" | "execute",
    capabilities: string[],
    chat: string,
  ) {
    this.enabled();
    const peer = this.paired(reference),
      workId = id();
    text(prompt, 32768);
    if (
      !prompt ||
      !["proposal", "execute"].includes(type) ||
      !Array.isArray(capabilities) ||
      capabilities.length > 32
    )
      throw new Error("Invalid work request.");
    capabilities.forEach((c) => text(c, 128));
    const data = { prompt, type, capabilities, chat };
    this.state.db
      .query("INSERT INTO work VALUES (?,?,?,?,?)")
      .run(workId, peer.id, "outbound", "pending", JSON.stringify(data));
    await this.call(peer, "work", { id: workId, prompt, type, capabilities });
    return { id: workId, status: "pending" };
  }
  async reviewWork(
    workId: string,
    result: string,
    allowed: string[],
    approve: boolean,
  ) {
    const row = this.state.db
      .query("SELECT * FROM work WHERE id=? AND direction='inbound'")
      .get(workId) as any;
    if (!row || !["pending", "response-pending"].includes(row.status))
      throw new Error("Work request unavailable.");
    const data = JSON.parse(row.data);
    text(result, 32768);
    if (allowed.some((c) => !data.capabilities.includes(c)))
      throw new Error("Cannot approve unrequested capabilities.");
    const reply = {
      id: workId,
      status: approve ? "completed" : "rejected",
      result,
      capabilities: allowed,
    };
    this.state.db
      .query("UPDATE work SET status='response-pending',data=? WHERE id=?")
      .run(JSON.stringify({ ...data, reply }), workId);
    await this.call(this.paired(row.peer), "work-result", reply);
    this.state.db
      .query("UPDATE work SET status=?,data=? WHERE id=?")
      .run(reply.status, JSON.stringify({ ...data, reply }), workId);
    return reply;
  }
  private async receiveWorkResult(peer: Peer, body: any) {
    const workId = text(body.id, 80);
    const row = this.state.db
      .query(
        "SELECT * FROM work WHERE id=? AND peer=? AND direction='outbound'",
      )
      .get(workId, peer.id) as any;
    if (!row) throw new Error("Unknown work request.");
    const result = text(body.result, 32768);
    if (!["completed", "rejected"].includes(body.status))
      throw new Error("Invalid work result.");
    if (!Array.isArray(body.capabilities))
      throw new Error("Invalid work capabilities.");
    const data = JSON.parse(row.data);
    const requested = data.capabilities;
    if (
      body.capabilities.some(
        (c: unknown) => typeof c !== "string" || !requested.includes(c),
      )
    )
      throw new Error("Invalid work capabilities.");
    const terminal = {
      status: body.status,
      result,
      capabilities: body.capabilities,
    };
    if (
      data.terminal &&
      JSON.stringify(data.terminal) !== JSON.stringify(terminal)
    )
      throw new Error("Conflicting terminal work result.");
    if (row.status === "completed" || row.status === "rejected")
      return { ok: true };

    // Store the exact terminal payload before performing the local side effect.
    // A failed enqueue returns to notification-pending for retry. A process
    // crash after enqueue is deliberately left notification-delivering and is
    // never replayed blindly because enqueue has no idempotency contract.
    if (
      row.status === "notification-delivering" ||
      row.status === "notification-unknown"
    )
      throw new Error(
        "Work notification outcome is unknown; inspect the origin chat before resolving manually.",
      );
    this.state.db
      .query("UPDATE work SET status='notification-pending',data=? WHERE id=?")
      .run(JSON.stringify({ ...data, terminal }), row.id);
    const claim = this.state.db
      .query(
        "UPDATE work SET status='notification-delivering' WHERE id=? AND status='notification-pending'",
      )
      .run(row.id);
    if (claim.changes !== 1)
      throw new Error("Work notification delivery is already in progress.");
    try {
      if (data.chat) {
        const enqueue = this.options.runtime.enqueueAgentMessage;
        if (!enqueue)
          throw new Error("Piclaw agent-message enqueue API is unavailable.");
        await enqueue({
          chatJid: data.chat,
          content: `Remote work ${row.id}: ${body.status}\n${result}`,
          mode: "queue",
          source: "addon.remote-peer",
        });
      }
    } catch (error) {
      this.state.db
        .query(
          "UPDATE work SET status='notification-pending' WHERE id=? AND status='notification-delivering'",
        )
        .run(row.id);
      throw error;
    }
    this.state.db
      .query(
        "UPDATE work SET status=?,data=? WHERE id=? AND status='notification-delivering'",
      )
      .run(
        body.status,
        JSON.stringify({ ...data, terminal, notificationDelivered: true }),
        row.id,
      );
    return { ok: true };
  }
  async ping(reference: string) {
    return (await this.call(this.paired(reference), "ping")).body;
  }
  async dashboard() {
    return {
      identity: this.identity(),
      config: this.state.config(),
      transport: this.transport.status(),
      discovery: this.discovery?.status() ?? { active: false, error: null },
      candidates:
        this.discovery
          ?.candidates()
          .map((c) => ({ ...c, clientId: clientId(c.id) })) ?? [],
      peers: this.state
        .peers()
        .map((p) => ({ ...p, clientId: clientId(p.id), ticket: undefined })),
      advertised: this.state.db.query("SELECT * FROM advertised").all(),
      messages: this.state.db
        .query(
          "SELECT id,peer,status,error,created FROM outbound ORDER BY created DESC LIMIT 50",
        )
        .all(),
      work: (
        this.state.db.query("SELECT * FROM work LIMIT 100").all() as any[]
      ).map((r) => {
        const d = JSON.parse(r.data);
        return {
          ...r,
          data: {
            prompt: d.prompt,
            type: d.type,
            capabilities: d.capabilities,
            result: d.terminal?.result ?? d.result,
            terminal_status: d.terminal?.status,
            notification_delivered: d.notificationDelivered === true,
          },
        };
      }),
      localAgents:
        await this.options.runtime.messaging!.listAdvertisableAgents(),
    };
  }
}

import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { endpointId, clientId } from "./client-id.js";
import type { RemotePeerConfig } from "./config.js";
const require = createRequire(import.meta.url);
export const ALPN = "piclaw-remote-peer/iroh/1";
export const MAX_BYTES = 32 * 1024 * 1024;
const HEADER_LIMIT = 192 * 1024;
const ALPN_BYTES = Array.from(Buffer.from(ALPN));
let native: any;
export function iroh(): any {
  if (!native) {
    try {
      native = require("@number0/iroh/index.js");
    } catch {
      throw new Error(
        "Iroh prebuilt native package unavailable for this OS/architecture. Reinstall Remote Peer on a supported platform; no source build is attempted.",
      );
    }
  }
  return native;
}
export interface Packet {
  v: 1;
  id: string;
  op: string;
  from: string;
  to: string;
  time: number;
  nonce: string;
  size: number;
  hash: string;
  body: any;
  signature: string;
}
export interface Reply {
  body: any;
  bytes?: Uint8Array;
}
export interface TransportOptions {
  keyBytes: number[];
  config: RemotePeerConfig;
  handler: (peer: string, packet: Packet, bytes: Uint8Array) => Promise<Reply>;
  bindAddr?: string;
  authorize?: (peer: string, packet: Packet) => boolean;
}
function canonical(value: Packet) {
  const { signature, ...rest } = value;
  return JSON.stringify(rest);
}
function hash(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
export class IrohTransport {
  readonly id: string;
  readonly clientId: string;
  private key: any;
  private endpoint: any = null;
  private pendingStart: Promise<void> | null = null;
  private connections = new Set<any>();
  private serving = new Set<Promise<void>>();
  private dialing = new Set<Promise<any>>();
  private active = 0;
  private outgoing = 0;
  private closed = false;
  private replay = new Map<string, number>();
  lastPath: string | null = null;
  error: string | null = null;
  constructor(private options: TransportOptions) {
    this.key = iroh().SecretKey.fromBytes(options.keyBytes);
    this.id = this.key.public().toString();
    this.clientId = clientId(this.id);
  }
  async start() {
    if (this.endpoint) return;
    if (this.pendingStart) return this.pendingStart;
    this.closed = false;
    this.pendingStart = this.bind();
    try {
      await this.pendingStart;
    } finally {
      this.pendingStart = null;
    }
  }
  private async bind() {
    const { Endpoint, RelayMode, RelayMap } = iroh(),
      builder = Endpoint.builder(),
      c = this.options.config;
    if (c.addressLookup) builder.applyN0();
    else builder.applyMinimal();
    builder.secretKey(this.options.keyBytes);
    builder.alpns([ALPN_BYTES]);
    if (this.options.bindAddr) builder.bindAddr(this.options.bindAddr);
    if (c.relayMode === "disabled") builder.relayMode(RelayMode.disabled());
    else if (c.relayMode === "n0") builder.relayMode(RelayMode.defaultMode());
    else {
      const map = RelayMap.empty();
      for (const relay of c.relays) {
        let authToken: string | undefined;
        if (relay.authTokenKeychain) {
          const name = relay.authTokenKeychain;
          authToken = process.env[name.replace(/[/.-]/g, "_").toUpperCase()];
          if (!authToken) {
            const bridge = (globalThis as any).__piclawRuntimeInterop;
            const entry = await bridge?.getKeychainEntry?.(name);
            authToken = typeof entry === "string" ? entry : entry?.secret;
          }
          if (!authToken)
            throw new Error(
              "Configured relay credential is unavailable in keychain.",
            );
        }
        map.insert({ url: relay.url, ...(authToken ? { authToken } : {}) });
      }
      builder.relayMode(RelayMode.custom(map));
    }
    const endpoint = await builder.bind();
    if (this.closed) {
      await endpoint.close();
      return;
    }
    this.endpoint = endpoint;
    void this.accept().catch(() => {
      if (!this.closed)
        this.error =
          "Iroh listener stopped; disable and enable Remote Peer to retry.";
    });
  }
  status() {
    return {
      active: !!this.endpoint && !this.closed,
      clientId: this.clientId,
      endpointId: this.id,
      relay: this.endpoint?.addr().relayUrl() ?? null,
      lastPath: this.lastPath,
      error: this.error,
    };
  }
  port() {
    const address = this.endpoint
      ?.boundSockets()
      .find((s: string) => !s.startsWith("["));
    return address ? Number(address.slice(address.lastIndexOf(":") + 1)) : 0;
  }
  ticket() {
    if (!this.endpoint)
      throw new Error("Enable Remote Peer before exporting a ticket.");
    return iroh().EndpointTicket.fromAddr(this.endpoint.addr()).toString();
  }
  private packet(
    to: string,
    op: string,
    body: any,
    bytes: Uint8Array,
    id: string = randomUUID(),
  ): Packet {
    const p: Packet = {
      v: 1,
      id,
      op,
      from: this.id,
      to,
      time: Date.now(),
      nonce: randomUUID(),
      size: bytes.byteLength,
      hash: hash(bytes),
      body,
      signature: "",
    };
    p.signature = Buffer.from(
      this.key.sign(Array.from(Buffer.from(canonical(p)))).toBytes(),
    ).toString("base64");
    return p;
  }
  private validate(p: Packet, remote: string, bytes: Uint8Array) {
    if (
      !p ||
      p.v !== 1 ||
      p.from !== remote ||
      p.to !== this.id ||
      typeof p.op !== "string" ||
      p.op.length > 32 ||
      typeof p.id !== "string" ||
      p.id.length > 80 ||
      typeof p.nonce !== "string" ||
      p.nonce.length > 80 ||
      !p.nonce ||
      !Number.isFinite(p.time) ||
      Math.abs(Date.now() - p.time) > 90000 ||
      p.size !== bytes.byteLength ||
      p.hash !== hash(bytes) ||
      typeof p.signature !== "string" ||
      p.signature.length > 100
    )
      throw new Error("Invalid Iroh protocol envelope.");
    const allowed = [
      "v",
      "id",
      "op",
      "from",
      "to",
      "time",
      "nonce",
      "size",
      "hash",
      "body",
      "signature",
    ];
    if (Object.keys(p).some((k) => !allowed.includes(k)))
      throw new Error("Unknown envelope field.");
    // Reconstruct field ordering; JSON key order from a remote is not trusted.
    const ordered = {
      v: p.v,
      id: p.id,
      op: p.op,
      from: p.from,
      to: p.to,
      time: p.time,
      nonce: p.nonce,
      size: p.size,
      hash: p.hash,
      body: p.body,
      signature: "",
    } as Packet;
    iroh()
      .EndpointId.fromString(remote)
      .verify(
        Array.from(Buffer.from(canonical(ordered))),
        iroh().Signature.fromBytes(
          Array.from(Buffer.from(p.signature, "base64")),
        ),
      );
    const now = Date.now();
    for (const [key, until] of this.replay)
      if (until < now) this.replay.delete(key);
    const key = remote + ":" + p.nonce;
    if (this.replay.has(key)) throw new Error("Replayed Iroh envelope.");
    if (this.replay.size >= 10000)
      throw new Error("Replay cache capacity exceeded.");
    this.replay.set(key, now + 180000);
  }
  private async write(stream: any, p: Packet, bytes: Uint8Array) {
    const header = Buffer.from(JSON.stringify(p));
    if (header.length > HEADER_LIMIT || bytes.length > MAX_BYTES)
      throw new Error("Iroh frame too large.");
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(header.length);
    await stream.writeAll(Array.from(prefix));
    await stream.writeAll(Array.from(header));
    for (let i = 0; i < bytes.length; i += 65536)
      await stream.writeAll(Array.from(bytes.subarray(i, i + 65536)));
    await stream.finish();
  }
  private async read(
    stream: any,
    remote?: string,
  ): Promise<{ packet: Packet; bytes: Uint8Array }> {
    const prefix = Buffer.from(await stream.readExact(4));
    const size = prefix.readUInt32BE();
    if (!size || size > HEADER_LIMIT) throw new Error("Invalid header length.");
    const packet = JSON.parse(
      Buffer.from(await stream.readExact(size)).toString(),
    ) as Packet;
    if (
      !Number.isSafeInteger(packet.size) ||
      packet.size < 0 ||
      packet.size > MAX_BYTES
    )
      throw new Error("Invalid body length.");
    if (remote && packet.size > 0 && packet.op !== "message")
      throw new Error("Only messages may carry binary data.");
    if (
      remote &&
      this.options.authorize &&
      !this.options.authorize(remote, packet)
    )
      throw new Error("Peer authorization required before body transfer.");
    const bytes = new Uint8Array(packet.size);
    for (let i = 0; i < bytes.length; i += 65536)
      bytes.set(await stream.readExact(Math.min(65536, bytes.length - i)), i);
    return { packet, bytes };
  }
  private async accept() {
    while (!this.closed && this.endpoint) {
      const incoming = await this.endpoint.acceptNext();
      if (!incoming) return;
      if (this.active >= 16) {
        incoming.refuse();
        continue;
      }
      this.active++;
      const task = this.serve(incoming)
        .catch(() => {})
        .finally(() => {
          this.active--;
          this.serving.delete(task);
        });
      this.serving.add(task);
    }
  }
  private async serve(incoming: any) {
    let connection: any;
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      connection?.close(1n, []);
    }, 30000);
    try {
      connection = await (await incoming.accept()).connect();
      if (expired || this.closed) {
        connection.close(1n, []);
        return;
      }
      this.connections.add(connection);
      connection.setMaxConcurrentBiStreams(1n);
      connection.setMaxConcurrentUniStreams(0n);
      connection.setReceiveWindow(BigInt(MAX_BYTES + HEADER_LIMIT));
      const remote = connection.remoteId().toString();
      const bi = await connection.acceptBi();
      const { packet, bytes } = await this.read(bi.recv, remote);
      this.validate(packet, remote, bytes);
      let result: Reply;
      try {
        result = await this.options.handler(remote, packet, bytes);
      } catch (error) {
        result = {
          body: {
            ok: false,
            error:
              error instanceof Error ? error.message : "Peer request rejected",
          },
        };
      }
      const replyBytes = result.bytes ?? new Uint8Array();
      await this.write(
        bi.send,
        this.packet(remote, "reply", result.body, replyBytes, packet.id),
        replyBytes,
      );
      await bi.send.stopped();
    } finally {
      clearTimeout(timer);
      if (connection) {
        this.connections.delete(connection);
        connection.close(0n, []);
      }
    }
  }
  async request(
    target: string,
    op: string,
    body: any = {},
    bytes = new Uint8Array(),
    ticket?: string,
    addresses?: string[],
    signal?: AbortSignal,
  ): Promise<Reply> {
    const id = endpointId(target);
    if (id === this.id) throw new Error("Cannot pair with this client.");
    if (bytes.length > MAX_BYTES) throw new Error("Iroh frame too large.");
    if (this.outgoing >= 8 || this.dialing.size >= 8)
      throw new Error("Too many concurrent outgoing peer requests.");
    await this.start();
    if (!this.endpoint) throw new Error("Remote Peer is stopped.");
    const addr = ticket
      ? iroh().EndpointTicket.fromString(ticket).endpointAddr()
      : new (iroh().EndpointAddr)(
          iroh().EndpointId.fromString(id),
          null,
          addresses ?? [],
        );
    if (addr.id().toString() !== id)
      throw new Error("Ticket does not match client ID.");
    if (!ticket && !addresses?.length && !this.options.config.addressLookup)
      throw new Error(
        "Enable Internet address lookup in Settings for ID-only dialing, or provide a ticket / nearby address.",
      );
    let connection: any;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const cancel = () => connection?.close(1n, []);
    signal?.throwIfAborted();
    signal?.addEventListener("abort", cancel, { once: true });
    if (this.outgoing >= 8 || this.dialing.size >= 8)
      throw new Error("Too many concurrent outgoing peer requests.");
    this.outgoing++;
    try {
      const operation = (async () => {
        const dial = this.endpoint.connect(addr, ALPN_BYTES);
        this.dialing.add(dial);
        try {
          connection = await dial;
        } finally {
          this.dialing.delete(dial);
        }
        if (finished || signal?.aborted) {
          connection.close(1n, []);
          throw new Error("Peer request cancelled.");
        }
        this.connections.add(connection);
        const packet = this.packet(id, op, body, bytes),
          bi = await connection.openBi();
        await this.write(bi.send, packet, bytes);
        const reply = await this.read(bi.recv);
        this.validate(reply.packet, id, reply.bytes);
        if (reply.packet.op !== "reply" || reply.packet.id !== packet.id)
          throw new Error("Mismatched Iroh response.");
        this.lastPath = connection.paths().find((p: any) => p.isSelected)
          ?.isRelay
          ? "relay"
          : "direct";
        if (reply.packet.body?.ok === false)
          throw new Error(
            String(reply.packet.body.error || "Peer request rejected."),
          );
        return { body: reply.packet.body, bytes: reply.bytes };
      })();
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Iroh request timed out.")),
            30000,
          );
        }),
      ]);
    } finally {
      this.outgoing--;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (connection) {
        this.connections.delete(connection);
        connection.close(0n, []);
      }
    }
  }
  async close() {
    this.closed = true;
    for (const c of this.connections) c.close(0n, []);
    this.connections.clear();
    const e = this.endpoint;
    this.endpoint = null;
    if (e) await e.close();
    if (this.pendingStart) await this.pendingStart.catch(() => {});
    await Promise.allSettled([...this.dialing, ...this.serving]);
  }
}

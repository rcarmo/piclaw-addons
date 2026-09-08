import { isIP } from "node:net";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const SERVICE_TYPE = "piclaw-peer";
const SERVICE_PROTOCOL = "udp";
const MAX_CANDIDATES = 64;
const MAX_TTL_SECONDS = 120;
const MAX_ADDRESSES = 16;
const INSTANCE_ID_RE = /^[0-9a-f]{64}$/;
const ENDPOINT_ID_RE = /^[0-9a-f]{64}$/;

export interface PeerCandidate {
  id: string;
  instanceId: string;
  name: string;
  addresses: string[];
  port: number;
  lastSeen: number;
}

export interface PeerDiscoveryOptions {
  instanceId: string;
  endpointId: string;
  port: number;
  name: string;
  interfaceAddress?: string;
  factory?: (options: any) => Promise<any>;
}

interface StoredCandidate extends PeerCandidate {
  source: string;
  expiresAt: number;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validInstanceId(value: string): boolean {
  return INSTANCE_ID_RE.test(value);
}

function validName(value: string): boolean {
  return (
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 63 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function withoutZone(address: string): string {
  const percent = address.indexOf("%");
  return percent === -1 ? address : address.slice(0, percent);
}

function canonicalIp(address: string): string | null {
  const bare = withoutZone(address);
  const family = isIP(bare);
  if (family === 4) return bare;
  if (family !== 6) return null;
  try {
    const hostname = new URL(`http://[${bare}]/`).hostname;
    return hostname.slice(1, -1).toLowerCase();
  } catch {
    return null;
  }
}

function isPrivateOrLocalAddress(address: string): boolean {
  const bare = withoutZone(address);
  const family = isIP(bare);
  if (family === 4) {
    const octets = bare.split(".").map(Number);
    const [a, b] = octets;
    if (a === 0 || a === 127 || a >= 224) return false;
    return (
      a === 10 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (family !== 6) return false;

  const lower = bare.toLowerCase();
  if (lower === "::" || lower === "::1" || lower.startsWith("ff")) return false;
  if (lower.startsWith("::ffff:"))
    return isPrivateOrLocalAddress(lower.slice(7));
  const first = Number.parseInt(lower.split(":", 1)[0], 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

function txtString(value: unknown, maxBytes: number): string | null {
  if (typeof value === "string")
    return Buffer.byteLength(value, "utf8") <= maxBytes ? value : null;
  if (!(value instanceof Uint8Array) || value.byteLength > maxBytes)
    return null;
  return Buffer.from(value).toString("utf8");
}

function callbackMethod(target: any, methodName: string): Promise<void> {
  const method = target?.[methodName];
  if (typeof method !== "function") return Promise.resolve();
  if (method.length === 0) return Promise.resolve(method.call(target));
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error?: unknown) => {
      if (settled) return;
      settled = true;
      error ? reject(error) : resolve();
    };
    try {
      const result = method.call(target, done);
      if (result && typeof result.then === "function")
        result.then(() => done(), done);
    } catch (error) {
      done(error);
    }
  });
}

export class PeerDiscovery {
  private readonly options: PeerDiscoveryOptions;
  private bonjour: any = null;
  private browser: any = null;
  private service: any = null;
  private active = false;
  private error: string | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private starting: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private readonly peers = new Map<string, StoredCandidate>();
  private readonly sources = new Map<string, string>();

  constructor(options: PeerDiscoveryOptions) {
    this.options = { ...options };
    if (!validInstanceId(options.instanceId))
      throw new Error(
        "mDNS discovery instanceId must be a 64-character hexadecimal Iroh client ID.",
      );
    if (!ENDPOINT_ID_RE.test(options.endpointId))
      throw new Error(
        "mDNS discovery endpointId must be 64 lowercase hexadecimal characters.",
      );
    if (
      !Number.isInteger(options.port) ||
      options.port < 1 ||
      options.port > 65_535
    )
      throw new Error(
        "mDNS discovery port must be an integer from 1 to 65535.",
      );
    if (!validName(options.name))
      throw new Error(
        "mDNS discovery name must be a non-empty DNS-SD label of at most 63 UTF-8 bytes without control characters.",
      );
    if (
      options.interfaceAddress !== undefined &&
      canonicalIp(options.interfaceAddress) === null
    )
      throw new Error(
        "mDNS discovery interfaceAddress must be an IPv4 or IPv6 literal.",
      );
  }

  status(): { active: boolean; error: string | null } {
    return { active: this.active, error: this.error };
  }

  candidates(): PeerCandidate[] {
    return [...this.peers.values()].map(
      ({ source: _source, expiresAt: _expiresAt, ...candidate }) => ({
        ...candidate,
        addresses: [...candidate.addresses],
      }),
    );
  }

  async start(): Promise<void> {
    if (this.active) return;
    if (this.starting) return this.starting;
    const starting = this.startInternal();
    this.starting = starting;
    try {
      await starting;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const stopping = this.stopInternal();
    this.stopping = stopping;
    try {
      await stopping;
    } finally {
      if (this.stopping === stopping) this.stopping = null;
    }
  }

  private async startInternal(): Promise<void> {
    this.error = null;
    try {
      const mdnsOptions = this.options.interfaceAddress
        ? { interface: this.options.interfaceAddress }
        : {};
      if (this.options.factory) {
        this.bonjour = await this.options.factory(mdnsOptions);
      } else {
        let imported: any;
        try {
          imported = require("bonjour-service");
        } catch (error) {
          throw new Error(
            `bonjour-service@1.4.4 is required when mDNS discovery is enabled (${message(error)}).`,
          );
        }
        const Bonjour =
          imported.Bonjour ?? imported.default?.Bonjour ?? imported.default;
        if (typeof Bonjour !== "function")
          throw new Error(
            "bonjour-service@1.4.4 did not export a Bonjour constructor.",
          );
        this.bonjour = new Bonjour(mdnsOptions, (error: unknown) =>
          this.recordRuntimeError(error),
        );
      }
      if (
        !this.bonjour ||
        typeof this.bonjour.publish !== "function" ||
        typeof this.bonjour.find !== "function"
      ) {
        throw new Error(
          "the mDNS factory did not return a bonjour-service compatible instance.",
        );
      }

      this.service = this.bonjour.publish({
        name: this.options.name,
        type: SERVICE_TYPE,
        protocol: SERVICE_PROTOCOL,
        port: this.options.port,
        probe: true,
        txt: {
          v: "1",
          endpoint: this.options.endpointId,
          instance: this.options.instanceId,
        },
      });
      this.restrictPublishedRecords();
      this.service?.on?.("error", this.onServiceError);

      this.browser = this.bonjour.find({
        type: SERVICE_TYPE,
        protocol: SERVICE_PROTOCOL,
      });
      if (!this.browser || typeof this.browser.on !== "function")
        throw new Error(
          "bonjour-service did not return a usable mDNS browser.",
        );
      this.browser.on("up", this.onUp);
      this.browser.on("down", this.onDown);
      this.browser.on("txt-update", this.onUp);
      this.browser.on("srv-update", this.onUp);
      this.active = true;
      // Bonjour does not emit up again for unchanged records. Refresh its cached TTLs
      // and send bounded queries so stable services do not disappear after our cap.
      this.refreshTimer = setInterval(() => {
        this.browser?.expire?.();
        for (const candidate of this.browser?.services ?? [])
          this.acceptService(candidate);
        this.browser?.update?.();
      }, 30000);
      this.refreshTimer.unref?.();
      this.scheduleExpiry();
    } catch (error) {
      const primary = `mDNS discovery failed to start: ${message(error)}`;
      try {
        await this.releaseResources();
      } catch (cleanupError) {
        this.error = `${primary} Cleanup also failed: ${message(cleanupError)}`;
        throw new Error(this.error);
      }
      this.error = primary;
      throw new Error(primary);
    }
  }

  private async stopInternal(): Promise<void> {
    if (this.starting) {
      try {
        await this.starting;
      } catch {
        // startInternal already released every resource it acquired.
      }
    }
    try {
      await this.releaseResources();
    } catch (error) {
      this.error = `mDNS discovery failed to stop cleanly: ${message(error)}`;
      throw new Error(this.error);
    }
  }

  private restrictPublishedRecords(): void {
    if (!this.service || typeof this.service.records !== "function") {
      if (this.options.interfaceAddress)
        throw new Error(
          "bonjour-service did not expose service.records(); cannot prevent cross-interface address advertisement.",
        );
      return;
    }
    const originalRecords = this.service.records.bind(this.service);
    const configured = this.options.interfaceAddress
      ? canonicalIp(this.options.interfaceAddress)
      : null;
    // In bonjour-service 1.4.4 probing always defers the first records() call,
    // so this override is installed before any announcement is registered.
    this.service.records = () =>
      originalRecords()
        .filter((record: any) => {
          if (!configured || (record?.type !== "A" && record?.type !== "AAAA"))
            return true;
          return (
            typeof record.data === "string" &&
            canonicalIp(record.data) === configured
          );
        })
        .map((record: any) => ({
          ...record,
          ttl: Math.min(MAX_TTL_SECONDS, Math.max(0, Number(record.ttl) || 0)),
        }));
  }

  private readonly onServiceError = (error: unknown) =>
    this.recordRuntimeError(error);
  private readonly onUp = (service: any) => this.acceptService(service);
  private readonly onDown = (service: any) => this.removeService(service);

  private recordRuntimeError(error: unknown): void {
    this.error = `mDNS discovery runtime error: ${message(error)}`;
  }

  private acceptService(service: any): void {
    const txt = service?.txt;
    const version = txtString(txt?.v, 1);
    const endpointId = txtString(txt?.endpoint, 64);
    const instanceId = txtString(txt?.instance, 64);
    const name = typeof service?.name === "string" ? service.name : "";
    const source =
      typeof service?.fqdn === "string" &&
      Buffer.byteLength(service.fqdn, "utf8") <= 255
        ? service.fqdn
        : "";
    const port = Number(service?.port);
    if (
      version !== "1" ||
      !endpointId ||
      !ENDPOINT_ID_RE.test(endpointId) ||
      !instanceId ||
      !validInstanceId(instanceId)
    )
      return;
    if (
      endpointId === this.options.endpointId ||
      instanceId === this.options.instanceId
    )
      return;
    if (
      !validName(name) ||
      !source ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65_535
    )
      return;

    const addresses: string[] = [];
    for (const address of Array.isArray(service.addresses)
      ? service.addresses
      : []) {
      if (
        typeof address !== "string" ||
        !isPrivateOrLocalAddress(address) ||
        addresses.includes(address)
      )
        continue;
      addresses.push(address);
      if (addresses.length === MAX_ADDRESSES) break;
    }
    if (addresses.length === 0) return;

    const now = Date.now();
    const advertisedTtl = Number(service.ttl);
    const ttl =
      Number.isFinite(advertisedTtl) && advertisedTtl > 0
        ? Math.min(MAX_TTL_SECONDS, Math.max(1, Math.floor(advertisedTtl)))
        : MAX_TTL_SECONDS;

    const previousForSource = this.sources.get(source);
    if (
      previousForSource &&
      previousForSource !== endpointId &&
      this.peers.get(previousForSource)?.source === source
    ) {
      this.peers.delete(previousForSource);
    }
    const previousForEndpoint = this.peers.get(endpointId);
    if (previousForEndpoint && previousForEndpoint.source !== source)
      this.sources.delete(previousForEndpoint.source);

    this.peers.set(endpointId, {
      id: endpointId,
      instanceId,
      name,
      addresses,
      port,
      lastSeen: Number.isFinite(service.lastSeen)
        ? Math.min(now, service.lastSeen)
        : now,
      source,
      expiresAt:
        (Number.isFinite(service.lastSeen)
          ? Math.min(now, service.lastSeen)
          : now) +
        ttl * 1000,
    });
    this.sources.set(source, endpointId);
    this.enforceCandidateLimit();
    this.scheduleExpiry();
  }

  private removeService(service: any): void {
    const source = typeof service?.fqdn === "string" ? service.fqdn : "";
    const endpointId = this.sources.get(source);
    if (!endpointId) return;
    if (this.peers.get(endpointId)?.source === source)
      this.peers.delete(endpointId);
    this.sources.delete(source);
    this.scheduleExpiry();
  }

  private enforceCandidateLimit(): void {
    while (this.peers.size > MAX_CANDIDATES) {
      let oldest: StoredCandidate | undefined;
      for (const candidate of this.peers.values()) {
        if (!oldest || candidate.lastSeen < oldest.lastSeen) oldest = candidate;
      }
      if (!oldest) break;
      this.peers.delete(oldest.id);
      this.sources.delete(oldest.source);
    }
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (!this.active || this.peers.size === 0) return;
    const nextExpiry = Math.min(
      ...[...this.peers.values()].map((candidate) => candidate.expiresAt),
    );
    this.expiryTimer = setTimeout(
      () => {
        this.expiryTimer = null;
        const now = Date.now();
        for (const [id, candidate] of this.peers) {
          if (candidate.expiresAt > now) continue;
          this.peers.delete(id);
          this.sources.delete(candidate.source);
        }
        this.scheduleExpiry();
      },
      Math.max(0, nextExpiry - Date.now()),
    );
    this.expiryTimer.unref?.();
  }

  private async releaseResources(): Promise<void> {
    this.active = false;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.peers.clear();
    this.sources.clear();

    const browser = this.browser;
    const service = this.service;
    const bonjour = this.bonjour;
    this.browser = null;
    this.service = null;
    this.bonjour = null;
    const errors: string[] = [];

    try {
      browser?.stop?.();
    } catch (error) {
      errors.push(`browser stop: ${message(error)}`);
    }
    browser?.removeListener?.("up", this.onUp);
    browser?.removeListener?.("down", this.onDown);
    browser?.removeListener?.("txt-update", this.onUp);
    browser?.removeListener?.("srv-update", this.onUp);
    service?.removeListener?.("error", this.onServiceError);
    try {
      await callbackMethod(service, "stop");
    } catch (error) {
      errors.push(`service stop: ${message(error)}`);
    }
    try {
      await callbackMethod(bonjour, "unpublishAll");
    } catch (error) {
      errors.push(`unpublish services: ${message(error)}`);
    }
    try {
      await callbackMethod(bonjour, "destroy");
    } catch (error) {
      errors.push(`bonjour destroy: ${message(error)}`);
    }
    if (errors.length) throw new Error(errors.join("; "));
  }
}

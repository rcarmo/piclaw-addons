import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { RemotePeerConfig } from "../config.js";

export type ResolveHost = (hostname: string) => Promise<string[]>;

function parseIpv4(host: string): number[] | null {
  const parts = host.split(".").map(part => Number.parseInt(part, 10));
  return parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

function blockedIpv4(host: string): boolean {
  const value = parseIpv4(host);
  if (!value) return false;
  const [a, b] = value;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
}

function blockedIpv6(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("::ffff:")) return blockedIpv4(lower.slice(7));
  const first = Number.parseInt(lower.split(":")[0] || "0", 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

function blockedAddress(host: string): boolean {
  const family = isIP(host);
  return family === 4 ? blockedIpv4(host) : family === 6 ? blockedIpv6(host) : false;
}

async function defaultResolve(hostname: string): Promise<string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map(record => record.address);
}

export async function validatePeerUrl(
  raw: string,
  config: Pick<RemotePeerConfig, "allowHttp" | "allowPrivateNetwork">,
  resolveHost: ResolveHost = defaultResolve,
): Promise<{ ok: true; url: URL } | { ok: false; error: string }> {
  let url: URL;
  try { url = new URL(raw); }
  catch { return { ok: false, error: "Invalid peer URL." }; }
  if (url.username || url.password) return { ok: false, error: "Peer URL must not contain credentials." };
  if (url.protocol !== "https:" && !(config.allowHttp && url.protocol === "http:")) {
    return { ok: false, error: "Peer URL must use https." };
  }
  if (config.allowPrivateNetwork) return { ok: true, url };
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || blockedAddress(host)) {
    return { ok: false, error: "Peer URL points to a private or loopback address." };
  }
  try {
    const addresses = await resolveHost(host);
    if (addresses.length === 0) return { ok: false, error: "Peer hostname could not be resolved." };
    if (addresses.some(blockedAddress)) return { ok: false, error: "Peer URL points to a private or loopback address." };
  } catch {
    return { ok: false, error: "Peer hostname could not be resolved." };
  }
  return { ok: true, url };
}

export function baseUrl(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

export interface RemotePeerConfig {
  enabled: boolean;
  instanceName: string;
  externalUrl: string;
  allowHttp: boolean;
  allowPrivateNetwork: boolean;
}

export const DEFAULT_REMOTE_PEER_CONFIG: Readonly<RemotePeerConfig> = Object.freeze({
  enabled: false,
  instanceName: "",
  externalUrl: "",
  allowHttp: false,
  allowPrivateNetwork: false,
});

function normalizeUrl(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("externalUrl must use https or http.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function normalizeRemotePeerConfig(value: unknown): RemotePeerConfig {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const instanceName = typeof input.instanceName === "string" ? input.instanceName.trim() : "";
  if (instanceName.length > 128) throw new Error("instanceName exceeds 128 characters.");
  return {
    enabled: input.enabled === true,
    instanceName,
    externalUrl: normalizeUrl(input.externalUrl),
    allowHttp: input.allowHttp === true,
    allowPrivateNetwork: input.allowPrivateNetwork === true,
  };
}

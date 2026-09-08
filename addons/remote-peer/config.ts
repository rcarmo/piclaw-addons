import { isIP } from "node:net";
export interface RemotePeerConfig {
  enabled: boolean;
  instanceName: string;
  mdnsEnabled: boolean;
  mdnsInterface: string;
  addressLookup: boolean;
  relayMode: "n0" | "custom" | "disabled";
  relays: Array<{ url: string; authTokenKeychain?: string }>;
}
export const DEFAULT_REMOTE_PEER_CONFIG: Readonly<RemotePeerConfig> =
  Object.freeze({
    enabled: false,
    instanceName: "",
    mdnsEnabled: false,
    mdnsInterface: "",
    addressLookup: false,
    relayMode: "n0",
    relays: [],
  });
export function normalizeRemotePeerConfig(value: unknown): RemotePeerConfig {
  const v =
    value && typeof value === "object" ? (value as Record<string, any>) : {};
  for (const key of Object.keys(v))
    if (!(key in DEFAULT_REMOTE_PEER_CONFIG))
      throw new Error("Unknown Remote Peer setting: " + key);
  const instanceName = String(v.instanceName ?? "").trim();
  if (
    Buffer.byteLength(instanceName) > 63 ||
    /[\x00-\x1f\x7f]/.test(instanceName)
  )
    throw new Error("Instance name must fit a 63-byte DNS-SD label.");
  const mdnsInterface = String(v.mdnsInterface ?? "").trim();
  if (mdnsInterface && isIP(mdnsInterface) !== 4)
    throw new Error("mDNS interface must be an IPv4 address.");
  const relayMode = v.relayMode ?? "n0";
  if (!["n0", "custom", "disabled"].includes(relayMode))
    throw new Error("Invalid relay mode.");
  if (v.relays !== undefined && !Array.isArray(v.relays))
    throw new Error("Relays must be an array.");
  if ((v.relays ?? []).length > 8)
    throw new Error("At most eight custom relays.");
  const relays = (v.relays ?? []).map((item: any) => {
    const url = new URL(String(item?.url ?? ""));
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        "Relay must be an HTTPS URL without embedded credentials.",
      );
    const authTokenKeychain = String(item.authTokenKeychain ?? "").trim();
    if (
      authTokenKeychain &&
      !/^[a-zA-Z0-9/_.-]{1,128}$/.test(authTokenKeychain)
    )
      throw new Error("Invalid relay keychain reference.");
    return {
      url: url.toString(),
      ...(authTokenKeychain ? { authTokenKeychain } : {}),
    };
  });
  if (relayMode === "custom" && !relays.length)
    throw new Error("Provide at least one custom relay.");
  for (const key of ["enabled", "mdnsEnabled", "addressLookup"])
    if (v[key] !== undefined && typeof v[key] !== "boolean")
      throw new Error(key + " must be boolean.");
  return {
    enabled: v.enabled === true,
    instanceName,
    mdnsEnabled: v.mdnsEnabled === true,
    mdnsInterface,
    addressLookup: v.addressLookup === true,
    relayMode,
    relays,
  };
}

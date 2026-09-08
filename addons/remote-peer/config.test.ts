import { test, expect } from "bun:test";
import {
  normalizeRemotePeerConfig,
  DEFAULT_REMOTE_PEER_CONFIG,
} from "./config.js";
test("all network services are disabled by default; no legacy settings", () => {
  expect(normalizeRemotePeerConfig({})).toEqual(DEFAULT_REMOTE_PEER_CONFIG);
  expect(DEFAULT_REMOTE_PEER_CONFIG.enabled).toBe(false);
  expect(DEFAULT_REMOTE_PEER_CONFIG.mdnsEnabled).toBe(false);
  expect(DEFAULT_REMOTE_PEER_CONFIG.addressLookup).toBe(false);
  for (const key of ["allowHttp", "externalUrl", "allowPrivateNetwork"])
    expect(() => normalizeRemotePeerConfig({ [key]: true })).toThrow();
});
test("validates relay credentials, type, interface and DNS-SD label limits", () => {
  for (const input of [
    { enabled: "false" },
    { mdnsInterface: "host.local" },
    { relayMode: "custom" },
    { relays: [{ url: "http://relay.local" }] },
    { relays: [{ url: "https://user:secret@example.com" }] },
    { instanceName: "x".repeat(64) },
    { instanceName: "line\nbreak" },
  ])
    expect(() => normalizeRemotePeerConfig(input)).toThrow();
  const config = normalizeRemotePeerConfig({
    enabled: true,
    mdnsEnabled: true,
    addressLookup: true,
    mdnsInterface: "192.168.1.2",
    relayMode: "custom",
    relays: [{ url: "https://relay.example", authTokenKeychain: "iroh/relay" }],
  });
  expect(config.relays[0].authTokenKeychain).toBe("iroh/relay");
});

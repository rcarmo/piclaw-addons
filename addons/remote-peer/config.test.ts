import { describe, expect, test } from "bun:test";
import { DEFAULT_REMOTE_PEER_CONFIG, normalizeRemotePeerConfig } from "./config.js";

describe("remote-peer config", () => {
  test("defaults to disabled secure settings", () => {
    expect(normalizeRemotePeerConfig({})).toEqual(DEFAULT_REMOTE_PEER_CONFIG);
  });

  test("normalizes names and external URLs", () => {
    expect(normalizeRemotePeerConfig({
      enabled: true,
      instanceName: "  Lab  ",
      externalUrl: "https://peer.example.test/base///?ignored=1#x",
      allowHttp: true,
      allowPrivateNetwork: true,
    })).toEqual({
      enabled: true,
      instanceName: "Lab",
      externalUrl: "https://peer.example.test/base",
      allowHttp: true,
      allowPrivateNetwork: true,
    });
  });

  test("rejects unsupported URL schemes and oversized names", () => {
    expect(() => normalizeRemotePeerConfig({ externalUrl: "file:///tmp/test" })).toThrow("https or http");
    expect(() => normalizeRemotePeerConfig({ instanceName: "x".repeat(129) })).toThrow("128");
  });
});

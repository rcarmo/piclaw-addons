import { describe, expect, test } from "bun:test";
import { baseUrl, validatePeerUrl } from "./ssrf.js";

const secure = { allowHttp: false, allowPrivateNetwork: false };

describe("remote-peer URL validation", () => {
  test("requires https and rejects credentials and private destinations", async () => {
    expect(await validatePeerUrl("http://peer.example", secure, async () => ["203.0.113.10"])).toEqual({ ok: false, error: "Peer URL must use https." });
    expect(await validatePeerUrl("https://user:pass@peer.example", secure, async () => ["203.0.113.10"])).toEqual({ ok: false, error: "Peer URL must not contain credentials." });
    expect(await validatePeerUrl("https://localhost", secure)).toEqual({ ok: false, error: "Peer URL points to a private or loopback address." });
    expect(await validatePeerUrl("https://peer.example", secure, async () => ["127.0.0.1"])).toEqual({ ok: false, error: "Peer URL points to a private or loopback address." });
    expect(await validatePeerUrl("https://peer.example", secure, async () => ["203.0.113.10", "10.0.0.2"])).toEqual({ ok: false, error: "Peer URL points to a private or loopback address." });
    expect(await validatePeerUrl("https://peer.example", secure, async () => [])).toEqual({ ok: false, error: "Peer hostname could not be resolved." });
  });

  test("permits explicit development overrides and normalizes to an origin", async () => {
    const result = await validatePeerUrl("http://127.0.0.1:8080/callback?x=1", { allowHttp: true, allowPrivateNetwork: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(baseUrl(result.url)).toBe("http://127.0.0.1:8080");
  });
});

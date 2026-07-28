import { describe, expect, test } from "bun:test";
import { createRemotePeerIdentity } from "../identity.js";
import { verifySignedRequest } from "./auth.js";
import { buildSignedHeaders } from "./canonical.js";
import { NonceReplayCache } from "./nonce-cache.js";

const encoder = new TextEncoder();

describe("remote-peer signed protocol", () => {
  test("verifies exact body bytes and rejects replay", () => {
    const identity = createRemotePeerIdentity(new Date("2026-01-01T00:00:00.000Z"));
    const path = "/api/addons/remote-peer/v1/ping?probe=1";
    const body = encoder.encode('{"value":1}');
    const timestamp = "2026-01-01T00:00:00.000Z";
    const headers = buildSignedHeaders(identity, path, body, 3, timestamp, "nonce-1");
    const request = new Request(`https://peer.example${path}`, { method: "POST", headers, body });
    const peer = { instance_id: identity.instance_id, public_key: identity.public_key, trust_epoch: 3 };
    const cache = new NonceReplayCache();

    expect(verifySignedRequest(request, body, peer, cache, Date.parse(timestamp))).toEqual({ ok: true });
    expect(verifySignedRequest(request, body, peer, cache, Date.parse(timestamp))).toEqual({ ok: false, error: "Replay detected." });
  });

  test("rejects body mutation, stale trust, skew, and invalid key material", () => {
    const identity = createRemotePeerIdentity();
    const path = "/api/addons/remote-peer/v1/ping";
    const signed = encoder.encode('{"value":1}');
    const mutated = encoder.encode('{ "value": 1 }');
    const timestamp = "2026-01-01T00:00:00.000Z";
    const headers = buildSignedHeaders(identity, path, signed, 2, timestamp, "nonce-2");
    const request = new Request(`https://peer.example${path}`, { method: "POST", headers, body: signed });
    const cache = new NonceReplayCache();

    expect(verifySignedRequest(request, mutated, { instance_id: identity.instance_id, public_key: identity.public_key, trust_epoch: 2 }, cache, Date.parse(timestamp))).toEqual({ ok: false, error: "Signature verification failed." });
    expect(verifySignedRequest(request, signed, { instance_id: identity.instance_id, public_key: identity.public_key, trust_epoch: 3 }, cache, Date.parse(timestamp))).toEqual({ ok: false, error: "Stale trust epoch." });
    expect(verifySignedRequest(request, signed, { instance_id: identity.instance_id, public_key: identity.public_key, trust_epoch: 2 }, cache, Date.parse(timestamp) + 91_000)).toEqual({ ok: false, error: "Timestamp skew too large." });
    expect(verifySignedRequest(request, signed, { instance_id: identity.instance_id, public_key: "invalid", trust_epoch: 2 }, cache, Date.parse(timestamp))).toEqual({ ok: false, error: "Signature verification failed." });
  });

  test("bounds replay cache entries per peer", () => {
    const cache = new NonceReplayCache(1_000, 2);
    expect(cache.checkAndStore("peer", "one", 10)).toBe(true);
    expect(cache.checkAndStore("peer", "two", 11)).toBe(true);
    expect(cache.checkAndStore("peer", "three", 12)).toBe(true);
    expect(cache.checkAndStore("peer", "one", 13)).toBe(true);
    expect(cache.checkAndStore("peer", "three", 13)).toBe(false);
    expect(cache.checkAndStore("peer", "fresh", 2_000)).toBe(true);
  });
});

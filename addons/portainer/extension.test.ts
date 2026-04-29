import { describe, expect, test } from "bun:test";

import { derivePortainerHostInput, normalizePortainerBaseUrlInput } from "./extension.js";

describe("portainer settings helpers", () => {
  test("normalizes bare hosts and IPs into the Portainer base URL", () => {
    expect(normalizePortainerBaseUrlInput("relay.local")).toBe("https://relay.local:9443");
    expect(normalizePortainerBaseUrlInput("192.168.1.20")).toBe("https://192.168.1.20:9443");
  });

  test("preserves explicit URLs while trimming trailing slashes", () => {
    expect(normalizePortainerBaseUrlInput("https://relay.local:9443/")).toBe("https://relay.local:9443");
    expect(normalizePortainerBaseUrlInput("https://relay.local:9443/api")).toBe("https://relay.local:9443/api");
    expect(derivePortainerHostInput("https://relay.local:9443")).toBe("relay.local");
  });
});

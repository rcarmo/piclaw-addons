import { describe, expect, test } from "bun:test";

import { deriveProxmoxHostInput, normalizeProxmoxBaseUrlInput } from "./extension.js";

describe("proxmox settings helpers", () => {
  test("normalizes bare hosts and IPs into the Proxmox API base URL", () => {
    expect(normalizeProxmoxBaseUrlInput("borg.local")).toBe("https://borg.local:8006/api2/json");
    expect(normalizeProxmoxBaseUrlInput("192.168.1.10")).toBe("https://192.168.1.10:8006/api2/json");
  });

  test("preserves explicit URLs while ensuring /api2/json is present", () => {
    expect(normalizeProxmoxBaseUrlInput("https://borg.local:8006")).toBe("https://borg.local:8006/api2/json");
    expect(normalizeProxmoxBaseUrlInput("https://borg.local:8006/api2/json")).toBe("https://borg.local:8006/api2/json");
    expect(deriveProxmoxHostInput("https://borg.local:8006/api2/json")).toBe("borg.local");
  });
});

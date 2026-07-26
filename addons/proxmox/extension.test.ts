import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { deriveProxmoxHostInput, normalizeProxmoxBaseUrlInput } from "./extension.js";

const addonDir = import.meta.dir;

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

  test("compat shims do not import piclaw runtime source modules", () => {
    const kvSource = readFileSync(resolve(addonDir, "compat", "extension-kv.ts"), "utf8");
    const keychainSource = readFileSync(resolve(addonDir, "compat", "keychain.ts"), "utf8");
    expect(kvSource).not.toContain("require(");
    expect(kvSource).not.toContain("piclaw/runtime/src");
    expect(keychainSource).not.toContain("require(");
    expect(keychainSource).not.toContain("piclaw/runtime/src");
  });

  test("tool schema uses Google-compatible string enums", () => {
    const source = readFileSync(resolve(addonDir, "extension.ts"), "utf8");
    expect(source).toContain("const PROXMOX_WORKFLOW_IDS = [");
    expect(source).toContain("const PROXMOX_ACTIONS = [");
    expect(source).toContain("Type.String({\n  enum: [...PROXMOX_WORKFLOW_IDS]");
    expect(source).toContain("Type.String({\n    enum: [...PROXMOX_ACTIONS]");
    expect(source).toContain('enum: ["form", "json"]');
    expect(source).toContain('enum: ["json", "jsonl"]');
    expect(source).toContain('enum: ["posix", "powershell"]');
    expect(source).not.toContain("const ProxmoxWorkflowSchema = Type.Union");
  });
});

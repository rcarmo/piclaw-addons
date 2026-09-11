import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { derivePortainerHostInput, normalizePortainerBaseUrlInput } from "./extension.js";

const addonDir = import.meta.dir;

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
    expect(source).toContain('import { StringEnum } from "@earendil-works/pi-ai";');
    expect(source).toContain("const PORTAINER_WORKFLOW_IDS = [");
    expect(source).toContain("const PORTAINER_ACTIONS = [");
    expect(source).toContain("StringEnum(PORTAINER_WORKFLOW_IDS");
    expect(source).toContain("StringEnum(PORTAINER_ACTIONS");
    expect(source).toContain('StringEnum(["json", "text"] as const');
    expect(source).toContain('StringEnum(["json", "jsonl"] as const');
    expect(source).toContain('StringEnum(["posix", "powershell"] as const');
    expect(source).not.toContain("enum:");
  });
});

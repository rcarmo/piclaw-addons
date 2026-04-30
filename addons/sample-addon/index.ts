/**
 * sample-addon/index.ts — Starter template for piclaw add-ons.
 *
 * Demonstrates:
 *   - Reading/writing config to SQLite KV (extension_kv, global scope)
 *   - Storing a secret in the keychain via the web settings pane
 *   - Registering a direct backend config API for the settings pane
 *   - Registering a tool that returns a value from config
 *
 * Use this as a starting point for new add-ons.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createExtensionStorage, type ExtensionStorage } from "./compat/extension-kv.js";

const EXTENSION_ID = "sample-addon";

// ── SQLite KV config ─────────────────────────────────────────────

interface SampleConfig {
  enabled: boolean;
  greeting: string;           // a non-secret value stored in KV
  secret_keychain: string;    // keychain entry name for the secret
}

const DEFAULT_CONFIG: SampleConfig = {
  enabled: false,
  greeting: "Hello from sample addon!",
  secret_keychain: "sample-addon/api-key",
};

let kvStore: ExtensionStorage | null = null;
function kv(): ExtensionStorage {
  if (!kvStore) kvStore = createExtensionStorage(EXTENSION_ID);
  return kvStore;
}

function loadConfig(): SampleConfig {
  try {
    const saved = kv().get<Partial<SampleConfig>>("config", "global");
    if (saved) return { ...DEFAULT_CONFIG, ...saved };
  } catch { /* first run */ }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(config: SampleConfig): void {
  kv().set("config", config, "global");
}

function handleSetConfig(body: Partial<SampleConfig>): { ok: true; config: SampleConfig } {
  const current = loadConfig();
  const next: SampleConfig = {
    enabled: body.enabled ?? current.enabled,
    greeting: typeof body.greeting === "string" ? body.greeting : current.greeting,
    secret_keychain: typeof body.secret_keychain === "string" ? body.secret_keychain.trim() : current.secret_keychain,
  };
  saveConfig(next);
  return { ok: true, config: next };
}

type AddonConfigApiRegistrar = (
  addonId: string,
  action: string,
  handlers: { get?: (payload: unknown, req: Request) => unknown | Promise<unknown>; set?: (payload: unknown, req: Request) => unknown | Promise<unknown> },
  extensionPath?: string,
) => "created" | "updated";

const registerAddonConfigApi = (globalThis as Record<string, unknown>).__piclaw_registerAddonConfigApi as AddonConfigApiRegistrar | undefined;
if (typeof registerAddonConfigApi === "function") {
  registerAddonConfigApi("sample-addon", "config", {
    get: async () => loadConfig(),
    set: async (payload) => handleSetConfig((payload && typeof payload === "object" ? payload : {}) as Partial<SampleConfig>),
  }, import.meta.dir);
}

// ── Extension entry point ────────────────────────────────────────

export default function sampleAddon(pi: ExtensionAPI): void {
  const config = loadConfig();

  // ── Tool: returns the greeting from config ─────────────────────

  pi.registerTool({
    name: "sample_test",
    label: "sample_test",
    description: "Returns the sample addon's configured greeting and whether a secret is present.",
    parameters: Type.Object({}),
    async execute() {
      const cfg = loadConfig();
      const hasSecret = Boolean(process.env[
        cfg.secret_keychain.replace(/[/\-.]/g, "_").toUpperCase()
      ]);
      return {
        content: [{
          type: "text",
          text: `Greeting: ${cfg.greeting}\nSecret configured: ${hasSecret ? "yes" : "no"}`,
        }],
        details: {
          enabled: cfg.enabled,
          greeting: cfg.greeting,
          hasSecret,
        },
      };
    },
  });

  // ── Prompt hint ────────────────────────────────────────────────

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n## Sample Addon\nThe sample addon is ${config.enabled ? "enabled" : "disabled"}. Use the sample_test tool to verify.`,
  }));
}

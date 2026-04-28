/**
 * sample-addon/index.ts — Starter template for piclaw add-ons.
 *
 * Demonstrates:
 *   - Reading/writing config to SQLite KV (extension_kv, global scope)
 *   - Storing a secret in the keychain via the web settings pane
 *   - Registering a tool that returns a value from config
 *   - Registering internal commands for the settings pane API
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

// ── Extension entry point ────────────────────────────────────────

export default function sampleAddon(pi: ExtensionAPI): void {
  const config = loadConfig();

  // ── Config API (used by the settings pane) ─────────────────────

  pi.registerCommand("sample-addon-config-get", {
    description: "Get sample addon config (internal)",
    handler: async () => {
      pi.sendMessage({
        customType: "sample-addon",
        content: JSON.stringify(loadConfig()),
        display: false,
      });
    },
  });

  pi.registerCommand("sample-addon-config-set", {
    description: "Set sample addon config (internal)",
    handler: async (args: string) => {
      try {
        const body = JSON.parse(args) as Partial<SampleConfig>;
        const current = loadConfig();
        const next: SampleConfig = {
          enabled: body.enabled ?? current.enabled,
          greeting: typeof body.greeting === "string" ? body.greeting : current.greeting,
          secret_keychain: typeof body.secret_keychain === "string" ? body.secret_keychain.trim() : current.secret_keychain,
        };
        saveConfig(next);
        pi.sendMessage({
          customType: "sample-addon",
          content: JSON.stringify({ ok: true, config: next }),
          display: false,
        });
      } catch (err) {
        pi.sendMessage({
          customType: "sample-addon",
          content: JSON.stringify({ ok: false, error: String(err) }),
          display: false,
        });
      }
    },
  });

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

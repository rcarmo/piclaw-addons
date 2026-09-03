import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createExtensionStorage, type ExtensionStorage } from "./compat/extension-kv.js";
import {
  CONFIG_VERSION,
  type CanonicalModelRef,
  type CheapskateConfig,
  type CheapskateConfigPatch,
} from "./shared.js";

const EXTENSION_ID = "cheapskate";
const CONFIG_KEY = "config";
const MAX_CONFIG_ENTRIES = 2_000;
let kvStore: ExtensionStorage | null = null;

export function defaultCheapskateConfig(): CheapskateConfig {
  return { version: CONFIG_VERSION, enabled: true, providers: {}, models: {}, priority: [] };
}

function storage(): ExtensionStorage {
  if (!kvStore) kvStore = createExtensionStorage(EXTENSION_ID);
  return kvStore;
}

function readBooleanRecord(value: unknown): Record<string, { enabled: boolean }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_CONFIG_ENTRIES) throw new Error("Cheapskate config has too many entries.");
  const result: Record<string, { enabled: boolean }> = {};
  for (const [rawKey, rawFields] of entries) {
    const key = rawKey.trim();
    if (!key || key.length > 300 || !rawFields || typeof rawFields !== "object" || Array.isArray(rawFields)) continue;
    const enabled = (rawFields as Record<string, unknown>).enabled;
    if (typeof enabled === "boolean") result[key] = { enabled };
  }
  return result;
}

function readPriority(value: unknown): CanonicalModelRef[] {
  if (!Array.isArray(value)) return [];
  const result: CanonicalModelRef[] = [];
  const seen = new Set<string>();
  if (value.length > MAX_CONFIG_ENTRIES) throw new Error("Cheapskate priority has too many entries.");
  for (const item of value) {
    if (typeof item !== "string") continue;
    const ref = item.trim();
    if (!ref.includes("/") || ref.length > 300 || seen.has(ref)) continue;
    seen.add(ref);
    result.push(ref as CanonicalModelRef);
  }
  return result;
}

export function normalizeCheapskateConfig(value: unknown): CheapskateConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaultCheapskateConfig();
  const record = value as Record<string, unknown>;
  const providers = readBooleanRecord(record.providers);
  const models = readBooleanRecord(record.models);

  // v1 stored provider settings under `backends`. Preserve recognised enablement
  // by provider id; stale model ids and token safety caps are deliberately not mapped.
  const legacyBackends = readBooleanRecord(record.backends);
  for (const [provider, fields] of Object.entries(legacyBackends)) {
    providers[provider] ??= fields;
  }

  return {
    version: CONFIG_VERSION,
    enabled: typeof record.enabled === "boolean" ? record.enabled : true,
    providers,
    models,
    priority: readPriority(record.priority),
  };
}

export function loadCheapskateConfig(): CheapskateConfig {
  const saved = storage().get<unknown>(CONFIG_KEY, "global");
  if (saved) {
    const normalized = normalizeCheapskateConfig(saved);
    if (JSON.stringify(saved) !== JSON.stringify(normalized)) storage().set(CONFIG_KEY, normalized, "global");
    return normalized;
  }

  const workspaceDir = process.env.PICLAW_WORKSPACE || "/workspace";
  const legacyPath = join(workspaceDir, ".pi", "cheapskate.json");
  if (existsSync(legacyPath)) {
    try {
      const normalized = normalizeCheapskateConfig(JSON.parse(readFileSync(legacyPath, "utf8")));
      storage().set(CONFIG_KEY, normalized, "global");
      return normalized;
    } catch {
      // Invalid legacy data fails closed to defaults and is not rewritten.
    }
  }
  return defaultCheapskateConfig();
}

export function saveCheapskateConfig(config: CheapskateConfig): void {
  storage().set(CONFIG_KEY, normalizeCheapskateConfig(config), "global");
}

export function applyCheapskateConfigPatch(
  current: CheapskateConfig,
  patch: CheapskateConfigPatch,
  validProviders: ReadonlySet<string>,
  validModels: ReadonlySet<CanonicalModelRef>,
): CheapskateConfig {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Cheapskate config patch must be an object.");
  const next = structuredClone(current);
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") throw new Error("enabled must be a boolean.");
    next.enabled = patch.enabled;
  }

  if (patch.providers !== undefined) {
    if (!patch.providers || typeof patch.providers !== "object" || Array.isArray(patch.providers)) throw new Error("providers must be an object.");
    for (const [provider, fields] of Object.entries(patch.providers)) {
      if (!validProviders.has(provider)) throw new Error(`Unknown zero-cost provider: ${provider}`);
      if (!fields || typeof fields !== "object" || typeof fields.enabled !== "boolean") throw new Error(`Provider ${provider} requires a boolean enabled field.`);
      next.providers[provider] = { enabled: fields.enabled };
    }
  }

  if (patch.models !== undefined) {
    if (!patch.models || typeof patch.models !== "object" || Array.isArray(patch.models)) throw new Error("models must be an object.");
    for (const [rawRef, fields] of Object.entries(patch.models)) {
      const ref = rawRef as CanonicalModelRef;
      if (!validModels.has(ref)) throw new Error(`Unknown zero-cost model: ${rawRef}`);
      if (!fields || typeof fields !== "object" || typeof fields.enabled !== "boolean") throw new Error(`Model ${rawRef} requires a boolean enabled field.`);
      next.models[ref] = { enabled: fields.enabled };
    }
  }

  if (patch.priority !== undefined) {
    if (!Array.isArray(patch.priority)) throw new Error("priority must be an array.");
    const priority = readPriority(patch.priority);
    if (priority.length !== patch.priority.length) throw new Error("priority must contain unique canonical model references.");
    for (const ref of priority) if (!validModels.has(ref)) throw new Error(`Unknown zero-cost model in priority: ${ref}`);
    next.priority = priority;
  }

  next.version = CONFIG_VERSION;
  return next;
}

export function resetCheapskateConfigForTests(): void {
  kvStore = null;
}

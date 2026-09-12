import { createExtensionStorage } from "./compat/extension-kv.js";
export interface Profile {
  id: string;
  label: string;
  origin: string;
  tokenKeychain: string;
  targetIdentity: string;
  inputEnabled: boolean;
}
export interface Config {
  profiles: Profile[];
}
export function validateConfig(value: unknown): Config {
  const list = (value as Config)?.profiles;
  if (!Array.isArray(list) || list.length > 32)
    throw new Error("Expected at most 32 profiles.");
  const ids = new Set<string>(),
    origins = new Set<string>();
  return {
    profiles: list.map((p) => {
      if (!p || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(p.id) || ids.has(p.id))
        throw new Error("Invalid or duplicate profile ID.");
      const u = new URL(p.origin);
      if (
        !["http:", "https:"].includes(u.protocol) ||
        u.username ||
        u.password ||
        u.pathname !== "/" ||
        u.search ||
        u.hash ||
        origins.has(u.origin)
      )
        throw new Error(
          "Use a unique HTTP(S) origin without credentials, path or query.",
        );
      for (const k of ["label", "tokenKeychain", "targetIdentity"] as const)
        if (
          typeof p[k] !== "string" ||
          !p[k].trim() ||
          p[k].length > 200 ||
          /[\r\n\0]/.test(p[k])
        )
          throw new Error(`Invalid ${k}.`);
      if (typeof p.inputEnabled !== "boolean")
        throw new Error("inputEnabled must be boolean.");
      ids.add(p.id);
      origins.add(u.origin);
      return {
        id: p.id,
        label: p.label.trim(),
        origin: u.origin,
        tokenKeychain: p.tokenKeychain.trim(),
        targetIdentity: p.targetIdentity.trim(),
        inputEnabled: p.inputEnabled,
      };
    }),
  };
}
let store: ReturnType<typeof createExtensionStorage> | undefined;
function storage() {
  return (store ??= createExtensionStorage("linkr"));
}
export function loadConfig(): Config {
  const c = storage().get<Config>("config", "global");
  return c ? validateConfig(c) : { profiles: [] };
}
export function saveConfig(value: unknown) {
  const c = validateConfig(value);
  storage().set("config", c, "global");
  return c;
}
export function selectProfile(id: string, chat: string) {
  if (!loadConfig().profiles.some((p) => p.id === id))
    throw new Error("Unknown profile.");
  storage().set("selected", id, "chat", chat);
}
export function getProfile(id: string | undefined, chat: string): Profile {
  const selected = id || storage().get<string>("selected", "chat", chat);
  const p = loadConfig().profiles.find((p) => p.id === selected);
  if (!p)
    throw new Error(
      "Select an explicit configured device_id (Settings → Linkr).",
    );
  return p;
}
export function registerConfigApi() {
  const register = (globalThis as any).__piclaw_registerAddonConfigApi;
  register?.(
    "linkr",
    "config",
    {
      get: () => loadConfig(),
      set: (value: unknown) => ({ ok: true, config: saveConfig(value) }),
    },
    import.meta.dir,
  );
}

/**
 * runtime.ts — Startup runtime entry for the Telegram channel.
 *
 * Piclaw loads this once at process start, independently of agent sessions.
 * It registers the Settings config API and restores polling from saved
 * settings. Missing configuration leaves the channel inactive; it never throws.
 */
import { ADDON_ID, getTelegramService, type SettingsContext } from "./service.js";

type LocalContext = SettingsContext;

type AddonConfigApiRegistrar = (
  addonId: string,
  action: string,
  handlers: {
    get?: (payload: unknown, req: Request, context?: LocalContext | null) => unknown | Promise<unknown>;
    set?: (payload: unknown, req: Request, context?: LocalContext | null) => unknown | Promise<unknown>;
  },
  extensionPath?: string,
) => "created" | "updated";

// Browser localContext is request-scoped, not an unattended ingress capability.
const service = getTelegramService({ ingress: null });

/** Dedicated web chats offered in the Settings picker, when the host provides them. */
async function listTargets(context?: LocalContext | null) {
  try {
    const targets = (await context?.listTargets?.()) ?? [];
    return targets
      .filter((target) => typeof target.chatJid === "string" && target.chatJid.startsWith("web:") && target.chatJid !== "web:default" && typeof target.incarnation === "string" && target.incarnation !== "")
      .map((target) => ({ chatJid: target.chatJid as string, incarnation: target.incarnation, label: typeof target.label === "string" ? target.label : target.chatJid as string }));
  } catch { return []; }
}

const registerAddonConfigApi = (globalThis as Record<string, unknown>).__piclaw_registerAddonConfigApi as AddonConfigApiRegistrar | undefined;
if (typeof registerAddonConfigApi === "function") {
  registerAddonConfigApi(ADDON_ID, "config", {
    get: async (_payload, _req, context) => ({ ...(await service.view()), targets: await listTargets(context) }),
    set: async (payload, _req, context) => {
      await service.saveSettings(payload, context);
      return { ok: true, ...(await service.view()), targets: await listTargets(context) };
    },
  }, import.meta.dir);
}

await service.start();

export {};

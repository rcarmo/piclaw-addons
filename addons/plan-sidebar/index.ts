import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { basename } from "node:path";
import { Type } from "@sinclair/typebox";
import { createExtensionStorage, type ExtensionStorage } from "./compat/extension-kv.js";
import { getChatJid } from "./compat/chat-context.js";

const EXTENSION_ID = "plan-sidebar";
const PLAN_KEY = "plan";

export interface SessionPlan {
  chat_jid: string;
  markdown: string;
  updated_at: string | null;
}

const DEFAULT_PLAN = [
  "- [ ] Clarify the current objective",
  "- [ ] Do the next concrete step",
  "- [ ] Verify the result",
  "- [ ] Report progress and next step",
].join("\n");

let kvStore: ExtensionStorage | null = null;
function kv(): ExtensionStorage {
  if (!kvStore) kvStore = createExtensionStorage(EXTENSION_ID);
  return kvStore;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizePlanMarkdown(value: unknown): string {
  return typeof value === "string" ? value.replace(/\r\n/g, "\n") : "";
}

export function normalizeChatJid(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || getChatJid("web:default");
}

type PlanRuntimeContext = Pick<ExtensionContext, "sessionManager"> | Pick<ExtensionCommandContext, "sessionManager"> | undefined;

function unsanitizeWebChatJidFromSessionDir(sessionDir: unknown): string | null {
  const leaf = typeof sessionDir === "string" ? basename(sessionDir).trim() : "";
  if (!leaf || leaf.includes("__")) return null;
  if (leaf === "web_default") return "web:default";
  if (leaf.startsWith("web_")) return `web:${leaf.slice("web_".length)}`;
  return null;
}

function chatJidFromContext(ctx: PlanRuntimeContext): string | null {
  try {
    return unsanitizeWebChatJidFromSessionDir(ctx?.sessionManager?.getSessionDir?.());
  } catch {
    return null;
  }
}

export function resolveActiveChatJid(ctx?: PlanRuntimeContext, defaultValue = "web:default"): string {
  const ambient = getChatJid("");
  const fromContext = chatJidFromContext(ctx);
  if (fromContext && (!ambient || ambient === defaultValue)) return fromContext;
  return normalizeChatJid(ambient || fromContext || defaultValue);
}

export function loadSessionPlan(chatJidInput?: unknown): SessionPlan {
  const chat_jid = normalizeChatJid(chatJidInput);
  const saved = kv().get<Partial<SessionPlan>>(PLAN_KEY, "chat", chat_jid);
  return {
    chat_jid,
    markdown: normalizePlanMarkdown(saved?.markdown || DEFAULT_PLAN),
    updated_at: typeof saved?.updated_at === "string" && saved.updated_at.trim() ? saved.updated_at : null,
  };
}

export function saveSessionPlan(chatJidInput: unknown, markdownInput: unknown): SessionPlan {
  const chat_jid = normalizeChatJid(chatJidInput);
  const next: SessionPlan = {
    chat_jid,
    markdown: normalizePlanMarkdown(markdownInput),
    updated_at: nowIso(),
  };
  kv().set(PLAN_KEY, next, "chat", chat_jid);
  return next;
}

function readChatJidFromRequest(req: Request, payload?: Record<string, unknown>): string {
  try {
    const url = new URL(req.url, "https://example.test/");
    const queryValue = url.searchParams.get("chat_jid");
    if (typeof queryValue === "string" && queryValue.trim()) return normalizeChatJid(queryValue);
  } catch {
    // ignore and fall back
  }
  return normalizeChatJid(payload?.chat_jid);
}

type AddonConfigApiRegistrar = (
  addonId: string,
  action: string,
  handlers: {
    get?: (payload: unknown, req: Request) => unknown | Promise<unknown>;
    set?: (payload: unknown, req: Request) => unknown | Promise<unknown>;
  },
  extensionPath?: string,
) => "created" | "updated";

const registerAddonConfigApi = (globalThis as Record<string, unknown>).__piclaw_registerAddonConfigApi as AddonConfigApiRegistrar | undefined;
if (typeof registerAddonConfigApi === "function") {
  registerAddonConfigApi("plan-sidebar", "plan", {
    get: async (payload, req) => {
      const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : undefined;
      return loadSessionPlan(readChatJidFromRequest(req, body));
    },
    set: async (payload, req) => {
      const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
      const chatJid = readChatJidFromRequest(req, body);
      return { ok: true, plan: saveSessionPlan(chatJid, body.markdown) };
    },
  }, import.meta.dir);
}

const PlanToolSchema = Type.Object({
  action: Type.Union([
    Type.Literal("get"),
    Type.Literal("set"),
  ], { description: "Use get to read the active session plan, set to replace it." }),
  markdown: Type.Optional(Type.String({ description: "Markdown checklist to save when action is set." })),
  chat_jid: Type.Optional(Type.String({ description: "Optional explicit chat/session JID. Defaults to the active session." })),
});

export function resetPlanSidebarAddonForTests(): void {
  kvStore = null;
}

export default function planSidebarAddon(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "plan",
    label: "plan",
    description: "Get or set the current session's Markdown checklist plan shown in the right-side Plan sidebar.",
    promptSnippet: "plan: use action=get to inspect the current session checklist, action=set to update it after planning or progress changes.",
    parameters: PlanToolSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const chatJid = normalizeChatJid(params.chat_jid || resolveActiveChatJid(ctx));
      if (params.action === "get") {
        const plan = loadSessionPlan(chatJid);
        return {
          content: [{ type: "text", text: `Plan for ${plan.chat_jid}:\n\n${plan.markdown || "(empty)"}` }],
          details: plan,
        };
      }

      if (typeof params.markdown !== "string") {
        throw new Error("plan action=set requires a markdown string.");
      }
      const plan = saveSessionPlan(chatJid, params.markdown);
      return {
        content: [{ type: "text", text: `Updated plan for ${plan.chat_jid}.` }],
        details: plan,
      };
    },
  });
}

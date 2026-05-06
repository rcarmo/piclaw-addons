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

type PlanUpdateSource = "api" | "tool";
type PlanUpdateAction = "write" | "edit";
type PiclawBroadcastEvent = (type: string, data: unknown) => void;

const DEFAULT_PLAN = [
  "- [ ] Update this plan thoroughly with ongoing work",
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

export interface PlanEditBlock {
  oldText: string;
  newText: string;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (true) {
    const found = haystack.indexOf(needle, index);
    if (found < 0) return count;
    count += 1;
    index = found + needle.length;
  }
}

export function applyPlanEdits(markdownInput: unknown, editsInput: unknown): string {
  const markdown = normalizePlanMarkdown(markdownInput);
  const edits = Array.isArray(editsInput) ? editsInput : [];
  if (!edits.length) throw new Error("plan action=edit requires at least one edit block.");

  const ranges: Array<{ from: number; to: number; oldText: string; newText: string }> = [];
  for (const raw of edits) {
    const edit = raw && typeof raw === "object" ? raw as Partial<PlanEditBlock> : {};
    if (typeof edit.oldText !== "string" || !edit.oldText) throw new Error("Each plan edit needs non-empty oldText.");
    if (typeof edit.newText !== "string") throw new Error("Each plan edit needs newText.");
    const occurrences = countOccurrences(markdown, edit.oldText);
    if (occurrences !== 1) throw new Error(`Plan edit oldText must match exactly once; got ${occurrences} matches for ${JSON.stringify(edit.oldText)}.`);
    const from = markdown.indexOf(edit.oldText);
    ranges.push({ from, to: from + edit.oldText.length, oldText: edit.oldText, newText: edit.newText });
  }

  ranges.sort((a, b) => a.from - b.from);
  for (let i = 1; i < ranges.length; i += 1) {
    if (ranges[i].from < ranges[i - 1].to) throw new Error("Plan edit blocks must not overlap.");
  }

  let next = "";
  let cursor = 0;
  for (const range of ranges) {
    next += markdown.slice(cursor, range.from) + range.newText;
    cursor = range.to;
  }
  return next + markdown.slice(cursor);
}

export function editSessionPlan(chatJidInput: unknown, editsInput: unknown): SessionPlan {
  const current = loadSessionPlan(chatJidInput);
  return saveSessionPlan(current.chat_jid, applyPlanEdits(current.markdown, editsInput));
}

function getBroadcastEvent(): PiclawBroadcastEvent | null {
  const candidate = (globalThis as Record<string, unknown>).__PICLAW_BROADCAST_EVENT__;
  return typeof candidate === "function" ? candidate as PiclawBroadcastEvent : null;
}

function broadcastPlanUpdated(plan: SessionPlan, source: PlanUpdateSource, action: PlanUpdateAction): void {
  try {
    getBroadcastEvent()?.("extension_ui_status", {
      key: "plan-sidebar.plan-updated",
      chat_jid: plan.chat_jid,
      updated_at: plan.updated_at,
      source,
      action,
    });
  } catch {
    // Live sidebar refresh is best-effort; saved plan data remains authoritative.
  }
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
      const plan = saveSessionPlan(chatJid, body.markdown);
      broadcastPlanUpdated(plan, "api", "write");
      return { ok: true, plan };
    },
  }, import.meta.dir);
}

const PlanToolSchema = Type.Object({
  action: Type.Union([
    Type.Literal("read"),
    Type.Literal("write"),
    Type.Literal("edit"),
  ], { description: "Use read to inspect the active session plan, write to replace it, edit for exact atomic text replacements." }),
  markdown: Type.Optional(Type.String({ description: "Complete Markdown checklist to save when action is write." })),
  edits: Type.Optional(Type.Array(Type.Object({
    oldText: Type.String({ description: "Exact text to replace. Must occur exactly once in the current plan." }),
    newText: Type.String({ description: "Replacement text." }),
  }), { description: "Atomic exact replacements to apply when action is edit. Use whole checklist item lines for item-level updates." })),
  chat_jid: Type.Optional(Type.String({ description: "Optional explicit chat/session JID. Defaults to the active session." })),
});

export function buildPlanSystemPrompt(plan: SessionPlan): string {
  const markdown = normalizePlanMarkdown(plan.markdown).trim();
  if (!markdown) return "";
  return [
    "## Plan Sidebar",
    `The current session has a Plan sidebar checklist for ${plan.chat_jid}.`,
    "This checklist is editable shared state, not static context: you can modify it and must keep it current as work proceeds.",
    "Use the `plan` tool with `action=read` to inspect it, `action=edit` for atomic exact item/text replacements, and `action=write` only when replacing the whole checklist.",
    "Treat checked items as completed, unchecked items as pending, and update the plan after meaningful progress or plan changes.",
    "",
    "Current plan:",
    "```markdown",
    markdown,
    "```",
  ].join("\n");
}

export function resetPlanSidebarAddonForTests(): void {
  kvStore = null;
}

export default function planSidebarAddon(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event, ctx) => {
    const chatJid = resolveActiveChatJid(ctx);
    const plan = loadSessionPlan(chatJid);
    if (!plan.updated_at && plan.markdown === DEFAULT_PLAN) return {};
    const prompt = buildPlanSystemPrompt(plan);
    if (!prompt) return {};
    return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
  });

  pi.registerTool({
    name: "plan",
    label: "plan",
    description: "Read or edit the current session's editable Markdown checklist plan shown in the right-side Plan sidebar. Prefer atomic edit blocks for item updates; keep the plan current as tasks change or complete.",
    promptSnippet: "plan: editable session checklist. Use action=read to inspect it, action=edit with exact oldText/newText blocks for atomic item updates, and action=write only to replace the whole checklist.",
    parameters: PlanToolSchema,
    prepareArguments(args) {
      if (!args || typeof args !== "object") return args;
      const input = args as { action?: unknown; markdown?: unknown; oldText?: unknown; newText?: unknown; edits?: unknown };
      if (input.action === "get") return { ...input, action: "read" };
      if (input.action === "set") return { ...input, action: "write" };
      if (input.action === "edit" && !Array.isArray(input.edits) && typeof input.oldText === "string" && typeof input.newText === "string") {
        return { ...input, edits: [{ oldText: input.oldText, newText: input.newText }] };
      }
      return args;
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const chatJid = normalizeChatJid(params.chat_jid || resolveActiveChatJid(ctx));
      if (params.action === "read") {
        const plan = loadSessionPlan(chatJid);
        return {
          content: [{ type: "text", text: `Plan for ${plan.chat_jid}:\n\n${plan.markdown || "(empty)"}` }],
          details: plan,
        };
      }

      if (params.action === "edit") {
        const plan = editSessionPlan(chatJid, params.edits);
        broadcastPlanUpdated(plan, "tool", "edit");
        return {
          content: [{ type: "text", text: `Edited plan for ${plan.chat_jid}.` }],
          details: plan,
        };
      }

      if (typeof params.markdown !== "string") {
        throw new Error("plan action=write requires a markdown string.");
      }
      const plan = saveSessionPlan(chatJid, params.markdown);
      broadcastPlanUpdated(plan, "tool", "write");
      return {
        content: [{ type: "text", text: `Updated plan for ${plan.chat_jid}.` }],
        details: plan,
      };
    },
  });
}

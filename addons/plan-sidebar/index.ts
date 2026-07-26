import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { Type } from "@sinclair/typebox";
import { createExtensionStorage, type ExtensionStorage } from "./compat/extension-kv.js";
import { getChatJid } from "./compat/chat-context.js";

const EXTENSION_ID = "plan-sidebar";
const PLAN_KEY = "plan";
const UI_PLAN_CHANGED_KEY = "plan.changes";

export interface SessionPlan {
  chat_jid: string;
  markdown: string;
  updated_at: string | null;
}

export type PlanItemStatus = "pending" | "in_progress" | "completed";

export interface UpdatePlanItem {
  step: string;
  status: PlanItemStatus;
}

export interface UpdatePlanArgs {
  explanation?: string;
  plan: UpdatePlanItem[];
}

export interface StructuredSessionPlan extends SessionPlan {
  explanation: string | null;
  plan: UpdatePlanItem[];
}

type PlanUpdateSource = "api" | "tool";
type PlanUpdateAction = "write" | "edit" | "patch" | "update" | "reset";
type PiclawBroadcastEvent = (type: string, data: unknown) => void;

const DEFAULT_PLAN = [
  "- [ ] Update this plan thoroughly with ongoing work",
  "- [ ] Clarify the current objective",
  "- [ ] Do the next concrete step",
  "- [ ] Verify the result",
  "- [ ] Report progress and next step",
].join("\n");

const CHECKLIST_LINE_RE = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX-])\](\s*)(.*)$/;

let kvStore: ExtensionStorage | null = null;
function kv(): ExtensionStorage {
  if (!kvStore) kvStore = createExtensionStorage(EXTENSION_ID);
  return kvStore;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeLineEndings(value: unknown): string {
  return typeof value === "string" ? value.replace(/\r\n/g, "\n") : "";
}

function normalizeText(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
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

function statusFromMarkdownMarker(marker: string): PlanItemStatus {
  if (marker.toLowerCase() === "x") return "completed";
  if (marker === "-") return "in_progress";
  return "pending";
}

function markerForStatus(status: PlanItemStatus): string {
  switch (status) {
    case "completed": return "x";
    case "in_progress": return "-";
    case "pending": return " ";
  }
}

function normalizePlanStep(value: unknown): string {
  return normalizeText(value).replace(/\s+/g, " ");
}

function normalizePlanStatus(value: unknown): PlanItemStatus {
  if (value === "pending" || value === "in_progress" || value === "completed") return value;
  throw new Error("Invalid plan status " + JSON.stringify(value) + "; expected pending, in_progress, or completed.");
}

export function normalizeUpdatePlanArgs(input: unknown): UpdatePlanArgs {
  const raw = input && typeof input === "object" ? input as { explanation?: unknown; plan?: unknown } : {};
  if (!Array.isArray(raw.plan)) throw new Error("plan action=update requires a plan array.");
  let inProgressCount = 0;
  const plan = raw.plan.map((item, index): UpdatePlanItem => {
    const entry = item && typeof item === "object" ? item as { step?: unknown; status?: unknown } : {};
    const step = normalizePlanStep(entry.step);
    if (!step) throw new Error("plan update item " + (index + 1) + " requires a non-empty step.");
    const status = normalizePlanStatus(entry.status);
    if (status === "in_progress") inProgressCount += 1;
    return { step, status };
  });
  if (inProgressCount > 1) throw new Error("plan update accepts at most one in_progress step.");
  const explanation = normalizeText(raw.explanation);
  return explanation ? { explanation, plan } : { plan };
}

export function parsePlanMarkdown(markdownInput: unknown): { explanation: string | null; plan: UpdatePlanItem[]; inProgressCount: number } {
  const lines = normalizeLineEndings(markdownInput).split("\n");
  const explanationLines: string[] = [];
  const plan: UpdatePlanItem[] = [];
  let inProgressCount = 0;
  let sawTask = false;
  for (const line of lines) {
    const match = line.match(CHECKLIST_LINE_RE);
    if (match) {
      sawTask = true;
      const status = statusFromMarkdownMarker(match[2]);
      if (status === "in_progress") inProgressCount += 1;
      plan.push({ step: normalizePlanStep(match[4]), status });
      continue;
    }
    if (!sawTask && line.trim().startsWith(">")) {
      explanationLines.push(line.trim().replace(/^>\s?/, ""));
    }
  }
  const explanation = explanationLines.join("\n").trim() || null;
  return { explanation, plan, inProgressCount };
}

export function normalizeStoredPlanMarkdown(markdownInput: unknown): string {
  const lines = normalizeLineEndings(markdownInput).split("\n");
  let inProgressCount = 0;
  const next = lines.map((line) => {
    const match = line.match(CHECKLIST_LINE_RE);
    if (!match) return line;
    const [, prefix, marker, spacing, text] = match;
    const status = statusFromMarkdownMarker(marker);
    if (status === "in_progress") inProgressCount += 1;
    return `${prefix}[${markerForStatus(status)}]${spacing || " "}${text}`;
  }).join("\n");
  if (inProgressCount > 1) throw new Error("Plan Markdown can contain at most one in-progress checklist item (`[-]`).");
  return next;
}

function quoteMarkdownNote(note: string): string[] {
  return normalizeLineEndings(note)
    .split("\n")
    .map((line) => (`> ${line.trim()}`).trimEnd());
}

export function updatePlanArgsToMarkdown(input: unknown): string {
  const args = normalizeUpdatePlanArgs(input);
  const lines: string[] = [];
  if (args.explanation) lines.push(...quoteMarkdownNote(args.explanation), "");
  for (const item of args.plan) lines.push(`- [${markerForStatus(item.status)}] ${item.step}`);
  return lines.join("\n").trimEnd();
}

function structuredPlanDetails(plan: SessionPlan): StructuredSessionPlan {
  const parsed = parsePlanMarkdown(plan.markdown);
  return { ...plan, explanation: parsed.explanation, plan: parsed.plan };
}

export interface PlanSidebarRuntimeApi {
  getPlan(chatJidInput?: unknown): StructuredSessionPlan;
}

export function getStructuredSessionPlan(chatJidInput?: unknown): StructuredSessionPlan {
  return structuredPlanDetails(loadSessionPlan(chatJidInput));
}

const planSidebarRuntimeApi: PlanSidebarRuntimeApi = {
  getPlan: getStructuredSessionPlan,
};

(globalThis as Record<string, unknown>).__piclaw_planSidebarApi = planSidebarRuntimeApi;

export function loadSessionPlan(chatJidInput?: unknown): SessionPlan {
  const chat_jid = normalizeChatJid(chatJidInput);
  const saved = kv().get<Partial<SessionPlan>>(PLAN_KEY, "chat", chat_jid);
  const rawMarkdown = normalizeLineEndings(saved?.markdown || DEFAULT_PLAN);
  let markdown = rawMarkdown;
  try {
    markdown = normalizeStoredPlanMarkdown(rawMarkdown);
  } catch {
    // Existing user-authored Markdown is still readable even if it needs cleanup before mutation.
  }
  return {
    chat_jid,
    markdown,
    updated_at: typeof saved?.updated_at === "string" && saved.updated_at.trim() ? saved.updated_at : null,
  };
}

export function saveSessionPlan(chatJidInput: unknown, markdownInput: unknown): SessionPlan {
  const chat_jid = normalizeChatJid(chatJidInput);
  const next: SessionPlan = {
    chat_jid,
    markdown: normalizeStoredPlanMarkdown(markdownInput),
    updated_at: nowIso(),
  };
  kv().set(PLAN_KEY, next, "chat", chat_jid);
  return next;
}

export type PlanEditOperation = "replace" | "delete" | "insert_after" | "insert_before" | "append" | "prepend";

export interface PlanEditBlock {
  operation?: PlanEditOperation;
  oldText?: string;
  newText?: string;
  anchorText?: string;
  text?: string;
}

export type PlanPatchOperation = "add" | "update" | "remove";
export type PlanPatchPosition = "start" | "end";

export interface PlanPatchBlock {
  operation: PlanPatchOperation;
  index?: number;
  match?: string;
  step?: string;
  status?: PlanItemStatus;
  position?: PlanPatchPosition;
  before?: string;
  after?: string;
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

function normalizePlanEditOperation(edit: Partial<PlanEditBlock>): PlanEditOperation {
  const operation = edit.operation;
  if (operation === "replace" || operation === "delete" || operation === "insert_after" || operation === "insert_before" || operation === "append" || operation === "prepend") return operation;
  if (typeof edit.oldText === "string" && typeof edit.newText === "string") return "replace";
  throw new Error("Each plan edit needs operation replace, delete, insert_after, insert_before, append, or prepend.");
}

function requireEditText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Each plan edit ${field} must be a string.`);
  if (!value && field !== "newText") throw new Error(`Each plan edit ${field} must not be empty.`);
  return value;
}

function findUniqueAnchor(markdown: string, anchor: string, label = "anchorText"): { from: number; to: number } {
  const occurrences = countOccurrences(markdown, anchor);
  if (occurrences !== 1) throw new Error(`Plan edit ${label} must match exactly once; got ${occurrences} matches for ${JSON.stringify(anchor)}.`);
  const from = markdown.indexOf(anchor);
  return { from, to: from + anchor.length };
}

export function applyPlanEdits(markdownInput: unknown, editsInput: unknown): string {
  const markdown = normalizeLineEndings(markdownInput);
  const edits = Array.isArray(editsInput) ? editsInput : [];
  if (!edits.length) throw new Error("plan action=edit requires at least one edit block.");

  const ranges: Array<{ from: number; to: number; newText: string; order: number }> = [];
  edits.forEach((raw, order) => {
    const edit = raw && typeof raw === "object" ? raw as Partial<PlanEditBlock> : {};
    const operation = normalizePlanEditOperation(edit);

    if (operation === "append") {
      ranges.push({ from: markdown.length, to: markdown.length, newText: requireEditText(edit.text ?? edit.newText, "text"), order });
      return;
    }
    if (operation === "prepend") {
      ranges.push({ from: 0, to: 0, newText: requireEditText(edit.text ?? edit.newText, "text"), order });
      return;
    }

    const anchor = requireEditText(edit.anchorText ?? edit.oldText, operation === "replace" || operation === "delete" ? "oldText" : "anchorText");
    const range = findUniqueAnchor(markdown, anchor, operation === "replace" || operation === "delete" ? "oldText" : "anchorText");
    if (operation === "replace") ranges.push({ ...range, newText: requireEditText(edit.newText, "newText"), order });
    else if (operation === "delete") ranges.push({ ...range, newText: "", order });
    else if (operation === "insert_before") ranges.push({ from: range.from, to: range.from, newText: requireEditText(edit.text ?? edit.newText, "text"), order });
    else ranges.push({ from: range.to, to: range.to, newText: requireEditText(edit.text ?? edit.newText, "text"), order });
  });

  ranges.sort((a, b) => a.from - b.from || a.order - b.order);
  for (let i = 1; i < ranges.length; i += 1) {
    if (ranges[i].from < ranges[i - 1].to) throw new Error("Plan edit blocks must not overlap.");
  }

  let next = "";
  let cursor = 0;
  for (const range of ranges) {
    next += markdown.slice(cursor, range.from) + range.newText;
    cursor = range.to;
  }
  return normalizeStoredPlanMarkdown(next + markdown.slice(cursor));
}

export function editSessionPlan(chatJidInput: unknown, editsInput: unknown): SessionPlan {
  const current = loadSessionPlan(chatJidInput);
  return saveSessionPlan(current.chat_jid, applyPlanEdits(current.markdown, editsInput));
}

function normalizePatchOperation(value: unknown): PlanPatchOperation {
  if (value === "add" || value === "update" || value === "remove") return value;
  throw new Error("Each plan patch needs operation add, update, or remove.");
}

function normalizePatchPosition(value: unknown): PlanPatchPosition | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "start" || value === "end") return value;
  throw new Error("Plan patch position must be start or end.");
}

function planPatchTargetIndex(items: UpdatePlanItem[], patch: Partial<PlanPatchBlock>, label = "patch"): number {
  if (typeof patch.index === "number" && Number.isInteger(patch.index)) {
    const index = patch.index - 1;
    if (index < 0 || index >= items.length) throw new Error(`Plan ${label} index ${patch.index} is out of range.`);
    return index;
  }
  const match = normalizePlanStep(patch.match);
  if (!match) throw new Error(`Plan ${label} needs index or match.`);
  const matches = items
    .map((item, index) => ({ index, item }))
    .filter(({ item }) => item.step === match || item.step.includes(match));
  if (matches.length !== 1) throw new Error(`Plan ${label} match must identify exactly one item; got ${matches.length} matches for ${JSON.stringify(match)}.`);
  return matches[0].index;
}

function planPatchInsertIndex(items: UpdatePlanItem[], patch: Partial<PlanPatchBlock>): number {
  const position = normalizePatchPosition(patch.position);
  if (position === "start") return 0;
  if (position === "end") return items.length;
  const before = normalizePlanStep(patch.before);
  if (before) return planPatchTargetIndex(items, { match: before }, "patch before") ;
  const after = normalizePlanStep(patch.after);
  if (after) return planPatchTargetIndex(items, { match: after }, "patch after") + 1;
  return items.length;
}

export function applyPlanPatches(markdownInput: unknown, patchesInput: unknown): string {
  const patches = Array.isArray(patchesInput) ? patchesInput : [];
  if (!patches.length) throw new Error("plan action=patch requires at least one patch block.");
  const parsed = parsePlanMarkdown(markdownInput);
  const items = parsed.plan.map((item) => ({ ...item }));

  patches.forEach((raw, order) => {
    const patch = raw && typeof raw === "object" ? raw as Partial<PlanPatchBlock> : {};
    const operation = normalizePatchOperation(patch.operation);
    if (operation === "add") {
      const step = normalizePlanStep(patch.step);
      if (!step) throw new Error(`Plan patch ${order + 1} add requires step.`);
      const status = patch.status === undefined ? "pending" : normalizePlanStatus(patch.status);
      items.splice(planPatchInsertIndex(items, patch), 0, { step, status });
      return;
    }
    const index = planPatchTargetIndex(items, patch, `patch ${order + 1}`);
    if (operation === "remove") {
      items.splice(index, 1);
      return;
    }
    const nextStep = patch.step === undefined ? items[index].step : normalizePlanStep(patch.step);
    if (!nextStep) throw new Error(`Plan patch ${order + 1} update step must not be empty.`);
    const nextStatus = patch.status === undefined ? items[index].status : normalizePlanStatus(patch.status);
    items[index] = { step: nextStep, status: nextStatus };
  });

  return updatePlanArgsToMarkdown({ explanation: parsed.explanation || undefined, plan: items });
}

export function patchSessionPlan(chatJidInput: unknown, patchesInput: unknown): SessionPlan {
  const current = loadSessionPlan(chatJidInput);
  return saveSessionPlan(current.chat_jid, applyPlanPatches(current.markdown, patchesInput));
}

export function resetSessionPlan(chatJidInput: unknown): SessionPlan {
  return saveSessionPlan(chatJidInput, DEFAULT_PLAN);
}

function getBroadcastEvent(): PiclawBroadcastEvent | null {
  const candidate = (globalThis as Record<string, unknown>).__PICLAW_BROADCAST_EVENT__;
  return typeof candidate === "function" ? candidate as PiclawBroadcastEvent : null;
}

function broadcastPlanUpdated(plan: SessionPlan, source: PlanUpdateSource, action: PlanUpdateAction): void {
  try {
    getBroadcastEvent()?.("extension_ui_status", {
      key: UI_PLAN_CHANGED_KEY,
      addon: EXTENSION_ID,
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
      return getStructuredSessionPlan(readChatJidFromRequest(req, body));
    },
    set: async (payload, req) => {
      const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
      const chatJid = readChatJidFromRequest(req, body);
      const isReset = body.action === "reset";
      const plan = isReset ? resetSessionPlan(chatJid) : saveSessionPlan(chatJid, body.markdown);
      broadcastPlanUpdated(plan, "api", isReset ? "reset" : "write");
      return { ok: true, plan: structuredPlanDetails(plan) };
    },
  }, import.meta.dir);
}

const PlanToolSchema = Type.Object({
  action: Type.String({
    enum: ["read", "write", "edit", "patch", "update"],
    description: "Use read to inspect the active session plan, patch for easy multi-item add/update/remove operations, update for structured full-plan updates, write for full Markdown replacement, or edit for exact atomic text replacements.",
  }),
  explanation: Type.Optional(Type.String({ description: "Optional concise explanation for action=update." })),
  plan: Type.Optional(Type.Array(Type.Object({
    step: Type.String({ description: "A concrete plan step for action=update." }),
    status: Type.String({
      enum: ["pending", "in_progress", "completed"],
      description: "One of: pending, in_progress, completed.",
    }),
  }), { description: "The full current structured plan for action=update. At most one step may be in_progress." })),
  markdown: Type.Optional(Type.String({ description: "Complete Markdown checklist to save when action is write." })),
  edits: Type.Optional(Type.Array(Type.Object({
    operation: Type.Optional(Type.String({
      enum: ["replace", "delete", "insert_after", "insert_before", "append", "prepend"],
      description: "Edit operation. Defaults to replace when oldText and newText are provided.",
    })),
    oldText: Type.Optional(Type.String({ description: "Legacy/exact text to replace or delete. Must occur exactly once for replace/delete." })),
    newText: Type.Optional(Type.String({ description: "Replacement text for replace, or alias for text on insert/append/prepend." })),
    anchorText: Type.Optional(Type.String({ description: "Exact anchor text for insert_after or insert_before. Must occur exactly once." })),
    text: Type.Optional(Type.String({ description: "Text to insert for insert_after, insert_before, append, or prepend." })),
  }), { description: "Batch edits to apply when action is edit. Supports replace/delete/insert_after/insert_before/append/prepend; multiple checklist items and multi-line text are allowed in one call." })),
  patches: Type.Optional(Type.Array(Type.Object({
    operation: Type.String({
      enum: ["add", "update", "remove"],
      description: "Patch operation for action=patch. Use add/update/remove to change multiple plan items without exact Markdown line edits.",
    }),
    index: Type.Optional(Type.Number({ description: "Optional 1-based checklist item index for update/remove." })),
    match: Type.Optional(Type.String({ description: "Optional unique exact-or-substring match against an existing step for update/remove." })),
    step: Type.Optional(Type.String({ description: "New step text for add, or replacement step text for update." })),
    status: Type.Optional(Type.String({
      enum: ["pending", "in_progress", "completed"],
      description: "Optional item status. Defaults to pending for add and current status for update.",
    })),
    position: Type.Optional(Type.String({
      enum: ["start", "end"],
      description: "Optional add position. Defaults to end.",
    })),
    before: Type.Optional(Type.String({ description: "For add, insert before the unique step matching this text." })),
    after: Type.Optional(Type.String({ description: "For add, insert after the unique step matching this text." })),
  }), { description: "Structured item patches for action=patch. Allows multiple add/update/remove operations in one call using indexes or step matches; normalized like all plan writes." })),
  chat_jid: Type.Optional(Type.String({ description: "Optional explicit chat/session JID. Defaults to the active session." })),
});

export function buildPlanSystemPrompt(plan: SessionPlan): string {
  const markdown = normalizeLineEndings(plan.markdown).trim();
  if (!markdown) return "";
  return [
    "## Plan Sidebar",
    `The current session has a Plan sidebar checklist for ${plan.chat_jid}.`,
    "This checklist is editable shared state, not static context: you can modify it and must keep it current as work proceeds.",
    "Use the `plan` tool with `action=patch` for easy multi-item changes: pass `patches: [{ operation: 'add'|'update'|'remove', index?, match?, step?, status?, before?, after?, position? }]` to add, edit, reorder-by-insertion, or remove several checklist items in one call without exact Markdown line edits.",
    "Use `action=update` for structured full-plan replacement: pass `plan: [{ step, status }]` with status `pending`, `in_progress`, or `completed`; at most one step may be `in_progress`.",
    "Use `action=read` to inspect raw Markdown, `action=edit` for batch exact Markdown edits (replace/delete/insert_after/insert_before/append/prepend, including multi-line checklist blocks), and `action=write` only when replacing the whole Markdown checklist.",
    "All plan mutations are normalized into the same Markdown storage. Treat `[x]` items as completed, `[-]` items as in progress, unchecked items as pending, and update the plan after meaningful progress or plan changes.",
    "There may be at most one `[-]` / `in_progress` item.",
    "Read the current checklist with `plan` action=read when its exact state is needed; mutable checklist content is kept out of the system prompt to preserve provider prompt-cache reuse.",
  ].join("\n");
}

export function buildPlanTurnMessage(plan: SessionPlan): { customType: string; content: Array<{ type: "text"; text: string }>; display: boolean } | undefined {
  const markdown = normalizeLineEndings(plan.markdown).trim();
  if (!markdown) return undefined;
  return {
    customType: "plan_sidebar_context",
    content: [{ type: "text", text: `Current Plan Sidebar checklist for ${plan.chat_jid}:\n\n${markdown}` }],
    display: false,
  };
}

export function resetPlanSidebarAddonForTests(): void {
  try { kv().clear(); } catch { /* ignore cleanup failures */ }
  kvStore = null;
}

export default function planSidebarAddon(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event, ctx) => {
    const chatJid = resolveActiveChatJid(ctx);
    const plan = loadSessionPlan(chatJid);
    if (!plan.updated_at && plan.markdown === DEFAULT_PLAN) return {};
    const prompt = buildPlanSystemPrompt(plan);
    if (!prompt) return {};
    return {
      systemPrompt: `${event.systemPrompt}\n\n${prompt}`,
      message: buildPlanTurnMessage(plan),
    };
  });

  pi.registerTool({
    name: "plan",
    label: "plan",
    description: "Read or update the current session's Plan sidebar. Prefer action=patch for multi-item add/update/remove operations; use action=update for full-plan replacement and action=edit only for exact Markdown edits. All mutations are normalized with at most one in_progress item.",
    promptSnippet: "plan: session checklist. Prefer action=patch with patches: [{ operation: add|update|remove, index?, match?, step?, status? }] for multi-item changes. Use action=update for full replacement. At most one item may be in_progress.",
    parameters: PlanToolSchema,
    prepareArguments(args): any {
      if (!args || typeof args !== "object") return args;
      const input = args as { action?: unknown; markdown?: unknown; oldText?: unknown; newText?: unknown; edits?: unknown; patches?: unknown; plan?: unknown };
      if (input.action === "get") return { ...input, action: "read" };
      if (input.action === "set") return { ...input, action: "write" };
      if (input.action === undefined && Array.isArray(input.plan)) return { ...input, action: "update" };
      if (input.action === undefined && Array.isArray(input.patches)) return { ...input, action: "patch" };
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
          details: structuredPlanDetails(plan),
        };
      }

      if (params.action === "update") {
        const update = normalizeUpdatePlanArgs(params);
        const plan = saveSessionPlan(chatJid, updatePlanArgsToMarkdown(update));
        broadcastPlanUpdated(plan, "tool", "update");
        return {
          content: [{ type: "text", text: "Plan updated." }],
          details: structuredPlanDetails(plan),
        };
      }

      if (params.action === "edit") {
        const plan = editSessionPlan(chatJid, params.edits);
        broadcastPlanUpdated(plan, "tool", "edit");
        return {
          content: [{ type: "text", text: `Edited plan for ${plan.chat_jid}.` }],
          details: structuredPlanDetails(plan),
        };
      }

      if (params.action === "patch") {
        const plan = patchSessionPlan(chatJid, params.patches);
        broadcastPlanUpdated(plan, "tool", "patch");
        return {
          content: [{ type: "text", text: `Patched plan for ${plan.chat_jid}.` }],
          details: structuredPlanDetails(plan),
        };
      }

      if (typeof params.markdown !== "string") {
        throw new Error("plan action=write requires a markdown string.");
      }
      const plan = saveSessionPlan(chatJid, params.markdown);
      broadcastPlanUpdated(plan, "tool", "write");
      return {
        content: [{ type: "text", text: `Updated plan for ${plan.chat_jid}.` }],
        details: structuredPlanDetails(plan),
      };
    },
  });
}

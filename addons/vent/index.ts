/**
 * vent/index.ts — Piclaw vent-log addon.
 *
 * Adapted from pi-vent by Igor Warzocha:
 *   https://github.com/IgorWarzocha/pi-vent
 * License: MIT (see vendor/pi-vent/LICENSE)
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { createExtensionStorage, type ExtensionStorage } from "./compat/extension-kv.js";

const EXTENSION_ID = "vent";
const DEFAULT_OUTPUT_PATH = "VENT.md";
const DEFAULT_HEADING = "# VENT\n\nFeedback log. Candid notes about friction, failures, and things that should be improved.\n\n";
const baseDir = dirname(fileURLToPath(import.meta.url));

export interface VentConfig {
  output_path: string;
}

const DEFAULT_CONFIG: VentConfig = {
  output_path: DEFAULT_OUTPUT_PATH,
};

const ventSchema = Type.Object({
  thought: Type.String({
    description: "Your candid feedback, frustration, confusion, or postmortem note.",
  }),
  trigger: Type.Optional(Type.String({
    description: "Short label for what triggered this vent, e.g. tool_error, bad_docs, confusing_task.",
  })),
}, { additionalProperties: false });

let kvStore: ExtensionStorage | null = null;
const fileMutationQueues = new Map<string, Promise<unknown>>();

function kv(): ExtensionStorage {
  if (!kvStore) kvStore = createExtensionStorage(EXTENSION_ID);
  return kvStore;
}

async function withLocalFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const current = fileMutationQueues.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = current.catch(() => undefined).then(() => pending);
  fileMutationQueues.set(filePath, queued);
  await current.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (fileMutationQueues.get(filePath) === queued) {
      fileMutationQueues.delete(filePath);
    }
  }
}

function clean(input: string): string {
  return input.trim().replace(/\r\n/g, "\n");
}

export function normalizeVentOutputPath(input: unknown): string {
  const raw = typeof input === "string" ? input.trim() : "";
  const fallback = DEFAULT_OUTPUT_PATH;
  const candidate = (raw || fallback)
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\/+/g, "");

  if (!candidate || candidate === ".") return fallback;
  if (isAbsolute(candidate) || /^[A-Za-z]:/.test(candidate)) {
    throw new Error("Output file must be a relative workspace path.");
  }

  const segments = candidate.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "..")) {
    throw new Error("Output file must stay inside the workspace.");
  }

  return segments.join("/") || fallback;
}

function safeVentOutputPath(input: unknown): string {
  try {
    return normalizeVentOutputPath(input);
  } catch {
    return DEFAULT_OUTPUT_PATH;
  }
}

function loadConfig(): VentConfig {
  try {
    const saved = kv().get<Partial<VentConfig>>("config", "global");
    if (saved) {
      return {
        output_path: safeVentOutputPath(saved.output_path),
      };
    }
  } catch {
    // first run
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(config: VentConfig): VentConfig {
  const next = {
    output_path: normalizeVentOutputPath(config.output_path),
  };
  kv().set("config", next, "global");
  return next;
}

function handleSetConfig(payload: Partial<VentConfig>): { ok: true; config: VentConfig } | { ok: false; error: string } {
  try {
    const current = loadConfig();
    const next = saveConfig({
      output_path: typeof payload.output_path === "string" ? payload.output_path : current.output_path,
    });
    return { ok: true, config: next };
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message || error) };
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function resolveVentOutputPath(workspaceDir: string, outputPath: string): string {
  const normalized = normalizeVentOutputPath(outputPath);
  return resolve(workspaceDir, normalized);
}

export async function writeVentEntry(
  workspaceDir: string,
  outputPath: string,
  thought: string,
  trigger?: string | null,
  now = new Date(),
): Promise<{ path: string; timestamp: string; thought: string; trigger?: string }> {
  const normalizedPath = normalizeVentOutputPath(outputPath);
  const absolutePath = resolveVentOutputPath(workspaceDir, normalizedPath);
  const timestamp = [
    String(now.getFullYear()).slice(-2),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-") + " " + [
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
  ].join(":");
  const cleanedThought = clean(thought);
  const cleanedTrigger = trigger ? clean(trigger) : undefined;
  const entry = [
    `## ${timestamp}${cleanedTrigger ? ` — ${cleanedTrigger}` : ""}`,
    "",
    cleanedThought,
    "",
  ].join("\n");

  await mkdir(dirname(absolutePath), { recursive: true });
  if (!(await fileExists(absolutePath))) {
    await writeFile(absolutePath, DEFAULT_HEADING, "utf8");
  }
  await appendFile(absolutePath, entry, "utf8");

  return {
    path: normalizedPath,
    timestamp,
    ...(cleanedTrigger ? { trigger: cleanedTrigger } : {}),
    thought: cleanedThought,
  };
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
  registerAddonConfigApi("vent", "config", {
    get: async () => loadConfig(),
    set: async (payload) => handleSetConfig((payload && typeof payload === "object" ? payload : {}) as Partial<VentConfig>),
  }, import.meta.dir);
}

export default function ventExtension(pi: ExtensionAPI): void {
  pi.on("resources_discover", () => ({
    skillPaths: [join(baseDir, "skills", "vent", "SKILL.md")],
  }));

  pi.registerTool({
    name: "vent",
    label: "vent",
    description: "Append major-issue feedback to the configured vent log file in the current workspace.",
    promptSnippet: "Append major-issue feedback to the configured vent log file.",
    promptGuidelines: [
      "Use vent only for major issues, not minor annoyances: repeated tool failures, seriously confusing instructions, broken docs, flaky commands, or avoidable friction that materially slowed you down.",
      "Use vent near the end of your turn and batch multiple thoughts into one call instead of making constant vent calls.",
      "Keep vent entries specific: what happened, why it sucked, and what would make it better next time. Do not use vent as a substitute for completing the user's task.",
    ],
    parameters: ventSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const thought = clean(params.thought);
      if (!thought) throw new Error("vent.thought must not be empty");

      const trigger = params.trigger ? clean(params.trigger) : undefined;
      const config = loadConfig();
      const outputPath = config.output_path || DEFAULT_OUTPUT_PATH;
      const absolutePath = resolveVentOutputPath(ctx.cwd, outputPath);

      return withLocalFileMutationQueue(absolutePath, async () => {
        const details = await writeVentEntry(ctx.cwd, outputPath, thought, trigger);
        return {
          content: [{ type: "text" as const, text: `Appended vent entry to ${details.path} (${details.timestamp}).` }],
          details,
        };
      });
    },
  });

  pi.on("before_agent_start", async (event) => {
    const config = loadConfig();
    return {
      systemPrompt: `${event.systemPrompt}\n\n## Vent\nThe vent tool is available for major friction worth remembering. It appends candid notes to ${config.output_path} relative to the current workspace. Use it sparingly and near the end of the turn, not for minor annoyances.`,
    };
  });
}

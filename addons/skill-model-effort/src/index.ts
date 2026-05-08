import type { ExtensionAPI, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, normalize, resolve } from "node:path";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

type RuntimeSkill = Pick<Skill, "name" | "filePath">;

type RuntimeMeta = {
  model?: string;
  thinking?: ThinkingLevel;
  warnings: string[];
};

type RestoreState = {
  model: ExtensionContext["model"];
  thinking: ThinkingLevel;
};

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

function canonicalPath(path: string, cwd: string): string {
  const withoutAt = path.startsWith("@") ? path.slice(1) : path;
  const absolute = isAbsolute(withoutAt) ? withoutAt : resolve(cwd, withoutAt);
  const normalized = normalize(absolute);

  try {
    return normalize(realpathSync(normalized));
  } catch {
    return normalized;
  }
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function skillsFromSystemPrompt(systemPrompt: string, cwd: string): RuntimeSkill[] {
  const skills: RuntimeSkill[] = [];
  const skillBlockPattern = /<skill>\s*([\s\S]*?)\s*<\/skill>/g;
  let match: RegExpExecArray | null;

  while ((match = skillBlockPattern.exec(systemPrompt))) {
    const block = match[1];
    const name = block.match(/<name>([\s\S]*?)<\/name>/)?.[1]?.trim();
    const location = block.match(/<location>([\s\S]*?)<\/location>/)?.[1]?.trim();
    if (name && location) {
      skills.push({ name: xmlUnescape(name), filePath: canonicalPath(xmlUnescape(location), cwd) });
    }
  }

  return skills;
}

function readSkillRuntimeMeta(skill: RuntimeSkill): RuntimeMeta {
  const raw = readFileSync(skill.filePath, "utf8");
  const { frontmatter } = parseFrontmatter<Record<string, unknown>>(raw);
  const warnings: string[] = [];

  const rawModel = typeof frontmatter.model === "string" ? frontmatter.model.trim() : "";
  const model = rawModel && rawModel !== "inherit" ? rawModel : undefined;

  const effort = typeof frontmatter.effort === "string" ? frontmatter.effort.trim() : "";
  const thinking = typeof frontmatter.thinking === "string" ? frontmatter.thinking.trim() : "";

  if (effort && thinking) {
    warnings.push(
      `Skill "${skill.name}" has both frontmatter keys "effort" and "thinking". They are mutually exclusive, so no thinking override was applied.`,
    );
    return { model, warnings };
  }

  const rawLevel = (thinking || effort).toLowerCase();
  if (!rawLevel) return { model, warnings };

  const normalizedLevel = rawLevel === "max" ? "xhigh" : rawLevel;
  if (!THINKING_LEVELS.has(normalizedLevel as ThinkingLevel)) {
    warnings.push(
      `Skill "${skill.name}" has invalid ${thinking ? "thinking" : "effort"} value "${rawLevel}". Expected one of: ${Array.from(
        THINKING_LEVELS,
      ).join(", ")} (or "max" as an alias for "xhigh").`,
    );
    return { model, warnings };
  }

  return { model, thinking: normalizedLevel as ThinkingLevel, warnings };
}

function findModel(modelRef: string, ctx: ExtensionContext): ExtensionContext["model"] {
  if (modelRef.includes("/")) {
    const [provider, ...idParts] = modelRef.split("/");
    const id = idParts.join("/");
    return ctx.modelRegistry.find(provider, id);
  }

  const exactMatches = ctx.modelRegistry.getAll().filter((model) => model.id === modelRef || model.name === modelRef);
  if (exactMatches.length === 1) return exactMatches[0];

  const lowerRef = modelRef.toLowerCase();
  const caseInsensitiveMatches = ctx.modelRegistry
    .getAll()
    .filter((model) => model.id.toLowerCase() === lowerRef || model.name.toLowerCase() === lowerRef);

  return caseInsensitiveMatches.length === 1 ? caseInsensitiveMatches[0] : undefined;
}

export default function skillModelEffort(pi: ExtensionAPI) {
  let skillsByName = new Map<string, RuntimeSkill>();
  let skillsByPath = new Map<string, RuntimeSkill>();
  let restoreState: RestoreState | undefined;

  function refreshSkillMaps(skills: RuntimeSkill[] | undefined, cwd: string) {
    skillsByName = new Map();
    skillsByPath = new Map();

    for (const skill of skills ?? []) {
      const filePath = canonicalPath(skill.filePath, cwd);
      const runtimeSkill = { name: skill.name, filePath };
      skillsByName.set(runtimeSkill.name, runtimeSkill);
      skillsByPath.set(filePath, runtimeSkill);
    }
  }

  function ensureSkillMaps(ctx: ExtensionContext) {
    if (skillsByName.size > 0) return;
    refreshSkillMaps(skillsFromSystemPrompt(ctx.getSystemPrompt(), ctx.cwd), ctx.cwd);
  }

  function rememberCurrentRuntime(ctx: ExtensionContext) {
    restoreState ??= {
      model: ctx.model,
      thinking: pi.getThinkingLevel() as ThinkingLevel,
    };
  }

  async function applySkillRuntime(skill: RuntimeSkill, ctx: ExtensionContext, source: "command" | "read") {
    const meta = readSkillRuntimeMeta(skill);
    if (!meta.model && !meta.thinking && meta.warnings.length === 0) return;

    rememberCurrentRuntime(ctx);

    for (const warning of meta.warnings) {
      if (ctx.hasUI) ctx.ui.notify(warning, "warning");
    }

    if (meta.model) {
      const model = findModel(meta.model, ctx);
      if (!model) {
        if (ctx.hasUI) ctx.ui.notify(`Skill "${skill.name}" requested unknown model "${meta.model}".`, "error");
      } else {
        const ok = await pi.setModel(model);
        if (!ok && ctx.hasUI) {
          ctx.ui.notify(`Skill "${skill.name}" requested model "${meta.model}", but no API key is configured.`, "error");
        }
      }
    }

    if (meta.thinking) {
      pi.setThinkingLevel(meta.thinking);
    }

    if (ctx.hasUI && (meta.model || meta.thinking)) {
      const parts = [
        meta.model ? `model ${meta.model}` : undefined,
        meta.thinking ? `thinking ${meta.thinking}` : undefined,
      ].filter(Boolean);
      ctx.ui.setStatus("skill-runtime", `skill ${skill.name}: ${parts.join(", ")}`);
      if (source === "read") {
        ctx.ui.notify(`Applied runtime frontmatter for skill "${skill.name}" after SKILL.md read.`, "info");
      }
    }
  }

  pi.on("input", async (event, ctx) => {
    const explicitSkillMatch = event.text.match(/^\/skill:([^\s]+)/);
    if (!explicitSkillMatch) return { action: "continue" as const };

    ensureSkillMaps(ctx);
    const skill = skillsByName.get(explicitSkillMatch[1]);
    if (skill) await applySkillRuntime(skill, ctx, "command");

    return { action: "continue" as const };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    refreshSkillMaps(event.systemPromptOptions.skills, ctx.cwd);

    const explicitSkillMatch = event.prompt.match(/<skill\s+name="([^"]+)"/);
    if (!explicitSkillMatch) return;

    const skill = skillsByName.get(explicitSkillMatch[1]);
    if (skill) await applySkillRuntime(skill, ctx, "command");
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "read") return;

    const path = (event.input as { path?: unknown }).path;
    if (typeof path !== "string") return;

    const resolvedPath = canonicalPath(path, ctx.cwd);
    const skill = skillsByPath.get(resolvedPath);
    if (!skill) return;

    // Avoid applying frontmatter for stale path entries after a file was removed/replaced.
    if (!existsSync(skill.filePath)) return;

    await applySkillRuntime(skill, ctx, "read");
  });

  pi.on("agent_end", async (_event, ctx) => {
    const previous = restoreState;
    if (!previous) return;

    restoreState = undefined;
    ctx.ui.setStatus("skill-runtime", undefined);

    if (previous.model) {
      await pi.setModel(previous.model);
    }
    pi.setThinkingLevel(previous.thinking);
  });
}

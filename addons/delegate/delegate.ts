/**
 * delegate.ts — Delegate tasks to a verified cheaper/faster child Pi model.
 *
 * Runs an ephemeral `pi --mode json --no-session` subprocess with a bounded
 * tool profile, parses structured progress/results, and returns the response
 * inline. Automatic selection is deterministic and tier-capped by the current
 * classified model.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, resolve, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

import { createExtensionStorage, type ExtensionStorage } from "./compat/extension-kv.js";

const DEFAULT_TIMEOUT_SEC = 120;
const MAX_OUTPUT_CHARS = 50_000;
const DELEGATE_STATUS_KEY = "delegate";
const MAX_TEXT_FILE_BYTES = 100_000; // 100KB limit for text file inlining
const ADDON_DIR = dirname(fileURLToPath(import.meta.url));

export function getDelegateWorkspaceRoot(
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): string {
  const candidate = resolve(env.PICLAW_WORKSPACE || cwd);
  try {
    return realpathSync(candidate);
  } catch {
    return candidate;
  }
}

const DELEGATE_STATUS_ICON_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M16 3h5v5"></path><path d="M21 3l-7 7"></path><path d="M8 21H3v-5"></path><path d="M3 21l7-7"></path><circle cx="12" cy="12" r="3"></circle></svg>`;

const EXTENSION_ID = "delegate";
const AZURE_PROVIDER_RE = /^azure-/i;
const DEFAULT_SEARCHABLE_PROVIDER_ORDER = ["github-copilot", "anthropic", "openai", "google", "openai-codex", "cerebras", "ollama"];

export interface DelegateConfig {
  searchable_providers: string[] | null;
  /** null = default exclusions (currently discovered azure-* providers); [] = exclude nothing */
  excluded_providers: string[] | null;
  /** Model id/full-id exclusion patterns. Supports `*` wildcards and substring fallback. */
  excluded_models: string[];
}

const DEFAULT_CONFIG: DelegateConfig = {
  searchable_providers: null, // null = all discovered, minus excluded providers; [] = intentionally disabled
  excluded_providers: null,
  excluded_models: [],
};

let storage: ExtensionStorage | null = null;
function kv(): ExtensionStorage {
  if (!storage) storage = createExtensionStorage(EXTENSION_ID);
  return storage;
}

function normalizeStringList(values: unknown): string[] | null {
  if (values == null) return null;
  const source = Array.isArray(values)
    ? values
    : (typeof values === "string" ? values.split(/[\n,]+/) : []);
  return [...new Set(source
    .map((value) => typeof value === "string" ? value.trim() : "")
    .filter(Boolean))];
}

function normalizeProviderList(values: unknown): string[] | null {
  return normalizeStringList(values);
}

function normalizeModelExclusionList(values: unknown): string[] {
  return normalizeStringList(values) ?? [];
}

function normalizeConfig(config: Partial<DelegateConfig> | null | undefined): DelegateConfig {
  return {
    searchable_providers: normalizeProviderList(config?.searchable_providers),
    excluded_providers: normalizeProviderList(config?.excluded_providers),
    excluded_models: normalizeModelExclusionList(config?.excluded_models),
  };
}

function loadConfig(): DelegateConfig {
  try {
    const saved = kv().get<Partial<DelegateConfig>>("config", "global");
    if (saved) return normalizeConfig({ ...DEFAULT_CONFIG, ...saved });
  } catch { /* first run */ }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(config: DelegateConfig): void {
  kv().set("config", normalizeConfig(config), "global");
}

/**
 * Discover the MCP adapter extension path.
 * Cached after first call — result doesn't change during a session.
 */
let _mcpPathCache: string | null | undefined;
function findMcpAdapter(): string | null {
  if (_mcpPathCache !== undefined) return _mcpPathCache;
  const candidates = [
    join(process.env.BUN_INSTALL || "/usr/local/lib/bun", "install/global/node_modules/pi-mcp-adapter/index.ts"),
    "/usr/local/lib/bun/install/global/node_modules/pi-mcp-adapter/index.ts",
  ];
  for (const p of candidates) {
    if (existsSync(p)) { _mcpPathCache = p; return p; }
  }
  _mcpPathCache = null;
  return null;
}

export type DelegateCliCommand = { command: string; argsPrefix: string[]; label: string };

type DelegateCliResolveOptions = {
  env?: Record<string, string | undefined>;
  platform?: string;
  execPath?: string;
  exists?: (path: string) => boolean;
  isExecutable?: (path: string, platform: string) => boolean;
  resolvePackageCli?: () => string | null;
};

const requireFromHere = createRequire(import.meta.url);
const PI_CODING_AGENT_PACKAGE = `@earendil-works/${"pi-coding-agent"}`;

function isExecutableFile(path: string, platform: string = process.platform): boolean {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return false;
    // Windows does not use POSIX executable bits. If the file exists and has a
    // runnable extension, let CreateProcess/cmd handle it.
    if (platform === "win32") return true;
    return (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function pathListDelimiter(platform: string): string {
  return platform === "win32" ? ";" : delimiter;
}

function pathExecutableExtensions(env: Record<string, string | undefined>, platform: string): string[] {
  if (platform !== "win32") return [""];
  return String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean);
}

function findExecutableOnPath(
  name: string,
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
  isExecutable: (path: string, platform: string) => boolean = isExecutableFile,
): string | null {
  const hasExtension = /\.[^/\\]+$/.test(name);
  const extensions = hasExtension ? [""] : pathExecutableExtensions(env, platform);
  for (const dir of String(env.PATH || "").split(pathListDelimiter(platform)).filter(Boolean)) {
    const candidates = platform === "win32"
      ? [join(dir, name), ...extensions.map((ext) => join(dir, `${name}${ext}`))]
      : [join(dir, name)];
    for (const candidate of [...new Set(candidates)]) {
      if (isExecutable(candidate, platform)) return candidate;
    }
  }
  return null;
}

function resolvePackagePiCliPath(): string | null {
  try {
    const direct = requireFromHere.resolve(`${PI_CODING_AGENT_PACKAGE}/dist/cli.js`);
    if (direct) return direct;
  } catch { /* package exports may hide dist/cli.js */ }
  try {
    const packageJson = requireFromHere.resolve(`${PI_CODING_AGENT_PACKAGE}/package.json`);
    return join(dirname(packageJson), "dist/cli.js");
  } catch {
    return null;
  }
}

function candidatePiCliPaths(env: Record<string, string | undefined>, resolvePackageCli: () => string | null): string[] {
  return [
    resolvePackageCli(),
    join(env.BUN_INSTALL || "/usr/local/lib/bun", "install/global/node_modules", PI_CODING_AGENT_PACKAGE, "dist/cli.js"),
    join("/usr/local/lib/bun", "install/global/node_modules", PI_CODING_AGENT_PACKAGE, "dist/cli.js"),
  ].filter((path): path is string => Boolean(path));
}

export function resolveDelegateCliCommand(options: DelegateCliResolveOptions = {}): DelegateCliCommand {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const isExecutable = options.isExecutable ?? isExecutableFile;
  const execPath = options.execPath || process.execPath || "";
  const override = env.PI_DELEGATE_CLI?.trim();
  if (override) {
    const [command, ...argsPrefix] = override.split(/\s+/).filter(Boolean);
    if (command) return { command, argsPrefix, label: override };
  }

  // Prefer invoking the Pi CLI JS entrypoint through the current runtime. This
  // avoids shebangs like `#!/usr/bin/env node`, so delegate works when Node is
  // not in PATH and also when Piclaw runs under Bun, Node, or a packaged runtime.
  if (execPath) {
    for (const cliPath of candidatePiCliPaths(env, options.resolvePackageCli ?? resolvePackagePiCliPath)) {
      if (exists(cliPath)) return { command: execPath, argsPrefix: [cliPath], label: `${execPath} ${cliPath}` };
    }
  }

  // Last resort: a platform shim/shell script on PATH. This may rely on its own
  // runtime, so only use it after direct current-runtime execution is unavailable.
  const piPath = findExecutableOnPath("pi", env, platform, isExecutable);
  if (piPath) return { command: piPath, argsPrefix: [], label: piPath };

  return { command: "pi", argsPrefix: [], label: "pi" };
}

// ── Model catalog and deterministic classification ──────────────

export type ModelTierNumber = 1 | 2 | 3 | 4 | 5;
export type ModelClassificationStatus = "classified" | "unclassified";
export type ModelClassificationConfidence = "exact-policy" | "none";
export type ModelCatalogSource = "runtime" | "cli";

export interface AvailableModel {
  provider: string;
  id: string;
  fullId: string;
  name?: string;
  context?: string;
  maxOut?: string;
  thinking?: string;
  images?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning?: boolean;
  supportsImages?: boolean;
  catalogSource?: ModelCatalogSource;
}

export interface ModelClassification {
  status: ModelClassificationStatus;
  tier: ModelTierNumber | null;
  family: string;
  rule: string | null;
  reason: string;
  confidence: ModelClassificationConfidence;
  preference: number;
}

export interface ModelCandidate {
  id: string;
  tier: ModelTierNumber;
  family: string;
  sourceId: string;
  provider: string;
  modelId: string;
  matchScore: number;
  classificationRule: string;
  classificationReason: string;
  classificationConfidence: ModelClassificationConfidence;
  supportsImages: boolean | null;
  reasoning: boolean | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
}

export interface RuntimeCatalogSnapshot {
  source: "runtime";
  models: AvailableModel[];
  currentModel: AvailableModel | null;
  capturedAt: number;
}

export interface ExecutableCatalogSnapshot {
  source: "cli";
  models: AvailableModel[];
  refreshedAt: number | null;
  lastAttemptAt: number | null;
  lastError: string | null;
  stale: boolean;
}

interface ClassificationRule {
  id: string;
  tier: ModelTierNumber;
  family: string;
  preference: number;
  reason: string;
  matches: (provider: string, normalizedId: string) => boolean;
}

function normalizedPolicyModelId(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[._]+/g, "-")
    .replace(/-+/g, "-");
}

function rule(
  id: string,
  tier: ModelTierNumber,
  family: string,
  preference: number,
  reason: string,
  pattern: RegExp,
): ClassificationRule {
  return { id, tier, family, preference, reason, matches: (_provider, normalizedId) => pattern.test(normalizedId) };
}

// Ordered from specific variants to broader families. Every model is assigned by
// the first matching rule only, so a model can never expand into multiple tiers.
const MODEL_CLASSIFICATION_RULES: ClassificationRule[] = [
  rule("claude-opus", 5, "claude", 10, "Claude Opus frontier family", /^claude-opus(?:-|$)/),
  rule("claude-haiku", 1, "claude", 30, "Claude Haiku fast family", /^claude-haiku(?:-|$)/),
  rule("claude-fable", 3, "claude", 10, "Claude Fable general-purpose family", /^claude-fable(?:-|$)/),
  rule("claude-sonnet-4-6", 3, "claude", 20, "Claude Sonnet 4.6 general-purpose model", /^claude-sonnet-4-6(?:-|$)/),
  rule("claude-sonnet-5", 3, "claude", 25, "Claude Sonnet 5 general-purpose model", /^claude-sonnet-5(?:-|$)/),
  rule("claude-sonnet", 3, "claude", 30, "Claude Sonnet general-purpose family", /^claude-sonnet(?:-|$)/),

  rule("gpt-codex-mini", 2, "gpt", 20, "GPT Codex Mini fast coding family", /^gpt-5(?:-[0-9]+)?-codex-mini(?:-|$)/),
  rule("gpt-codex-spark", 4, "gpt", 30, "GPT Codex Spark coding specialist", /^gpt-5(?:-[0-9]+)?-codex-spark(?:-|$)/),
  rule("gpt-codex-max", 4, "gpt", 35, "GPT Codex Max coding specialist", /^gpt-5(?:-[0-9]+)?-codex-max(?:-|$)/),
  rule("gpt-codex", 4, "gpt", 40, "GPT Codex coding specialist", /^gpt-5(?:-[0-9]+)?-codex(?:-|$)/),
  rule("gpt-pro", 4, "gpt", 45, "GPT Pro high-capability family", /^gpt-5(?:-[0-9]+)?-pro(?:-|$)/),
  rule("gpt-mini", 2, "gpt", 10, "GPT Mini fast family", /^gpt-5(?:-[0-9]+)?-mini(?:-|$)/),
  rule("gpt-5-4", 3, "gpt", 40, "GPT 5.4 general-purpose model", /^gpt-5-4(?:-|$)/),
  rule("gpt-5-5", 3, "gpt", 45, "GPT 5.5 general-purpose model", /^gpt-5-5(?:-|$)/),
  rule("gpt-5-6", 3, "gpt", 50, "GPT 5.6 general-purpose variants", /^gpt-5-6(?:-|$)/),
  rule("gpt-5-general", 3, "gpt", 55, "GPT 5 general-purpose family", /^gpt-5(?:-[0-9]+)?(?:-|$)/),
  rule("gpt-4", 1, "gpt", 20, "GPT 4 legacy family", /^gpt-4(?:-|$)/),
  rule("openai-o-series", 3, "gpt", 60, "OpenAI o-series reasoning family", /^o(?:1|3|4)(?:-|$)/),

  rule("gemini-flash", 2, "gemini", 40, "Gemini Flash fast family", /^gemini-.*(?:^|-)flash(?:-|$)/),
  rule("gemini-pro", 3, "gemini", 60, "Gemini Pro general-purpose family", /^gemini-.*(?:^|-)pro(?:-|$)/),
  rule("mai-code-flash", 2, "mai", 50, "MAI Code Flash fast coding family", /^mai-.*flash(?:-|$)/),
  rule("grok-code-fast", 1, "grok", 40, "Grok Code Fast family", /^(?:grok|xai)-.*fast(?:-|$)/),

  rule("deepseek-flash", 2, "deepseek", 60, "DeepSeek Flash fast family", /^deepseek-.*flash(?:-|$)/),
  rule("deepseek-pro", 3, "deepseek", 70, "DeepSeek Pro general-purpose family", /^deepseek-.*pro(?:-|$)/),
  rule("mistral-large", 3, "mistral", 80, "Mistral Large general-purpose family", /^mistral-large(?:-|$)/),
  rule("gemma", 2, "gemma", 70, "Gemma medium-weight family", /^gemma(?:-|$)/),
  rule("gpt-oss", 2, "gpt-oss", 75, "GPT OSS fast hosted family", /^gpt-oss(?:-|$)/),
  rule("glm", 2, "glm", 80, "GLM fast hosted family", /^(?:zai-)?glm(?:-|$)/),
  rule("qwen", 2, "qwen", 85, "Qwen medium-weight local family", /^qwen(?:\d|-|$)/),
  rule("lfm", 1, "lfm", 50, "LFM lightweight local family", /^lfm(?:\d|-|:|$)/),
];

function inferUnclassifiedFamily(modelId: string): string {
  const normalized = normalizedPolicyModelId(modelId);
  return normalized.split("-")[0] || "unknown";
}

export function classifyModel(model: Pick<AvailableModel, "provider" | "id"> | string): ModelClassification {
  const fullId = typeof model === "string" ? model : `${model.provider}/${model.id}`;
  const slash = fullId.indexOf("/");
  const provider = slash >= 0 ? fullId.slice(0, slash).toLowerCase() : "";
  const modelId = slash >= 0 ? fullId.slice(slash + 1) : fullId;
  const normalizedId = normalizedPolicyModelId(modelId);
  const matched = MODEL_CLASSIFICATION_RULES.find((candidate) => candidate.matches(provider, normalizedId));
  if (!matched) {
    return {
      status: "unclassified",
      tier: null,
      family: inferUnclassifiedFamily(modelId),
      rule: null,
      reason: `No ordered Delegate policy rule matches ${fullId}`,
      confidence: "none",
      preference: Number.MAX_SAFE_INTEGER,
    };
  }
  return {
    status: "classified",
    tier: matched.tier,
    family: matched.family,
    rule: matched.id,
    reason: matched.reason,
    confidence: "exact-policy",
    preference: matched.preference,
  };
}

function providerPreference(provider: string, searchableProviders: string[] | null): number {
  const configured = searchableProviders?.indexOf(provider) ?? -1;
  if (configured >= 0) return configured;
  const preferred = DEFAULT_SEARCHABLE_PROVIDER_ORDER.indexOf(provider);
  if (preferred >= 0) return preferred;
  return 100;
}

function getDiscoveredProviders(models: AvailableModel[]): string[] {
  return [...new Set(models.map((model) => model.provider).filter(Boolean))].sort();
}

function getExcludedProviders(models: AvailableModel[], config: DelegateConfig): string[] {
  const discovered = getDiscoveredProviders(models);
  const configured = normalizeProviderList(config.excluded_providers);
  if (configured !== null) return configured.filter((provider) => discovered.includes(provider));
  return discovered.filter((provider) => AZURE_PROVIDER_RE.test(provider));
}

function getAllowedProviders(models: AvailableModel[], config: DelegateConfig): string[] {
  const discovered = getDiscoveredProviders(models);
  const excluded = new Set(getExcludedProviders(models, config));
  const configured = normalizeProviderList(config.searchable_providers);
  const providerPool = configured === null ? discovered : configured;
  const discoveredSet = new Set(discovered);
  return providerPool.filter((provider) => discoveredSet.has(provider) && !excluded.has(provider));
}

function modelExclusionMatches(pattern: string, model: AvailableModel): boolean {
  const normalizedPattern = pattern.trim().toLowerCase();
  if (!normalizedPattern) return false;
  const haystacks = [model.fullId, model.id].map((value) => value.toLowerCase());
  if (normalizedPattern.includes("*")) {
    const escaped = normalizedPattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    const re = new RegExp(`^${escaped}$`, "i");
    return haystacks.some((value) => re.test(value));
  }
  return haystacks.some((value) => value === normalizedPattern || value.includes(normalizedPattern));
}

function isExcludedModel(model: AvailableModel, config: DelegateConfig): boolean {
  return normalizeModelExclusionList(config.excluded_models).some((pattern) => modelExclusionMatches(pattern, model));
}

function optionalBoolean(value: boolean | undefined, legacy: string | undefined): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof legacy === "string") return /^(yes|true|1)$/i.test(legacy);
  return null;
}

function optionalCount(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function describeImageCapability(model: Pick<ModelCandidate, "id" | "supportsImages">): string | null {
  if (model.supportsImages === true) return null;
  return model.supportsImages === false
    ? `${model.id} (images=no)`
    : `${model.id} (image capability unknown)`;
}

export function buildModelCandidates(models: AvailableModel[], config: DelegateConfig = DEFAULT_CONFIG): ModelCandidate[] {
  const normalizedConfig = normalizeConfig(config);
  const allowedProviders = new Set(getAllowedProviders(models, normalizedConfig));
  const candidates: Array<ModelCandidate & { preference: number; providerRank: number }> = [];
  const seen = new Set<string>();

  for (const model of models) {
    if (seen.has(model.fullId)) continue;
    seen.add(model.fullId);
    if (!allowedProviders.has(model.provider) || isExcludedModel(model, normalizedConfig)) continue;
    const classification = classifyModel(model);
    if (classification.status !== "classified" || classification.tier === null || !classification.rule) continue;
    candidates.push({
      id: model.fullId,
      tier: classification.tier,
      family: classification.family,
      sourceId: classification.rule,
      provider: model.provider,
      modelId: model.id,
      matchScore: 100,
      classificationRule: classification.rule,
      classificationReason: classification.reason,
      classificationConfidence: classification.confidence,
      supportsImages: optionalBoolean(model.supportsImages, model.images),
      reasoning: optionalBoolean(model.reasoning, model.thinking),
      contextWindow: optionalCount(model.contextWindow),
      maxOutputTokens: optionalCount(model.maxOutputTokens),
      preference: classification.preference,
      providerRank: providerPreference(model.provider, normalizedConfig.searchable_providers),
    });
  }

  return candidates
    .sort((a, b) => a.tier - b.tier || a.preference - b.preference || a.providerRank - b.providerRank || a.id.localeCompare(b.id))
    .map(({ preference: _preference, providerRank: _providerRank, ...candidate }) => candidate);
}

function getCurrentClassification(ctx: any): ModelClassification | null {
  const model = ctx?.model;
  return model?.provider && model?.id ? classifyModel({ provider: model.provider, id: model.id }) : null;
}

export function getCurrentTier(ctx: any): ModelTierNumber | null {
  const classification = getCurrentClassification(ctx);
  return classification?.status === "classified" ? classification.tier : null;
}

export interface ExplicitModelValidation {
  model: AvailableModel | null;
  policyBypass: true;
  error: string | null;
}

export function validateExplicitDelegateModel(
  requestedModel: string,
  executableModels: AvailableModel[],
  runtimeModels: AvailableModel[],
): ExplicitModelValidation {
  const model = executableModels.find((candidate) => candidate.fullId === requestedModel) ?? null;
  if (model) return { model, policyBypass: true, error: null };
  const runtimeOnly = runtimeModels.some((candidate) => candidate.fullId === requestedModel);
  return {
    model: null,
    policyBypass: true,
    error: runtimeOnly
      ? `Delegate model ${requestedModel} is available in Piclaw but not executable by the child Pi CLI.`
      : `Delegate model ${requestedModel} is not available in the child Pi CLI catalog. Use an exact provider/model ID from Delegate settings.`,
  };
}

type TaskCategory = "quick" | "summarize" | "code" | "analyze" | "reason" | "judge";

const CATEGORY_TARGET_TIER: Record<TaskCategory, ModelTierNumber> = {
  quick: 2,
  summarize: 2,
  code: 3,
  analyze: 3,
  reason: 3,
  judge: 3,
};

const VALID_CATEGORIES = new Set<TaskCategory>(["quick", "summarize", "code", "analyze", "reason", "judge"]);

export function selectModel(
  category: TaskCategory,
  maxTier: ModelTierNumber,
  currentModelId: string | undefined,
  discoveredCandidates: ModelCandidate[],
): string | null {
  const candidates = discoveredCandidates.filter((candidate) => candidate.tier <= maxTier);
  if (candidates.length === 0) return null;
  const targetTier = Math.min(CATEGORY_TARGET_TIER[category] ?? 2, maxTier) as ModelTierNumber;

  if (category === "judge" && currentModelId) {
    const currentFamily = classifyModel(currentModelId).family;
    for (let tier = targetTier; tier >= 1; tier -= 1) {
      const differentFamily = candidates.find((candidate) => candidate.tier === tier && candidate.family !== currentFamily);
      if (differentFamily) return differentFamily.id;
    }
  }

  const atTarget = candidates.find((candidate) => candidate.tier === targetTier);
  if (atTarget) return atTarget.id;
  for (let tier = targetTier - 1; tier >= 1; tier -= 1) {
    const lower = candidates.find((candidate) => candidate.tier === tier);
    if (lower) return lower.id;
  }
  return null;
}

/** Detect provider authentication/credential errors so delegate can fall back to another model. */
export function isProviderAuthError(text: unknown): boolean {
  const value = String(text || "").toLowerCase();
  if (!value) return false;
  return value.includes("no api key for provider")
    || value.includes("missing api key")
    || value.includes("no credentials")
    || value.includes("not authenticated")
    || value.includes("authentication failed")
    || value.includes("unauthorized");
}

export type DelegateFailureKind = "auth" | "model-unavailable" | "provider-setup" | "timeout" | "aborted" | "execution" | "protocol";

export function classifyDelegateFailure(text: unknown): DelegateFailureKind {
  const value = String(text || "").toLowerCase();
  if (isProviderAuthError(value)) return "auth";
  if (/timed out|timeout/.test(value)) return "timeout";
  if (/\babort(?:ed)?\b|cancelled|canceled/.test(value)) return "aborted";
  if (/model .*(?:not found|unavailable|unsupported|does not exist)|unknown model|failed to resolve model|invalid model/.test(value)) return "model-unavailable";
  if (/provider .*(?:not found|unavailable|unsupported)|unknown provider|failed to (?:initialize|load) provider|no provider (?:registered|configured)/.test(value)) return "provider-setup";
  if (/malformed json|no valid json events|json protocol/.test(value)) return "protocol";
  return "execution";
}

export function isRetryableDelegateFailure(kind: DelegateFailureKind): boolean {
  return kind === "auth" || kind === "model-unavailable" || kind === "provider-setup";
}

export function buildDelegateModelChain(
  category: TaskCategory,
  maxTier: ModelTierNumber,
  currentModelId: string | undefined,
  discoveredCandidates: ModelCandidate[],
  limit = 3,
): string[] {
  const chain: string[] = [];
  const primary = selectModel(category, maxTier, currentModelId, discoveredCandidates);
  if (primary) chain.push(primary);
  const targetTier = Math.min(CATEGORY_TARGET_TIER[category] ?? 2, maxTier);
  const fallbacks = discoveredCandidates
    .filter((candidate) => candidate.tier <= targetTier)
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => Math.abs(a.candidate.tier - targetTier) - Math.abs(b.candidate.tier - targetTier) || a.index - b.index);
  for (const { candidate } of fallbacks) {
    if (chain.length >= limit) break;
    if (!chain.includes(candidate.id)) chain.push(candidate.id);
  }
  return chain;
}

// ── Model discovery ────────────────────────────────────────────

function parseModelCount(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*([KMG])?$/i);
  if (!match) return undefined;
  const base = Number(match[1]);
  const multiplier = match[2]?.toUpperCase() === "G" ? 1_000_000_000
    : match[2]?.toUpperCase() === "M" ? 1_000_000
      : match[2]?.toUpperCase() === "K" ? 1_000
        : 1;
  return Math.round(base * multiplier);
}

function parseYesNo(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  if (/^(yes|true|1)$/i.test(value.trim())) return true;
  if (/^(no|false|0)$/i.test(value.trim())) return false;
  return undefined;
}

export function runtimeModelToAvailable(model: any): AvailableModel | null {
  if (!model?.provider || !model?.id) return null;
  const input = Array.isArray(model.input) ? model.input.map((entry: unknown) => String(entry).toLowerCase()) : [];
  return {
    provider: String(model.provider),
    id: String(model.id),
    fullId: `${model.provider}/${model.id}`,
    name: typeof model.name === "string" ? model.name : undefined,
    contextWindow: parseModelCount(model.contextWindow ?? model.context_window),
    maxOutputTokens: parseModelCount(model.maxTokens ?? model.maxOutputTokens ?? model.max_output_tokens),
    reasoning: typeof model.reasoning === "boolean" ? model.reasoning : undefined,
    supportsImages: input.length > 0
      ? input.includes("image")
      : (typeof model.supportsImages === "boolean" ? model.supportsImages : (typeof model.supports_images === "boolean" ? model.supports_images : undefined)),
    catalogSource: "runtime",
  };
}

export async function captureRuntimeCatalog(
  ctx: any,
  fallback?: RuntimeCatalogSnapshot | null,
): Promise<RuntimeCatalogSnapshot> {
  // Catalog capture is a passive lifecycle read. ModelRegistry.refresh() is
  // process-wide and network-enabled by default, so invoking it from
  // session_start/model_select blocks session readiness and refreshes every
  // dynamic provider. Piclaw owns background provider refresh and publishes
  // its last-good availability snapshot synchronously through getAvailable().
  let rawModels: unknown;
  try {
    rawModels = ctx?.modelRegistry?.getAvailable?.();
  } catch {
    rawModels = undefined;
  }

  const seen = new Set<string>();
  const models = (Array.isArray(rawModels) ? rawModels : [])
    .map(runtimeModelToAvailable)
    .filter((model: AvailableModel | null): model is AvailableModel => Boolean(model))
    .filter((model: AvailableModel) => {
      if (seen.has(model.fullId)) return false;
      seen.add(model.fullId);
      return true;
    });
  const currentModel = runtimeModelToAvailable(ctx?.model) ?? fallback?.currentModel ?? null;
  if (models.length === 0 && fallback?.models.length) {
    return { ...fallback, currentModel, capturedAt: Date.now() };
  }
  return { source: "runtime", models, currentModel, capturedAt: Date.now() };
}

export function mergeExecutableRuntimeMetadata(
  executableModels: AvailableModel[],
  runtimeModels: AvailableModel[],
): AvailableModel[] {
  const runtimeById = new Map(runtimeModels.map((model) => [model.fullId, model]));
  return executableModels.map((executable) => {
    const runtime = runtimeById.get(executable.fullId);
    if (!runtime) return executable;
    return {
      ...executable,
      name: runtime.name ?? executable.name,
      contextWindow: runtime.contextWindow ?? executable.contextWindow,
      maxOutputTokens: runtime.maxOutputTokens ?? executable.maxOutputTokens,
      reasoning: runtime.reasoning ?? executable.reasoning,
      supportsImages: runtime.supportsImages ?? executable.supportsImages,
      catalogSource: "cli",
    };
  });
}

export function parsePiListModelsOutput(output: string): AvailableModel[] {
  const lines = String(output || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const models: AvailableModel[] = [];
  for (const line of lines) {
    if (/^provider\s+model\s+/i.test(line)) continue;
    const parts = line.split(/\s+/).filter(Boolean);
    if (parts.length < 2) continue;
    const [provider, id, context, maxOut, thinking, images] = parts;
    if (!provider || !id) continue;
    models.push({
      provider,
      id,
      fullId: `${provider}/${id}`,
      context,
      maxOut,
      thinking,
      images,
      contextWindow: parseModelCount(context),
      maxOutputTokens: parseModelCount(maxOut),
      reasoning: parseYesNo(thinking),
      supportsImages: parseYesNo(images),
      catalogSource: "cli",
    });
  }
  return models;
}

function runPiListModels(timeoutMs = 20_000, signal?: AbortSignal): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted during Delegate model discovery"));
      return;
    }
    const cli = resolveDelegateCliCommand();
    const child = nodeSpawn(cli.command, [...cli.argsPrefix, "--list-models"], {
      cwd: getDelegateWorkspaceRoot(),
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let terminationError: Error | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let forceTimer: ReturnType<typeof setTimeout> | null = null;

    const sendSignal = (childSignal: NodeJS.Signals) => {
      if (process.platform !== "win32" && child.pid) {
        try { process.kill(-child.pid, childSignal); return; } catch { /* fall through */ }
      }
      try { child.kill(childSignal); } catch { /* already exited */ }
    };
    const cleanup = () => {
      clearTimeout(deadlineTimer);
      if (killTimer) clearTimeout(killTimer);
      if (forceTimer) clearTimeout(forceTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    const terminate = (error: Error) => {
      if (settled || terminationError) return;
      terminationError = error;
      sendSignal("SIGTERM");
      killTimer = setTimeout(() => sendSignal("SIGKILL"), 2_000);
      forceTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }, 2_500);
    };
    const onAbort = () => terminate(new Error("Aborted during Delegate model discovery"));
    const deadlineTimer = setTimeout(() => terminate(new Error(`${cli.label} --list-models timed out`)), Math.max(1, timeoutMs));
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 2_000_000) stdout += chunk.toString().slice(0, 2_000_000 - stdout.length);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 64_000) stderr += chunk.toString().slice(0, 64_000 - stderr.length);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (terminationError) reject(terminationError);
      else if (code !== 0) reject(new Error(stderr.trim() || `${cli.label} --list-models exited ${code}`));
      else resolvePromise(stdout);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(terminationError ?? error);
    });
  });
}

const MODEL_CATALOG_TTL_MS = Math.max(5_000, Number(process.env.PI_DELEGATE_MODEL_CACHE_TTL_MS || "60000"));
let runtimeCatalogSnapshot: RuntimeCatalogSnapshot | null = null;
let executableCatalogSnapshot: ExecutableCatalogSnapshot | null = null;

export function invalidateExecutableCatalog(): void {
  if (executableCatalogSnapshot) executableCatalogSnapshot.stale = true;
}

function executableCatalogIsFresh(snapshot: ExecutableCatalogSnapshot, now = Date.now()): boolean {
  return !snapshot.stale
    && snapshot.refreshedAt !== null
    && snapshot.models.length > 0
    && now - snapshot.refreshedAt < MODEL_CATALOG_TTL_MS;
}

export async function getExecutableCatalog(
  refresh = false,
  timeoutMs = 20_000,
  signal?: AbortSignal,
): Promise<ExecutableCatalogSnapshot> {
  const now = Date.now();
  if (!refresh && executableCatalogSnapshot && executableCatalogIsFresh(executableCatalogSnapshot, now)) {
    return executableCatalogSnapshot;
  }
  try {
    const output = await runPiListModels(timeoutMs, signal);
    const models = parsePiListModelsOutput(output);
    if (models.length === 0) throw new Error("pi --list-models returned no executable models");
    executableCatalogSnapshot = {
      source: "cli",
      models,
      refreshedAt: Date.now(),
      lastAttemptAt: now,
      lastError: null,
      stale: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    executableCatalogSnapshot = {
      source: "cli",
      models: executableCatalogSnapshot?.models ?? [],
      refreshedAt: executableCatalogSnapshot?.refreshedAt ?? null,
      lastAttemptAt: now,
      lastError: message,
      stale: true,
    };
    if (signal?.aborted || (timeoutMs < 20_000 && /timed out/i.test(message))) throw error;
  }
  return executableCatalogSnapshot;
}

async function getDiscoveredModels(refresh = false): Promise<AvailableModel[]> {
  return (await getExecutableCatalog(refresh)).models;
}

async function getModelCandidates(config: DelegateConfig, refresh = false): Promise<ModelCandidate[]> {
  const models = await getDiscoveredModels(refresh);
  return buildModelCandidates(models, config);
}

// ── Default tool sets per task profile ─────────────────────────

const TOOL_PROFILES: Record<string, string> = {
  read_only:  "read,grep,find,ls",
  standard:   "read,grep,find,ls,bash",
  full:       "read,grep,find,ls,bash,edit,write",
};
const BUILTIN_CHILD_TOOLS = new Set(["read", "grep", "find", "ls", "bash", "edit", "write"]);

const NATIVE_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const UNSUPPORTED_BINARY_EXTENSIONS = new Set([
  ".tiff", ".tif", ".svg", ".ico", ".pdf", ".zip", ".tar", ".gz", ".7z", ".rar",
  ".mp3", ".wav", ".flac", ".ogg", ".mp4", ".mov", ".avi", ".mkv", ".webm",
]);

export interface DelegateFileInspection {
  kind: "text" | "image" | "unsupported";
  format: string;
  reason?: string;
}

function fileExtension(path: string): string {
  const basename = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = basename.lastIndexOf(".");
  return dot >= 0 ? basename.slice(dot).toLowerCase() : "";
}

function startsWithBytes(buffer: Buffer, bytes: number[], offset = 0): boolean {
  return bytes.every((byte, index) => buffer[offset + index] === byte);
}

function readFileHeader(path: string, bytes = 512): Buffer {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const count = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, count);
  } finally {
    closeSync(fd);
  }
}

export function inspectDelegateFile(path: string): DelegateFileInspection {
  const header = readFileHeader(path);
  const extension = fileExtension(path);
  if (startsWithBytes(header, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: "image", format: "PNG" };
  if (startsWithBytes(header, [0xff, 0xd8, 0xff])) return { kind: "image", format: "JPEG" };
  if (header.subarray(0, 6).toString("ascii") === "GIF87a" || header.subarray(0, 6).toString("ascii") === "GIF89a") return { kind: "image", format: "GIF" };
  if (header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP") return { kind: "image", format: "WebP" };
  if (header.subarray(0, 2).toString("ascii") === "BM") return { kind: "image", format: "BMP" };

  const ascii = header.toString("utf8");
  const trimmed = ascii.replace(/^\uFEFF/, "").trimStart();
  let format = "binary data";
  if (trimmed.startsWith("%PDF-")) format = "PDF";
  else if (/^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(trimmed)) format = "SVG";
  else if (startsWithBytes(header, [0x50, 0x4b, 0x03, 0x04])) format = "ZIP archive";
  else if (startsWithBytes(header, [0x1f, 0x8b])) format = "gzip archive";
  else if (header.subarray(257, 262).toString("ascii") === "ustar") format = "tar archive";
  else if (startsWithBytes(header, [0x49, 0x49, 0x2a, 0x00]) || startsWithBytes(header, [0x4d, 0x4d, 0x00, 0x2a])) format = "TIFF";
  else if (startsWithBytes(header, [0x00, 0x00, 0x01, 0x00])) format = "ICO";
  else if (header.subarray(0, 3).toString("ascii") === "ID3") format = "audio";
  else if (header.subarray(0, 4).toString("ascii") === "OggS" || header.subarray(0, 4).toString("ascii") === "fLaC") format = "audio";
  else if (header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WAVE") format = "WAV audio";
  else if (header.subarray(4, 8).toString("ascii") === "ftyp" || startsWithBytes(header, [0x1a, 0x45, 0xdf, 0xa3])) format = "video";
  else if (!header.includes(0) && !UNSUPPORTED_BINARY_EXTENSIONS.has(extension)) {
    if (NATIVE_IMAGE_EXTENSIONS.has(extension)) {
      return { kind: "unsupported", format: "invalid image", reason: "The image extension does not match supported PNG, JPEG, GIF, WebP, or BMP content." };
    }
    return { kind: "text", format: "text" };
  } else if (UNSUPPORTED_BINARY_EXTENSIONS.has(extension)) {
    format = extension.slice(1).toUpperCase();
  }

  const reason = format === "PDF"
    ? "Extract its text with an appropriate document tool, or convert the required page to PNG/JPEG before delegation."
    : format === "SVG" || format === "TIFF" || format === "ICO"
      ? "Convert it to PNG, JPEG, GIF, WebP, or BMP before delegation."
      : "Extract, transcribe, or convert it to text or a supported native raster image before delegation.";
  return { kind: "unsupported", format, reason };
}

/** Validate a resolved path: must be inside workspace, no control characters. */
function validateFilePath(resolvedPath: string, original: string, workspaceRoot: string): string | null {
  if (/[\x00-\x1f]/.test(resolvedPath)) return `Unsafe characters in path: ${original}`;
  if (!resolvedPath.startsWith(workspaceRoot + "/") && resolvedPath !== workspaceRoot) {
    return `Path outside workspace: ${original} (resolved to ${resolvedPath})`;
  }
  return null;
}

export interface PreparedDelegateFile {
  resolved: string;
  size: number;
  inspection: DelegateFileInspection;
}

export function prepareDelegateFile(filePath: string): PreparedDelegateFile {
  const workspaceRoot = getDelegateWorkspaceRoot();
  const lexicalPath = resolve(filePath);
  const lexicalError = validateFilePath(lexicalPath, filePath, workspaceRoot);
  if (lexicalError) throw new Error(lexicalError);
  if (!existsSync(lexicalPath)) throw new Error(`File not found: ${filePath}`);
  const resolved = realpathSync(lexicalPath);
  const canonicalError = validateFilePath(resolved, filePath, workspaceRoot);
  if (canonicalError) throw new Error(canonicalError);
  const stat = statSync(resolved);
  if (!stat.isFile()) throw new Error(`Delegate files must be regular files: ${filePath}`);
  // Sniff only after the regular-file check so FIFOs/devices/sockets cannot block here.
  return { resolved, size: stat.size, inspection: inspectDelegateFile(resolved) };
}

// ── Helpers ────────────────────────────────────────────────────

function result(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], ...(details ? { details } : {}) };
}

function delegateFailure(message: string): never {
  throw new Error(message.replace(/^❌\s*/, ""));
}

export function delegateTaskPreview(prompt: string, maxLength = 96): string {
  const collapsed = String(prompt || "").replace(/\s+/g, " ").trim();
  if (!collapsed) return "delegated task";
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength - 1)}…` : collapsed;
}

function readTrimmedString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
  return typeof value === "object" ? value as Record<string, unknown> : null;
}

function extractDelegateStatusArgs(args: unknown): Record<string, unknown> | null {
  const record = readRecord(args);
  if (!record) return null;
  const nested = readRecord(record.arguments) || readRecord(record.input) || readRecord(record.params) || readRecord(record.parameters) || readRecord(record.args) || readRecord(record.payload);
  return nested || record;
}

export function buildDelegateStatusUpdate(model: string, prompt: string): string {
  return `Delegate model: ${model}\nArguments: ${delegateTaskPreview(prompt, 160)}`;
}

function modelFromDelegateStatusPreview(payload: Record<string, unknown> | null): string | null {
  const preview = readTrimmedString(payload?.output_preview, payload?.outputPreview);
  if (!preview) return null;
  const match = preview.match(/^Delegate model:\s*([^\n]+)/i);
  return match?.[1]?.trim() || null;
}

export function delegateStatusModelHint(args: unknown, payload?: Record<string, unknown> | null): string | null {
  const record = extractDelegateStatusArgs(args);
  return modelFromDelegateStatusPreview(payload || null) || readTrimmedString(record?.model);
}

type ToolStatusHintRegistrar = (provider: {
  id: string;
  buildHints: (ctx: { toolName: string; args: unknown; payload?: Record<string, unknown> }) => unknown;
}) => void;

function registerToolStatusHintProvider(provider: Parameters<ToolStatusHintRegistrar>[0]): void {
  const fn = (globalThis as Record<string, unknown>).__piclaw_registerToolStatusHintProvider;
  if (typeof fn === "function") (fn as ToolStatusHintRegistrar)(provider);
}

registerToolStatusHintProvider({
  id: "delegate",
  buildHints: ({ toolName, args, payload }) => {
    if (toolName !== "delegate") return null;
    const model = delegateStatusModelHint(args, payload || null);
    if (!model) return null;
    return {
      key: "delegate-model",
      icon_svg: DELEGATE_STATUS_ICON_SVG,
      label: model,
      title: `Delegate model • ${model}`,
      kind: "model",
    };
  },
});

function setDelegateProgress(ctx: any, options: { model: string; category: TaskCategory; prompt: string }): void {
  const preview = delegateTaskPreview(options.prompt);
  const message = `Delegating ${options.category} to ${options.model}: ${preview}`;
  try { ctx?.ui?.setStatus?.(DELEGATE_STATUS_KEY, `🤝 ${message}`); } catch { /* UI may not support status in all modes */ }
  try { ctx?.ui?.setWorkingMessage?.(message); } catch { /* UI may not support working messages in all modes */ }
}

function clearDelegateProgress(ctx: any): void {
  try { ctx?.ui?.setStatus?.(DELEGATE_STATUS_KEY, undefined); } catch { /* ignore */ }
  try { ctx?.ui?.setWorkingMessage?.(undefined); } catch { /* ignore */ }
}

// ── Settings API ───────────────────────────────────────────────

type AddonConfigApiRegistrar = (
  addonId: string,
  action: string,
  handlers: { get?: (payload: unknown, req: Request) => unknown | Promise<unknown>; set?: (payload: unknown, req: Request) => unknown | Promise<unknown> },
  extensionPath?: string,
) => "created" | "updated";

function providerSummaries(models: AvailableModel[], config: DelegateConfig) {
  const enabled = new Set(getAllowedProviders(models, config));
  const excluded = new Set(getExcludedProviders(models, config));
  const providers = getDiscoveredProviders(models);
  return providers.map((provider) => ({
    provider,
    enabled: enabled.has(provider),
    excluded: excluded.has(provider),
    blacklisted: excluded.has(provider),
    defaultExcluded: config.excluded_providers === null && AZURE_PROVIDER_RE.test(provider),
    modelCount: models.filter((model) => model.provider === provider).length,
  }));
}

async function handleGetModels(refresh = false) {
  const config = loadConfig();
  const executable = await getExecutableCatalog(refresh);
  const runtime = runtimeCatalogSnapshot;
  const executableModels = mergeExecutableRuntimeMetadata(executable.models, runtime?.models ?? []);
  const candidates = buildModelCandidates(executableModels, config);
  const executableIds = new Set(executableModels.map((model) => model.fullId));
  const runtimeOnlyModels = (runtime?.models.filter((model) => !executableIds.has(model.fullId)) ?? [])
    .map((model) => ({ ...model, classification: classifyModel(model) }));
  const classifications = new Map(executableModels.map((model) => [model.fullId, classifyModel(model)]));
  const unclassifiedModels = executableModels
    .filter((model) => classifications.get(model.fullId)?.status === "unclassified")
    .map((model) => ({ ...model, classification: classifications.get(model.fullId) }));
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const allowedProviders = new Set(getAllowedProviders(executableModels, config));
  const excludedProviders = new Set(getExcludedProviders(executableModels, config));
  const rejectedModels = executableModels
    .filter((model) => !candidateIds.has(model.fullId))
    .map((model) => {
      const classification = classifications.get(model.fullId)!;
      const reason = classification.status === "unclassified"
        ? classification.reason
        : excludedProviders.has(model.provider)
          ? `Provider ${model.provider} is excluded`
          : !allowedProviders.has(model.provider)
            ? `Provider ${model.provider} is not selected`
            : isExcludedModel(model, config)
              ? "Model matches an exclusion pattern"
              : "Model is not eligible";
      return { ...model, classification, rejection_reason: reason };
    });
  return {
    ok: true,
    config,
    cli: resolveDelegateCliCommand().label,
    discovery_error: executable.lastError,
    cache: {
      ttl_ms: MODEL_CATALOG_TTL_MS,
      refreshed_at: executable.refreshedAt,
      last_attempt_at: executable.lastAttemptAt,
      stale: executable.stale,
    },
    runtime_catalog: {
      captured_at: runtime?.capturedAt ?? null,
      current_model: runtime?.currentModel?.fullId ?? null,
      current_classification: runtime?.currentModel ? classifyModel(runtime.currentModel) : null,
      model_count: runtime?.models.length ?? 0,
    },
    executable_catalog: { model_count: executable.models.length, candidate_count: candidates.length },
    effective_exclusions: {
      providers: [...excludedProviders],
      models: normalizeModelExclusionList(config.excluded_models),
    },
    providers: providerSummaries(executableModels, config),
    models: executableModels,
    runtime_only_models: runtimeOnlyModels,
    unclassified_models: unclassifiedModels,
    rejected_models: rejectedModels,
    candidates,
  };
}

const registerAddonConfigApi = (globalThis as Record<string, unknown>).__piclaw_registerAddonConfigApi as AddonConfigApiRegistrar | undefined;
if (typeof registerAddonConfigApi === "function") {
  registerAddonConfigApi(EXTENSION_ID, "config", {
    get: async () => ({ ok: true, config: loadConfig() }),
    set: async (payload) => {
      const body = payload && typeof payload === "object" ? payload as Partial<DelegateConfig> : {};
      const current = loadConfig();
      const next = normalizeConfig({
        ...current,
        ...(Object.prototype.hasOwnProperty.call(body, "searchable_providers") ? { searchable_providers: body.searchable_providers } : {}),
        ...(Object.prototype.hasOwnProperty.call(body, "excluded_providers") ? { excluded_providers: body.excluded_providers } : {}),
        ...(Object.prototype.hasOwnProperty.call(body, "excluded_models") ? { excluded_models: body.excluded_models } : {}),
      });
      saveConfig(next);
      return { ok: true, config: next };
    },
  }, ADDON_DIR);
  registerAddonConfigApi(EXTENSION_ID, "models", {
    get: async () => handleGetModels(false),
    set: async () => handleGetModels(true),
  }, ADDON_DIR);
}

// ── Extension ──────────────────────────────────────────────────

export default function (pi: any) {
  const updateRuntimeCatalog = async (ctx: any) => {
    runtimeCatalogSnapshot = await captureRuntimeCatalog(ctx, runtimeCatalogSnapshot);
  };
  pi.on("session_start", async (_event: unknown, ctx: any) => updateRuntimeCatalog(ctx));
  pi.on("model_select", async (_event: unknown, ctx: any) => updateRuntimeCatalog(ctx));

  const HINT = [
    "## Delegate tool",
    "Use `delegate` for self-contained work in a fresh ephemeral Pi context; it has no conversation history.",
    "Automatic selection uses only models verified by the child Pi CLI and never selects above the current model's verified tier.",
    "The child receives the requested tool profile (read-only, standard, full, or an explicit list); do not assume every installed Piclaw add-on tool is available.",
    "Pass workspace text files or content-sniffed JPEG, PNG, GIF, WebP, and BMP images in `files`; extract or convert PDF, SVG, archives, audio, video, and other binaries first.",
    "An explicit `model` must be an exact executable provider/model ID; it bypasses automatic tier/exclusion policy but not executable or image-capability validation.",
    "Proactively delegate when a task is self-contained and does not need conversation history.",
    "When you call delegate, produce a visible one-sentence timeline update that says what you are delegating and why; do not leave the user with zero feedback while the delegated process runs.",
    "When the user asks to double-check, verify, or review your answer, use `task_category: judge`; it selects another family when a valid tier-safe executable alternative exists.",
  ].join("\n");

  pi.on("before_agent_start", async (event: { systemPrompt: string }, ctx: any) => {
    await updateRuntimeCatalog(ctx);
    // Auto-activate delegate tool so it's available without manual activate_tools
    const active = pi.getActiveTools();
    if (!active.includes("delegate")) {
      pi.setActiveTools([...active, "delegate"]);
    }
    return { systemPrompt: `${event.systemPrompt}\n\n${HINT}` };
  });

  pi.registerTool({
    name: "delegate",
    label: "Delegate to Model",
    description:
      "Delegate a task to a cheaper/faster model in a fresh context. " +
      "The delegate has its own tool access (read, grep, bash, etc.) but no conversation history. " +
      "Use for: summarizing files, quick questions, code generation, data extraction, codebase exploration, " +
      "or any task that doesn't require the full conversation context. " +
      "Automatic selection uses the verified child CLI catalog and never exceeds the current model's classified tier.",
    parameters: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: {
          type: "string",
          description: "The task to delegate. Be specific — the delegate has no conversation history.",
        },
        task_category: {
          type: "string",
          enum: ["quick", "summarize", "code", "analyze", "reason", "judge"],
          description: "Task category: quick, summarize, code, analyze, reason, or judge. Default: summarize.",
        },
        model: {
          type: "string",
          description: "Exact executable provider/model override. Bypasses automatic tier and provider/model exclusion policy, but must exist in the child Pi CLI catalog.",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Workspace files to include. Text is inlined up to 100KB; only native PNG, JPEG, GIF, WebP, and BMP images are attached.",
        },
        tools: {
          type: "string",
          description: "Tool profile (read_only, standard, full) or a comma-separated child Pi built-in list. MCP is available only when its explicit adapter is installed. Default: standard.",
        },
        system_prompt: {
          type: "string",
          description: "Custom system prompt override.",
        },
        timeout_sec: {
          type: "integer",
          description: `Timeout in seconds. Default: ${DEFAULT_TIMEOUT_SEC}`,
          minimum: 10,
          maximum: 300,
        },
      },
    },

    async execute(_toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
      const requestedTimeout = Number(params.timeout_sec ?? DEFAULT_TIMEOUT_SEC);
      const timeout = Number.isFinite(requestedTimeout) ? Math.min(300, Math.max(10, requestedTimeout)) : DEFAULT_TIMEOUT_SEC;
      const deadlineAt = Date.now() + timeout * 1_000;
      const remainingBudget = (stage: string): number => {
        if (signal?.aborted) throw new Error(`Delegate aborted during ${stage}`);
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) throw new Error(`Delegate timed out after ${timeout}s during ${stage}`);
        return remaining;
      };

      const rawCategory = (params.task_category as TaskCategory) || "summarize";
      const category: TaskCategory = VALID_CATEGORIES.has(rawCategory) ? rawCategory : "summarize";
      const config = loadConfig();
      runtimeCatalogSnapshot = await captureRuntimeCatalog(ctx, runtimeCatalogSnapshot);
      remainingBudget("runtime model refresh");
      const executableCatalog = await getExecutableCatalog(false, Math.min(20_000, remainingBudget("model discovery")), signal);
      remainingBudget("model discovery");
      const discoveredModels = mergeExecutableRuntimeMetadata(executableCatalog.models, runtimeCatalogSnapshot.models);
      const discoveredCandidates = buildModelCandidates(discoveredModels, config);
      const currentModelId = ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const maxTier = getCurrentTier(ctx);
      const requestedModel = typeof params.model === "string" ? params.model.trim() : "";
      const explicitValidation = requestedModel
        ? validateExplicitDelegateModel(requestedModel, discoveredModels, runtimeCatalogSnapshot.models)
        : null;
      const explicitModel = explicitValidation?.model ?? null;

      if (requestedModel && explicitValidation?.error) delegateFailure(explicitValidation.error);
      if (!requestedModel && maxTier === null) {
        const classification = getCurrentClassification(ctx);
        delegateFailure(`Delegate cannot safely auto-select from unclassified current model ${currentModelId || "(none)"}. ${classification?.reason || "No current model metadata is available."} Use a verified explicit model override.`);
      }
      if (!requestedModel && discoveredCandidates.length === 0) {
        const discoveryNote = executableCatalog.lastError ? ` Discovery error: ${executableCatalog.lastError}` : "";
        delegateFailure(`No classified executable Delegate model candidates remain after provider/model exclusions.${discoveryNote}`);
      }

      // Explicit overrides intentionally bypass automatic tier and exclusion policy,
      // but must be exact models that the child Pi CLI can execute.
      const model = requestedModel || selectModel(category, maxTier!, currentModelId, discoveredCandidates);
      if (!model) delegateFailure("Delegate could not select an executable model within the current model tier.");

      // Child capabilities are intentionally narrow: built-ins plus the one
      // explicitly discovered MCP adapter. Workspace add-on extensions are not inherited.
      const mcpPath = findMcpAdapter();
      const requestedProfile = params.tools ? TOOL_PROFILES[params.tools] : TOOL_PROFILES.standard;
      const requestedTools = (requestedProfile || String(params.tools || ""))
        .split(",")
        .map((name: string) => name.trim())
        .filter(Boolean);
      if (requestedProfile && mcpPath) requestedTools.push("mcp");
      const allowedChildTools = new Set(BUILTIN_CHILD_TOOLS);
      if (mcpPath) allowedChildTools.add("mcp");
      const unsupportedTools = requestedTools.filter((name: string) => !allowedChildTools.has(name));
      if (unsupportedTools.length > 0) {
        delegateFailure(`Delegate child cannot load requested tool(s): ${unsupportedTools.join(", ")}. Use Pi built-ins${mcpPath ? " or mcp" : ""}; workspace add-on tools are intentionally not inherited.`);
      }
      const toolsArg = [...new Set(requestedTools)].join(",");

      // Separate files into text (inline in prompt) and binary (pass as @file args)
      let fullPrompt = params.prompt;
      const attachmentArgs: string[] = []; // @file args for binary/image files
      let hasVisualInput = false;

      if (params.files && params.files.length > 0) {
        const textContents: string[] = [];
        for (const filePath of params.files) {
          remainingBudget(`file inspection (${filePath})`);
          let prepared: PreparedDelegateFile;
          try {
            prepared = prepareDelegateFile(filePath);
          } catch (err) {
            delegateFailure(`Failed to inspect ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
          }
          const { resolved, size, inspection } = prepared;
          if (inspection.kind === "unsupported") {
            delegateFailure(`Unsupported Delegate file ${filePath} (${inspection.format}). ${inspection.reason}`);
          }
          if (inspection.kind === "image") {
            // Pi accepts only native PNG, JPEG, GIF, WebP, and BMP attachments.
            attachmentArgs.push(`@${resolved}`);
            hasVisualInput = true;
            continue;
          }
          if (size > MAX_TEXT_FILE_BYTES) {
            delegateFailure(`File too large for inlining: ${filePath} (${(size / 1024).toFixed(0)}KB, max ${MAX_TEXT_FILE_BYTES / 1024}KB). Use the delegate's tools to read it instead.`);
          }
          try {
            const content = readFileSync(resolved, "utf-8");
            textContents.push(`\n--- ${filePath} ---\n${content}\n---`);
          } catch (err) {
            delegateFailure(`Failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (textContents.length > 0) {
          fullPrompt = `${fullPrompt}\n\nFile contents:${textContents.join("\n")}`;
        }
      }

      // Visual inputs require an explicitly vision-capable executable model. For
      // auto-selection, prefer the analyze target tier when the original pick is light.
      let effectiveModel = model;
      let effectiveCategory: TaskCategory = category;
      let eligibleCandidates = discoveredCandidates;
      if (hasVisualInput) {
        if (explicitModel) {
          if (explicitModel.supportsImages === false) {
            delegateFailure(`Delegate model ${explicitModel.fullId} explicitly reports images=no and cannot accept native image attachments.`);
          }
          if (explicitModel.supportsImages !== true) {
            delegateFailure(`Delegate model ${explicitModel.fullId} has no confirmed image-capability metadata; image delegation fails closed.`);
          }
        } else {
          const visualCandidates = discoveredCandidates.filter((candidate) => candidate.supportsImages === true);
          eligibleCandidates = visualCandidates;
          const selectedCandidate = discoveredCandidates.find((candidate) => candidate.id === model);
          if (selectedCandidate?.tier !== undefined && selectedCandidate.tier < 3) effectiveCategory = "analyze";
          effectiveModel = selectModel(effectiveCategory, maxTier!, currentModelId, visualCandidates);
          if (!effectiveModel) {
            const rejected = discoveredCandidates
              .filter((candidate) => candidate.supportsImages !== true)
              .slice(0, 8)
              .map(describeImageCapability)
              .filter(Boolean)
              .join(", ");
            delegateFailure(`No image-capable Delegate model is available within the verified current-model tier.${rejected ? ` Rejected: ${rejected}.` : ""}`);
          }
        }
      }

      // Build static pi args shared across model attempts (the model is set per attempt).
      const staticArgs: string[] = [];
      if (mcpPath) staticArgs.push("-e", mcpPath);
      const capabilityHints = [
        "Web search: run 'bun /workspace/.pi/skills/web-search/web-search.ts --query \"QUERY\" --fetch true --fetch-limit 3' to search the web.",
        "Web search summary: run 'bun /workspace/.pi/skills/web-search-summary/web-search-summary.ts --query \"QUERY\"' for summarized results.",
        ...(mcpPath ? ["MCP: use the mcp tool with action 'call_tool' to call MCP server tools."] : []),
      ].join("\n");
      staticArgs.push("--append-system-prompt", capabilityHints);
      if (params.system_prompt) staticArgs.push("--system-prompt", params.system_prompt);
      for (const att of attachmentArgs) staticArgs.push(att);

      // Ordered models to attempt. An explicit override is used verbatim (no fallback);
      // auto-selection falls back across providers if a model has no usable credentials,
      // so a single keyless provider (e.g. openai-codex) cannot keep breaking delegation.
      const modelChain = requestedModel
        ? [effectiveModel]
        : buildDelegateModelChain(effectiveCategory, maxTier!, currentModelId, eligibleCandidates);
      if (!modelChain.includes(effectiveModel)) modelChain.unshift(effectiveModel);

      // One total deadline covers discovery, setup, and all attempts. Setup/auth/model-unavailable
      // failures may fall back, while execution/protocol failures stop immediately.
      remainingBudget("delegate setup");
      const attemptFailures: Array<{ model: string; kind: DelegateFailureKind; message: string }> = [];
      let lastAttemptedModel = effectiveModel;
      try {
        for (let attempt = 0; attempt < modelChain.length; attempt += 1) {
          const attemptModel = modelChain[attempt];
          lastAttemptedModel = attemptModel;
          const remainingMs = deadlineAt - Date.now();
          if (remainingMs <= 0) throw new Error(`timed out after ${timeout}s`);
          setDelegateProgress(ctx, { model: attemptModel, category, prompt: params.prompt });
          onUpdate?.(result(buildDelegateStatusUpdate(attemptModel, params.prompt), { status: "starting", model: attemptModel, attempt: attempt + 1 }));
          const piArgs = ["--mode", "json", "--no-session", "--no-extensions", "--model", attemptModel, "--tools", toolsArg, ...staticArgs];
          const processResult = await runDelegateProcess(
            piArgs,
            fullPrompt,
            remainingMs,
            signal,
            (progress) => onUpdate?.(result(
              `${buildDelegateStatusUpdate(attemptModel, params.prompt)}\nProgress: ${progress.message}`,
              { status: progress.type, model: attemptModel, attempt: attempt + 1, tool: progress.toolName, is_error: progress.isError },
            )),
          );

          const failureMessage = delegateProcessFailure(processResult);
          if (failureMessage) {
            const kind = classifyDelegateFailure(failureMessage);
            attemptFailures.push({ model: attemptModel, kind, message: failureMessage });
            if (!requestedModel && isRetryableDelegateFailure(kind) && attempt < modelChain.length - 1) continue;
            const chain = attemptFailures.map((failure) => `${failure.model} [${failure.kind}]: ${failure.message}`).join(" -> ");
            delegateFailure(`Delegate failed on ${attemptModel}. Attempt chain: ${chain}`);
          }

          const trimmed = processResult.text.trim();
          const responseWasTruncated = processResult.outputTruncated || trimmed.length > MAX_OUTPUT_CHARS;
          const output = trimmed.length > MAX_OUTPUT_CHARS
            ? `${trimmed.slice(0, MAX_OUTPUT_CHARS)}\n\n[truncated at ${MAX_OUTPUT_CHARS} chars]`
            : trimmed;
          const actualModel = processResult.model
            ? (processResult.model.includes("/") || !processResult.provider ? processResult.model : `${processResult.provider}/${processResult.model}`)
            : attemptModel;
          const fallbackNote = attempt > 0
            ? `\n\n_(auto-fell back to \`${attemptModel}\` after ${attempt} classified setup/model failure${attempt > 1 ? "s" : ""})_`
            : "";
          return result(`**Delegated to \`${attemptModel}\` [${category}]:**\n\n${output}${fallbackNote}`, {
            model: attemptModel,
            actual_model: actualModel,
            response_model: processResult.responseModel,
            category,
            explicit_override: Boolean(requestedModel),
            fallback_count: attempt,
            attempts: [...attemptFailures, { model: attemptModel, status: "success" }],
            stop_reason: processResult.stopReason,
            usage: processResult.usage,
            tool_calls: processResult.toolCallCount,
            output_truncated: responseWasTruncated,
            ephemeral_session: true,
          });
        }
        const chain = attemptFailures.map((failure) => `${failure.model} [${failure.kind}]: ${failure.message}`).join(" -> ");
        delegateFailure(`Delegate exhausted ${modelChain.length} model attempt(s). Attempt chain: ${chain || "none"}`);
      } catch (err: any) {
        if (err?.name === "AbortError" || signal?.aborted) {
          delegateFailure(`Delegate aborted (model: ${lastAttemptedModel}).`);
        }
        if (String(err?.message || err).includes("timed out")) {
          delegateFailure(`Delegate timed out after ${timeout}s (model: ${lastAttemptedModel}).`);
        }
        throw err;
      } finally {
        clearDelegateProgress(ctx);
      }
    },
  });
}

export interface DelegateUsageSummary {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  totalTokens: number;
  cost: number;
}

export interface DelegateProcessProgress {
  type: "text" | "tool_start" | "tool_end" | "retry";
  message: string;
  toolName?: string;
  isError?: boolean;
}

export interface DelegateProcessResult {
  text: string;
  stderr: string;
  exitCode: number | null;
  sessionId: string | null;
  provider: string | null;
  model: string | null;
  responseModel: string | null;
  stopReason: string | null;
  errorMessage: string | null;
  usage: DelegateUsageSummary;
  eventCount: number;
  malformedEventCount: number;
  toolCallCount: number;
  outputTruncated: boolean;
}

export interface DelegateCliOverride {
  command: string;
  argsPrefix?: string[];
}

const MAX_JSON_LINE_CHARS = 2_000_000;
const MAX_JSON_EVENTS = 20_000;
const MAX_STDERR_CHARS = 64_000;
const MAX_PROGRESS_EVENTS = 128;

function emptyDelegateUsage(): DelegateUsageSummary {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: 0 };
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function textFromAssistantMessage(message: any): string {
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("\n");
}

class DelegateJsonAccumulator {
  private finalText = "";
  private provider: string | null = null;
  private model: string | null = null;
  private responseModel: string | null = null;
  private stopReason: string | null = null;
  private errorMessage: string | null = null;
  private sessionId: string | null = null;
  private usage = emptyDelegateUsage();
  private eventCount = 0;
  private malformedEventCount = 0;
  private toolCallCount = 0;
  private outputTruncated = false;
  private streamedTextChars = 0;
  private lastTextProgressAt = 0;
  private progressEvents = 0;
  private capturedAssistantKeys = new Set<string>();

  constructor(private readonly onProgress?: (progress: DelegateProcessProgress) => void) {}

  markProtocolOverflow(): void {
    this.outputTruncated = true;
    this.malformedEventCount += 1;
  }

  private progress(progress: DelegateProcessProgress): void {
    if (!this.onProgress || this.progressEvents >= MAX_PROGRESS_EVENTS) return;
    this.progressEvents += 1;
    this.onProgress(progress);
  }

  private captureAssistant(message: any): void {
    if (message?.role !== "assistant") return;
    const text = textFromAssistantMessage(message);
    const key = typeof message.responseId === "string" && message.responseId
      ? message.responseId
      : `${message.timestamp || ""}|${message.provider || ""}|${message.model || ""}|${message.stopReason || ""}|${text}`;
    if (this.capturedAssistantKeys.has(key)) return;
    this.capturedAssistantKeys.add(key);
    if (text.length > MAX_OUTPUT_CHARS * 2) {
      this.finalText = text.slice(0, MAX_OUTPUT_CHARS * 2);
      this.outputTruncated = true;
    } else {
      this.finalText = text;
    }
    this.provider = typeof message.provider === "string" ? message.provider : this.provider;
    this.model = typeof message.model === "string" ? message.model : this.model;
    this.responseModel = typeof message.responseModel === "string" ? message.responseModel : this.responseModel;
    this.stopReason = typeof message.stopReason === "string" ? message.stopReason : this.stopReason;
    this.errorMessage = typeof message.errorMessage === "string" && message.errorMessage.trim()
      ? message.errorMessage.trim()
      : this.errorMessage;
    const usage = message.usage;
    if (usage && typeof usage === "object") {
      this.usage.input += numeric(usage.input);
      this.usage.output += numeric(usage.output);
      this.usage.cacheRead += numeric(usage.cacheRead);
      this.usage.cacheWrite += numeric(usage.cacheWrite);
      this.usage.reasoning += numeric(usage.reasoning);
      this.usage.totalTokens += numeric(usage.totalTokens);
      this.usage.cost += numeric(usage.cost?.total);
    }
  }

  consumeLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (this.eventCount >= MAX_JSON_EVENTS) {
      this.outputTruncated = true;
      return;
    }
    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      this.malformedEventCount += 1;
      return;
    }
    this.eventCount += 1;
    if (event?.type === "session" && typeof event.id === "string") this.sessionId = event.id;
    if (event?.type === "message_end") this.captureAssistant(event.message);
    if (event?.type === "turn_end") this.captureAssistant(event.message);
    if (event?.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      this.streamedTextChars += String(event.assistantMessageEvent.delta || "").length;
      if (this.streamedTextChars - this.lastTextProgressAt >= 2_000) {
        this.lastTextProgressAt = this.streamedTextChars;
        this.progress({ type: "text", message: `Received ${this.streamedTextChars.toLocaleString()} response characters` });
      }
    }
    if (event?.type === "tool_execution_start") {
      this.toolCallCount += 1;
      const toolName = String(event.toolName || "tool");
      this.progress({ type: "tool_start", toolName, message: `Running ${toolName}` });
    }
    if (event?.type === "tool_execution_end") {
      const toolName = String(event.toolName || "tool");
      this.progress({ type: "tool_end", toolName, isError: Boolean(event.isError), message: `${event.isError ? "Failed" : "Completed"} ${toolName}` });
    }
    if (event?.type === "auto_retry_start") {
      this.progress({ type: "retry", message: `Provider retry ${numeric(event.attempt)}/${numeric(event.maxAttempts)}` });
    }
  }

  result(stderr: string, exitCode: number | null): DelegateProcessResult {
    return {
      text: this.finalText,
      stderr,
      exitCode,
      sessionId: this.sessionId,
      provider: this.provider,
      model: this.model,
      responseModel: this.responseModel,
      stopReason: this.stopReason,
      errorMessage: this.errorMessage,
      usage: this.usage,
      eventCount: this.eventCount,
      malformedEventCount: this.malformedEventCount,
      toolCallCount: this.toolCallCount,
      outputTruncated: this.outputTruncated,
    };
  }
}

export function parseDelegateJsonOutput(output: string): DelegateProcessResult {
  const accumulator = new DelegateJsonAccumulator();
  for (const line of String(output || "").split("\n")) accumulator.consumeLine(line);
  return accumulator.result("", 0);
}

export function delegateProcessFailure(processResult: DelegateProcessResult): string | null {
  const failures: string[] = [];
  if (processResult.exitCode !== 0) failures.push(`Process exited with code ${processResult.exitCode}`);
  if (processResult.eventCount === 0) failures.push("No valid JSON events were emitted");
  if (processResult.malformedEventCount > 0) failures.push(`${processResult.malformedEventCount} malformed JSON event(s)`);
  if (processResult.stopReason === "error" || processResult.stopReason === "aborted") {
    failures.push(`Assistant stopped with ${processResult.stopReason}`);
  }
  if (processResult.errorMessage) failures.push(processResult.errorMessage);
  if (processResult.stderr.trim() && failures.length > 0) failures.push(processResult.stderr.trim());
  if (!processResult.text.trim() && failures.length === 0) failures.push("Delegate returned an empty structured response");
  return failures.length > 0 ? [...new Set(failures)].join("; ") : null;
}

/** Run Pi JSON mode as an ephemeral child process with one deadline and process-tree cleanup. */
export function runDelegateProcess(
  piArgs: string[],
  prompt: string,
  timeoutMs: number,
  signal?: AbortSignal,
  onProgress?: (progress: DelegateProcessProgress) => void,
  cliOverride?: DelegateCliOverride,
): Promise<DelegateProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const resolvedCli = cliOverride ?? resolveDelegateCliCommand();
    const child = nodeSpawn(resolvedCli.command, [...(resolvedCli.argsPrefix ?? []), ...piArgs], {
      cwd: getDelegateWorkspaceRoot(),
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      detached: process.platform !== "win32",
    });
    const accumulator = new DelegateJsonAccumulator(onProgress);
    const decoder = new StringDecoder("utf8");
    let lineBuffer = "";
    let stderr = "";
    let settled = false;
    let terminationError: Error | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let forceSettleTimer: ReturnType<typeof setTimeout> | null = null;

    const appendStderr = (chunk: Buffer) => {
      if (stderr.length >= MAX_STDERR_CHARS) return;
      const remaining = MAX_STDERR_CHARS - stderr.length;
      stderr += chunk.toString().slice(0, remaining);
    };
    const consumeStdout = (chunk: Buffer) => {
      lineBuffer += decoder.write(chunk);
      while (true) {
        const newline = lineBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = lineBuffer.slice(0, newline);
        lineBuffer = lineBuffer.slice(newline + 1);
        if (line.length > MAX_JSON_LINE_CHARS) accumulator.markProtocolOverflow();
        else accumulator.consumeLine(line);
      }
      if (lineBuffer.length > MAX_JSON_LINE_CHARS) {
        lineBuffer = "";
        accumulator.markProtocolOverflow();
      }
    };
    child.stdout?.on("data", consumeStdout);
    child.stderr?.on("data", appendStderr);
    child.stdin?.on("error", () => { /* child exit is handled below */ });

    function cleanup(): void {
      clearTimeout(deadlineTimer);
      if (killTimer) clearTimeout(killTimer);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
      signal?.removeEventListener("abort", onAbort);
    }

    function sendSignal(childSignal: NodeJS.Signals): void {
      if (process.platform !== "win32" && child.pid) {
        try { process.kill(-child.pid, childSignal); return; } catch { /* fall through */ }
      }
      try { child.kill(childSignal); } catch { /* already exited */ }
    }

    function terminate(error: Error): void {
      if (settled || terminationError) return;
      terminationError = error;
      sendSignal("SIGTERM");
      killTimer = setTimeout(() => sendSignal("SIGKILL"), 2_000);
      forceSettleTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }, 5_000);
    }

    const deadlineTimer = setTimeout(() => terminate(new Error(`timed out after ${Math.ceil(timeoutMs / 1000)}s`)), timeoutMs);
    const onAbort = () => {
      const error = new Error("Aborted");
      error.name = "AbortError";
      terminate(error);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    if (!terminationError) {
      child.stdin?.end(prompt);
    }

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      const tail = lineBuffer + decoder.end();
      if (tail.trim()) {
        if (tail.length > MAX_JSON_LINE_CHARS) accumulator.markProtocolOverflow();
        else accumulator.consumeLine(tail);
      }
      cleanup();
      if (terminationError) reject(terminationError);
      else resolvePromise(accumulator.result(stderr, code));
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}

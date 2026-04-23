import { spawnSync } from "node:child_process";

export interface BuildAutoresearchSubagentCommandParams {
  workDir: string;
  model: string;
  extPath: string;
  skillPath: string;
  sessionDir: string;
  prompt: string;
  hasExistingData: boolean;
  bunPath?: string;
  piScriptPath?: string;
}

export interface PiCliModel {
  provider: string;
  id: string;
  label: string;
}

/**
 * Resolve the globally installed pi CLI script path.
 * Falls back to the plain bin name if lookup fails.
 */
export function resolvePiScriptPath(): string {
  const result = spawnSync("which", ["pi"], { encoding: "utf8" });
  if (result.status === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }
  return "pi";
}

export function parsePiCliModelsOutput(stdout: string): PiCliModel[] {
  const models: PiCliModel[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("pi - ") || line.startsWith("Usage:") || line.startsWith("Options:")) continue;
    const match = line.match(/^(\S+)\s+(\S+)\s+/);
    if (!match) continue;
    const provider = match[1];
    const id = match[2];
    if (!provider || !id || provider === "Provider" || id === "Model") continue;
    const label = `${provider}/${id}`;
    if (seen.has(label)) continue;
    seen.add(label);
    models.push({ provider, id, label });
  }
  return models;
}

export function listPiCliModels(options: { bunPath?: string; piScriptPath?: string } = {}): PiCliModel[] {
  const bunPath = options.bunPath || process.execPath || "bun";
  const piScriptPath = options.piScriptPath || resolvePiScriptPath();
  const result = spawnSync(bunPath, [piScriptPath, "--list-models"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return [];
  return parsePiCliModelsOutput(result.stdout);
}

export function hasPiCliModel(requestedModel: string, availableModels: PiCliModel[]): boolean {
  const requested = requestedModel.trim().toLowerCase();
  if (!requested) return true;
  return availableModels.some((model) => model.label.toLowerCase() === requested);
}

/**
 * Build the shell command used inside tmux to launch the autoresearch sub-agent.
 * Uses Bun to execute the pi CLI script directly so the launch does not depend on a
 * separate `node` binary being available inside the runtime container.
 */
export function buildAutoresearchSubagentCommand(params: BuildAutoresearchSubagentCommandParams): string {
  const escapedPrompt = params.prompt.replace(/"/g, '\\"');
  const modelArgs = params.model ? `--model ${JSON.stringify(params.model)}` : "";
  const continueFlag = params.hasExistingData ? "--continue" : "";
  const piInvocation = params.hasExistingData
    ? `"/autoresearch resume the experiment loop — read autoresearch.md for context"`
    : `"/skill:autoresearch-create ${escapedPrompt}"`;

  const bunPath = params.bunPath || process.execPath || "bun";
  const piScriptPath = params.piScriptPath || resolvePiScriptPath();

  return [
    `cd ${JSON.stringify(params.workDir)}`,
    `exec ${JSON.stringify(bunPath)} ${JSON.stringify(piScriptPath)} ${modelArgs} ${continueFlag} --extension ${JSON.stringify(params.extPath)} --skill ${JSON.stringify(params.skillPath)} --session-dir ${JSON.stringify(params.sessionDir)} ${piInvocation}`.replace(/\s+/g, " ").trim(),
  ].join(" && ");
}

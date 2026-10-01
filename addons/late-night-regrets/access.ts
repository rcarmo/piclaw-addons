import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Direct SQLite and nested calls lack an owner-aware host contract; fail closed outside single-user mode. */
export function assertSingleUser(workspace: string): void {
  let text: string;
  try {
    text = readFileSync(join(workspace, ".piclaw", "config.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const config = JSON.parse(text);
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    "access" in config
  )
    throw new Error("Cannot determine access mode");
  for (const value of [config.domains, config.domains?.access]) {
    if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) throw new Error("Cannot determine access mode");
  }
  const mode = config.domains?.access?.mode ?? "single-user";
  if (mode !== "single-user")
    throw new Error(
      "Late Night Regrets direct history review is available only in single-user mode",
    );
}

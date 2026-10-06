import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { packAddon } from "../../../scripts/lib/pack-addon.ts";

test("published M365 archive includes To Do modules, registers tools and imports outside the checkout", async () => {
  const root = resolve(import.meta.dir, "../../.."), addon = resolve(import.meta.dir, "..");
  const temp = mkdtempSync(join(tmpdir(), "m365-packed-"));
  try {
    const archive = join(temp, "m365.tgz"), extracted = join(temp, "addon");
    mkdirSync(extracted);
    packAddon(addon, archive);
    const unpack = Bun.spawnSync(["tar", "xzf", archive, "-C", extracted], { stdout: "pipe", stderr: "pipe" });
    expect(unpack.exitCode).toBe(0);
    expect(existsSync(join(extracted, "todo.ts"))).toBe(true);
    expect(existsSync(join(extracted, "skills/m365-todo/SKILL.md"))).toBe(true);
    expect(readFileSync(join(extracted, "todo.ts"), "utf8")).not.toMatch(/(?:D:\\|D:\/|\/workspace\/|m365-credential-provider)/);
    symlinkSync(join(root, "node_modules"), join(temp, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const mod = await import(pathToFileURL(join(extracted, "index.ts")).href);
    const tools: any[] = [];
    mod.default({ on() {}, registerCommand() {}, registerTool(tool: any) { tools.push(tool); } });
    expect(tools).toHaveLength(28);
    expect(tools.map(t => t.name)).toContain("m365_todo_step");
    await expect(tools.find(t => t.name === "m365_todo_task").execute("test", { action: "create", listId: "synthetic", title: "Never sent" })).rejects.toThrow("approval");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}, 30000);

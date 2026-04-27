import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AUTORESEARCH_SESSION_FILE_NAMES,
  clearAutoresearchSessionFiles,
  prepareDirectAutoresearchWorktree,
} from "./workdir.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

function createTempWorkspace(prefix: string): { workspace: string; cleanup: () => void } {
  const workspace = mkdtempSync(join(tmpdir(), prefix));
  return {
    workspace,
    cleanup: () => rmSync(workspace, { recursive: true, force: true }),
  };
}

function initGitRepo(repoDir: string): void {
  execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Pi Test"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "pi@example.com"], { cwd: repoDir, stdio: "ignore" });
}

function commitAll(repoDir: string, message: string): void {
  execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", message], { cwd: repoDir, stdio: "ignore" });
}

describe("autoresearch workdir helpers", () => {
  test("clearAutoresearchSessionFiles removes session files and prior reports", () => {
    const ws = createTempWorkspace("piclaw-addon-autoresearch-files-");
    cleanups.push(ws.cleanup);

    for (const filename of AUTORESEARCH_SESSION_FILE_NAMES) {
      writeFileSync(join(ws.workspace, filename), `stale:${filename}\n`);
    }
    writeFileSync(join(ws.workspace, "autoresearch-report-old.md"), "old report\n");
    writeFileSync(join(ws.workspace, "keep-me.txt"), "safe\n");

    clearAutoresearchSessionFiles(ws.workspace);

    for (const filename of AUTORESEARCH_SESSION_FILE_NAMES) {
      expect(existsSync(join(ws.workspace, filename))).toBe(false);
    }
    expect(existsSync(join(ws.workspace, "autoresearch-report-old.md"))).toBe(false);
    expect(readFileSync(join(ws.workspace, "keep-me.txt"), "utf8")).toBe("safe\n");
  });

  test("prepareDirectAutoresearchWorktree creates a fresh branch worktree and clears inherited autoresearch files", () => {
    const ws = createTempWorkspace("piclaw-addon-autoresearch-worktree-");
    cleanups.push(ws.cleanup);

    initGitRepo(ws.workspace);
    writeFileSync(join(ws.workspace, "README.md"), "# repo\n");
    writeFileSync(join(ws.workspace, "autoresearch.md"), "stale brief\n");
    writeFileSync(join(ws.workspace, "autoresearch.jsonl"), '{"type":"config","name":"old"}\n');
    commitAll(ws.workspace, "seed repo");

    const sessionDir = join(ws.workspace, "session");
    const prepared = prepareDirectAutoresearchWorktree(ws.workspace, sessionDir, "autoresearch/test-worktree");
    cleanups.push(() => {
      try {
        execFileSync("git", ["-C", prepared.repoRoot, "worktree", "remove", "--force", prepared.worktreeRoot], { stdio: "ignore" });
      } catch (_error) {
        void _error;
      }
    });

    expect(prepared.repoRoot).toBe(ws.workspace);
    expect(prepared.workDir).toBe(prepared.worktreeRoot);
    expect(existsSync(join(prepared.worktreeRoot, ".git"))).toBe(true);
    expect(existsSync(join(prepared.workDir, "README.md"))).toBe(true);
    expect(existsSync(join(prepared.workDir, "autoresearch.md"))).toBe(false);
    expect(existsSync(join(prepared.workDir, "autoresearch.jsonl"))).toBe(false);
  });

  test("prepareDirectAutoresearchWorktree preserves nested project paths inside the fresh worktree", () => {
    const ws = createTempWorkspace("piclaw-addon-autoresearch-subdir-");
    cleanups.push(ws.cleanup);

    initGitRepo(ws.workspace);
    const projectDir = join(ws.workspace, "app");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "index.ts"), "export const ok = true;\n");
    writeFileSync(join(projectDir, "autoresearch.md"), "nested stale brief\n");
    commitAll(ws.workspace, "seed nested repo");

    const sessionDir = join(ws.workspace, "session");
    const prepared = prepareDirectAutoresearchWorktree(projectDir, sessionDir, "autoresearch/test-subdir");
    cleanups.push(() => {
      try {
        execFileSync("git", ["-C", prepared.repoRoot, "worktree", "remove", "--force", prepared.worktreeRoot], { stdio: "ignore" });
      } catch (_error) {
        void _error;
      }
    });

    expect(prepared.workDir).toBe(join(prepared.worktreeRoot, "app"));
    expect(existsSync(join(prepared.workDir, "index.ts"))).toBe(true);
    expect(existsSync(join(prepared.workDir, "autoresearch.md"))).toBe(false);
  });

  test("prepareDirectAutoresearchWorktree error message describes git worktree mode", () => {
    const ws = createTempWorkspace("piclaw-addon-autoresearch-no-git-");
    cleanups.push(ws.cleanup);

    expect(() => prepareDirectAutoresearchWorktree(ws.workspace, join(ws.workspace, "session"), "autoresearch/test-no-git")).toThrow(
      "Git worktree mode requires an existing git repository",
    );
  });
});

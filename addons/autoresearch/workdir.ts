import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** Experiment-session files that should never be inherited from an unrelated prior run. */
export const AUTORESEARCH_SESSION_FILE_NAMES = [
  "autoresearch.md",
  "autoresearch.sh",
  "autoresearch.checks.sh",
  "autoresearch.config.json",
  "autoresearch.jsonl",
  "autoresearch.ideas.md",
  "autoresearch.session.json",
] as const;

/** Prepared git-worktree paths for a git-worktree autoresearch experiment. */
export interface PreparedAutoresearchWorktree {
  /** Resolved git repository root containing the source project. */
  repoRoot: string;
  /** Fresh git worktree root created for this experiment branch. */
  worktreeRoot: string;
  /** Effective project working directory inside the fresh worktree. */
  workDir: string;
  /** Branch name created for the experiment. */
  branchName: string;
}

/**
 * Remove inherited autoresearch session files from a working directory before a fresh launch.
 * @param workDir Working directory where the sub-agent will read/write autoresearch files.
 * @returns Nothing.
 */
export function clearAutoresearchSessionFiles(workDir: string): void {
  for (const filename of AUTORESEARCH_SESSION_FILE_NAMES) {
    rmSync(join(workDir, filename), { force: true, recursive: true });
  }

  for (const entry of readdirSync(workDir)) {
    if (/^autoresearch-report-.*\.md$/i.test(entry)) {
      rmSync(join(workDir, entry), { force: true });
    }
  }
}

/**
 * Create a fresh git worktree + branch for a non-sandbox autoresearch run.
 * @param projectDir Source project directory inside an existing git repository.
 * @param sessionDir Session directory used to hold the experiment worktree.
 * @param branchName Experiment branch name to create.
 * @returns Resolved repo/worktree paths for launching the sub-agent.
 */
export function prepareDirectAutoresearchWorktree(
  projectDir: string,
  sessionDir: string,
  branchName: string,
): PreparedAutoresearchWorktree {
  const resolvedProjectDir = resolve(projectDir);
  let repoRoot = "";
  try {
    repoRoot = execFileSync("git", ["-C", resolvedProjectDir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new Error(`Git worktree mode requires an existing git repository in ${resolvedProjectDir}.`, { cause: error });
  }

  if (!repoRoot || !existsSync(join(repoRoot, ".git"))) {
    throw new Error(`Git worktree mode requires an existing git repository in ${resolvedProjectDir}.`);
  }

  const relativeProjectPath = relative(repoRoot, resolvedProjectDir);
  if (relativeProjectPath.startsWith("..")) {
    throw new Error(`Project directory ${resolvedProjectDir} is not inside git repo ${repoRoot}.`);
  }

  mkdirSync(sessionDir, { recursive: true });
  const worktreeRoot = join(sessionDir, "worktree");
  execFileSync("git", ["-C", repoRoot, "worktree", "add", "-b", branchName, worktreeRoot, "HEAD"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const workDir = relativeProjectPath ? join(worktreeRoot, relativeProjectPath) : worktreeRoot;
  if (!existsSync(workDir)) {
    throw new Error(`Prepared worktree is missing project directory: ${workDir}`);
  }

  clearAutoresearchSessionFiles(workDir);

  return {
    repoRoot,
    worktreeRoot,
    workDir,
    branchName,
  };
}

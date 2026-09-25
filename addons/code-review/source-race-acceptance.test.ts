import { expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { SourceReader } from "./source.js";

const REAL_GIT = ["/usr/bin/git", "/bin/git"].find((path) => existsSync(path));

if (!REAL_GIT) throw new Error("git binary not found");
const gitBinary: string = REAL_GIT;

type RaceTrigger = "before-read" | "after-read";

function writeText(path: string, text: string | Uint8Array) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function fileIdentity(path: string) {
  const st = statSync(path, { bigint: true });
  return `${st.dev}:${st.ino}:${st.birthtimeNs}`;
}

async function rejected(action: Promise<unknown>) {
  try {
    await action;
  } catch (error) {
    return error;
  }
  throw new Error("Expected capture to reject");
}

async function withPathPrefix<T>(prefix: string, action: () => Promise<T>) {
  const previous = process.env.PATH ?? "";
  process.env.PATH = `${prefix}:${previous}`;
  try {
    return await action();
  } finally {
    process.env.PATH = previous;
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "review-source-race-"));
  const repoDir = join(root, "repo");
  const homeDir = join(root, "home");
  const binDir = join(root, "bin");
  const gitConfig = join(root, "gitconfig");

  mkdirSync(repoDir);
  mkdirSync(homeDir);
  mkdirSync(binDir);
  writeFileSync(gitConfig, "");

  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: homeDir,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: gitConfig,
  };
  const git = (...args: string[]) =>
    execFileSync(gitBinary, args, {
      cwd: repoDir,
      env,
      encoding: "utf8",
    }).trim();

  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgSign", "false");
  git("config", "core.autocrlf", "false");

  return {
    root,
    repoDir,
    binDir,
    git,
    reader: new SourceReader(repoDir),
    write(path: string, text: string | Uint8Array) {
      writeText(join(repoDir, path), text);
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function installGitRace(
  root: string,
  binDir: string,
  targetPath: string,
  replacementText: string,
  trigger: RaceTrigger,
) {
  const controlDir = join(root, `control-${trigger}`);
  const marker = join(controlDir, "mutated");
  const log = join(controlDir, "wrapper.log");
  const wrapper = join(binDir, "git");
  mkdirSync(controlDir, { recursive: true });

  writeFileSync(
    wrapper,
    `#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, renameSync, writeFileSync } from "node:fs";

const REAL_GIT = ${JSON.stringify(gitBinary)};
const TARGET = ${JSON.stringify(targetPath)};
const REPLACEMENT = ${JSON.stringify(replacementText)};
const TEMP = ${JSON.stringify(`${targetPath}.${trigger}.tmp`)};
const MARKER = ${JSON.stringify(marker)};
const LOG = ${JSON.stringify(log)};
const TRIGGER = ${JSON.stringify(trigger)};

const args = process.argv.slice(2);
appendFileSync(LOG, JSON.stringify(args) + "\\n");
const result = spawnSync(REAL_GIT, args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});
const verbIndex = args.findIndex((arg) =>
  arg === "rev-parse" ||
  arg === "diff" ||
  arg === "ls-files" ||
  arg === "cat-file",
);
const tail = verbIndex >= 0 ? args.slice(verbIndex) : args;
const hit =
  TRIGGER === "before-read"
    ? tail[0] === "ls-files" && tail[1] === "--stage"
    : tail[0] === "cat-file" && tail[1] === "-s";
if (hit && !existsSync(MARKER)) {
  writeFileSync(TEMP, REPLACEMENT);
  renameSync(TEMP, TARGET);
  writeFileSync(MARKER, "done");
}
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
`,
  );
  chmodSync(wrapper, 0o755);

  return {
    marker,
    log,
    capture<T>(action: () => Promise<T>) {
      return withPathPrefix(binDir, action);
    },
  };
}

test("CR-061 capture never returns a mixed revision under deterministic git and source races", async () => {
  const base = "export const state = 'base';\n";
  const before = "export const state = 'before';\n";
  const after = "export const state = 'after';\n";
  const relativePath = "src/race.ts";

  {
    const f = fixture();
    try {
      f.write(relativePath, base);
      f.git("add", ".");
      f.git("commit", "-qm", "base");
      f.write(relativePath, before);

      const target = join(f.repoDir, relativePath);
      const race = installGitRace(
        f.root,
        f.binDir,
        target,
        after,
        "before-read",
      );
      const capture = await race.capture(() =>
        f.reader.capture({ path: relativePath, mode: "unstaged" }),
      );

      expect(existsSync(race.marker)).toBe(true);
      expect(readFileSync(race.log, "utf8")).toContain('"ls-files"');
      expect(readFileSync(target, "utf8")).toBe(after);
      expect(capture.files).toHaveLength(1);
      expect(capture.files[0]).toMatchObject({
        oldPath: relativePath,
        newPath: relativePath,
        change: "modified",
        oldText: base,
        newText: after,
      });
      expect(capture.files[0]?.fileIdentity).toBe(fileIdentity(target));
    } finally {
      f.cleanup();
    }
  }

  {
    const f = fixture();
    try {
      f.write(relativePath, base);
      f.git("add", ".");
      f.git("commit", "-qm", "base");
      f.write(relativePath, before);

      const target = join(f.repoDir, relativePath);
      const race = installGitRace(
        f.root,
        f.binDir,
        target,
        after,
        "after-read",
      );
      const error = await rejected(
        race.capture(() =>
          f.reader.capture({ path: relativePath, mode: "unstaged" }),
        ),
      );

      expect(existsSync(race.marker)).toBe(true);
      expect(readFileSync(race.log, "utf8")).toContain('"cat-file"');
      expect(readFileSync(target, "utf8")).toBe(after);
      expect(error).toMatchObject({
        code: "changed_during_read",
        status: 409,
      });
      expect((error as Error).message).toContain("changed during capture");
    } finally {
      f.cleanup();
    }
  }

  {
    const f = fixture();
    try {
      f.write(relativePath, before);
      const target = join(f.repoDir, relativePath);
      const ready = join(f.root, "source-race.ready");
      const stop = join(f.root, "source-race.stop");
      const script = join(f.root, "source-race-runner.mjs");
      writeFileSync(
        script,
        `import { existsSync, renameSync, writeFileSync } from "node:fs";
const [target, before, after, ready, stop] = process.argv.slice(2);
writeFileSync(ready, "ready");
let toggle = 0;
while (!existsSync(stop)) {
  const temp = target + ".source-race.tmp";
  writeFileSync(temp, toggle++ % 2 === 0 ? before : after);
  renameSync(temp, target);
}
`,
      );
      const child = spawn(process.execPath, [script, target, before, after, ready, stop], {
        stdio: ["ignore", "ignore", "inherit"],
      });
      try {
        const deadline = Date.now() + 2000;
        while (!existsSync(ready)) {
          if (Date.now() > deadline)
            throw new Error("Timed out starting source race helper");
          await Bun.sleep(10);
        }

        let changedDuringRead = 0;
        let coherent = 0;
        for (let attempt = 0; attempt < 25; attempt += 1) {
          try {
            const capture = await f.reader.capture({
              path: relativePath,
              mode: "source",
            });
            const file = capture.files[0]!;
            expect(file.fileIdentity).toBeTruthy();
            expect(file.newText === before || file.newText === after).toBe(true);
            coherent += 1;
          } catch (error) {
            expect(error).toMatchObject({
              code: "changed_during_read",
              status: 409,
            });
            changedDuringRead += 1;
          }
        }
        expect(coherent + changedDuringRead).toBe(25);
      } finally {
        writeFileSync(stop, "stop");
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("Timed out stopping source race helper"));
          }, 2000);
          child.once("exit", (code, signal) => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Error(`Source race helper exited with ${code ?? signal}`));
          });
          child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
        });
      }
    } finally {
      f.cleanup();
    }
  }
});

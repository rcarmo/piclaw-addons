import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SourceReader } from "./source.js";
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "review-source-"));
  const env = {
    PATH: process.env.PATH!,
    HOME: process.env.HOME!,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      env,
      encoding: "utf8",
    }).trim();
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgSign", "false");
  git("config", "core.autocrlf", "false");
  return {
    dir,
    env,
    git,
    reader: new SourceReader(dir),
    write(path: string, text: string | Uint8Array) {
      writeFileSync(join(dir, path), text);
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("CR-003/004/111/112 saved files are exact UTF8 independent of Git and untouched", async () => {
  const f = fixture();
  try {
    f.write("file.ts", "\uFEFFone\r\ntwo\t😀\r\n");
    const before = readFileSync(join(f.dir, "file.ts"));
    const c = await f.reader.capture({ path: "file.ts", mode: "source" });
    expect(c.files[0]?.newText).toBe(before.toString());
    expect(readFileSync(join(f.dir, "file.ts")).equals(before)).toBe(true);
    expect(c.files[0]?.fileIdentity).toBeTruthy();
    mkdirSync(join(f.dir, "outside"));
    const separate = mkdtempSync(join(tmpdir(), "review-nogit-"));
    try {
      writeFileSync(join(separate, "notes.txt"), "notes");
      const x = await new SourceReader(separate).capture({
        path: "notes.txt",
        mode: "source",
      });
      expect(x.files[0]?.newText).toBe("notes");
      await expect(
        new SourceReader(separate).capture({
          path: "notes.txt",
          mode: "staged",
        }),
      ).rejects.toThrow("unavailable");
    } finally {
      rmSync(separate, { recursive: true, force: true });
    }
  } finally {
    f.cleanup();
  }
});
test("CR-006 staged and unstaged snapshots remain separate and reads do not mutate Git", async () => {
  const f = fixture();
  try {
    f.write("a.ts", "base\n");
    f.git("add", ".");
    f.git("commit", "-qm", "base");
    f.write("a.ts", "staged\n");
    f.git("add", "a.ts");
    f.write("a.ts", "saved\n");
    const before = f.git("status", "--porcelain=v1");
    const index = readFileSync(join(f.dir, ".git/index"));
    const staged = await f.reader.capture({ path: "a.ts", mode: "staged" }),
      unstaged = await f.reader.capture({ path: "a.ts", mode: "unstaged" });
    expect(staged.files[0]).toMatchObject({
      oldText: "base\n",
      newText: "staged\n",
      change: "modified",
    });
    expect(unstaged.files[0]).toMatchObject({
      oldText: "staged\n",
      newText: "saved\n",
    });
    expect(f.git("status", "--porcelain=v1")).toBe(before);
    expect(readFileSync(join(f.dir, ".git/index")).equals(index)).toBe(true);
  } finally {
    f.cleanup();
  }
});
test("CR-007 root commit untracked deletion and rename are represented without checkout", async () => {
  const f = fixture();
  try {
    f.write("a.ts", "root\n");
    f.git("add", ".");
    f.git("commit", "-qm", "root");
    const first = f.git("rev-parse", "HEAD");
    const root = await f.reader.capture({
      path: ".",
      mode: "commit",
      commit: first,
    });
    expect(root.files[0]).toMatchObject({
      oldText: null,
      newText: "root\n",
      change: "added",
    });
    f.git("mv", "a.ts", "renamed.ts");
    const rename = await f.reader.capture({ path: ".", mode: "staged" });
    expect(rename.files[0]).toMatchObject({
      oldPath: "a.ts",
      newPath: "renamed.ts",
      change: "renamed",
    });
    f.git("commit", "-qm", "rename");
    rmSync(join(f.dir, "renamed.ts"));
    f.write("new.ts", "new\n");
    const c = await f.reader.capture({
      path: ".",
      mode: "unstaged",
      includeUntracked: true,
    });
    expect(
      c.files.some((x) => x.change === "deleted" && x.oldText === "root\n"),
    ).toBe(true);
    expect(
      c.files.some((x) => x.change === "added" && x.newPath === "new.ts"),
    ).toBe(true);
    expect(f.git("rev-parse", "HEAD")).not.toBe(first);
  } finally {
    f.cleanup();
  }
});

test("CR-010 unchanged single-file fallback stays stable and empty diffs stay empty", async () => {
  const f = fixture();
  try {
    f.write("a.ts", "same\n");
    f.git("add", ".");
    f.git("commit", "-qm", "base");
    const first = await f.reader.capture({ path: "a.ts", mode: "unstaged" });
    const second = await f.reader.capture({ path: "a.ts", mode: "unstaged" });
    expect(first.files).toHaveLength(1);
    expect(first.files[0]).toMatchObject({
      oldPath: "a.ts",
      newPath: "a.ts",
      change: "unchanged",
      oldText: "same\n",
      newText: "same\n",
    });
    expect(second.files).toEqual(first.files);
    expect(second.base).toBe(first.base);
    expect(second.head).toBe(first.head);
    const empty = await f.reader.capture({ path: ".", mode: "unstaged" });
    expect(empty.files).toEqual([]);
  } finally {
    f.cleanup();
  }
});

test("CR-061 aborts before any source capture work starts", async () => {
  const f = fixture();
  try {
    f.write("a.ts", "base\n");
    const abort = new AbortController();
    abort.abort();
    let error: unknown;
    try {
      await f.reader.capture({ path: "a.ts", mode: "source" }, abort.signal);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ name: "AbortError" });
  } finally {
    f.cleanup();
  }
});

test("CR-064 linked worktrees keep distinct worktree identities", async () => {
  const f = fixture();
  const linked = join(
    tmpdir(),
    `review-linked-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  try {
    f.write("a.ts", "base\n");
    f.git("add", ".");
    f.git("commit", "-qm", "base");
    f.git("worktree", "add", "-q", "--detach", linked, "HEAD");
    const primary = await new SourceReader(f.dir, "workspace-1").capture({
      path: "a.ts",
      mode: "source",
    });
    const secondary = await new SourceReader(linked, "workspace-1").capture({
      path: "a.ts",
      mode: "source",
    });
    expect(primary.workspaceId).toBe("workspace-1");
    expect(secondary.workspaceId).toBe("workspace-1");
    expect(primary.worktreeId).not.toBe(secondary.worktreeId);
    expect(primary.files[0]?.newText).toBe("base\n");
    expect(secondary.files[0]?.newText).toBe("base\n");
  } finally {
    try {
      f.git("worktree", "remove", "-f", linked);
    } catch {}
    rmSync(linked, { recursive: true, force: true });
    f.cleanup();
  }
});

test("CR-081 capture disables Git external helpers", async () => {
  const f = fixture();
  try {
    f.write("a.ts", "base\n");
    f.git("add", ".");
    f.git("commit", "-qm", "base");
    const marker = join(f.dir, "git-helper-marker.txt");
    const helper = join(f.dir, "git-helper.sh");
    writeFileSync(
      helper,
      `#!/bin/sh
printf ran > ${JSON.stringify(marker)}
exit 1
`,
    );
    chmodSync(helper, 0o755);
    f.git("config", "diff.external", helper);
    f.git("config", "core.fsmonitor", helper);
    f.write("a.ts", "changed\n");
    const capture = await f.reader.capture({ path: "a.ts", mode: "unstaged" });
    expect(capture.files[0]).toMatchObject({
      oldText: "base\n",
      newText: "changed\n",
      change: "modified",
    });
    expect(existsSync(marker)).toBe(false);
  } finally {
    f.cleanup();
  }
});
test("CR-009 merge requires an actual selected parent and historical reads preserve checkout", async () => {
  const f = fixture();
  try {
    f.write("base.txt", "base");
    f.git("add", ".");
    f.git("commit", "-qm", "base");
    const main = f.git("branch", "--show-current");
    f.git("checkout", "-qb", "other");
    f.write("other.txt", "other");
    f.git("add", ".");
    f.git("commit", "-qm", "other");
    f.git("checkout", "-q", main);
    f.write("main.txt", "main");
    f.git("add", ".");
    f.git("commit", "-qm", "main");
    f.git("merge", "--no-ff", "-m", "merge", "other");
    const merge = f.git("rev-parse", "HEAD"),
      parent = f.git("rev-parse", "HEAD^1");
    await expect(
      f.reader.capture({ path: ".", mode: "commit", commit: merge }),
    ).rejects.toThrow("Select a merge parent");
    const c = await f.reader.capture({
      path: ".",
      mode: "commit",
      commit: merge,
      parent,
    });
    expect(c.base).toBe(parent);
    expect(c.head).toBe(merge);
    expect(f.git("rev-parse", "HEAD")).toBe(merge);
    expect(f.git("status", "--porcelain")).toBe("");
  } finally {
    f.cleanup();
  }
});
test("CR-081 unsafe input paths invalid UTF-8 content and symlinks are rejected", async () => {
  const f = fixture();
  try {
    f.write("a.ts", "valid");
    f.git("add", ".");
    f.git("commit", "-qm", "base");
    for (const path of ["../escape", "/etc/hosts", "a\0.ts"])
      await expect(
        f.reader.capture({ path, mode: "source" }),
      ).rejects.toThrow();
    symlinkSync("/etc/hosts", join(f.dir, "link"));
    await expect(
      f.reader.capture({ path: "link", mode: "source" }),
    ).rejects.toThrow("symlinks");
    f.write("bad.txt", new Uint8Array([255, 255]));
    await expect(
      f.reader.capture({ path: "bad.txt", mode: "source" }),
    ).rejects.toThrow("UTF-8");
    f.write("binary", new Uint8Array([0, 1, 2]));
    await expect(
      f.reader.capture({ path: "binary", mode: "source" }),
    ).rejects.toThrow("binary");
    await expect(
      f.reader.capture({
        path: ".",
        mode: "commit",
        commit: "--output=/tmp/evil",
      }),
    ).rejects.toThrow("hexadecimal");
    f.git("add", "link");
    await expect(
      f.reader.capture({ path: "link", mode: "staged" }),
    ).rejects.toThrow();
  } finally {
    f.cleanup();
  }
});

test("CR-081 invalid Git path encoding is rejected instead of being remapped", async () => {
  const f = fixture();
  try {
    writeFileSync(
      Buffer.concat([
        Buffer.from(f.dir + "/bad"),
        Buffer.from([0xff]),
        Buffer.from(".txt"),
      ]),
      "bad",
    );
    f.git("add", "-A");
    await expect(
      f.reader.capture({ path: ".", mode: "staged" }),
    ).rejects.toThrow("Git paths must be valid UTF-8");
  } finally {
    f.cleanup();
  }
});

test("CR-091 single-file history follows a verified Git rename across bounded pages without changing checkout", async () => {
  const f = fixture();
  try {
    f.write("old.ts", "first\n");
    f.git("add", "old.ts");
    f.git("commit", "-qm", "first");
    f.write("old.ts", "second\n");
    f.git("add", "old.ts");
    f.git("commit", "-qm", "second");
    f.git("mv", "old.ts", "renamed.ts");
    f.git("commit", "-qm", "rename");
    f.write("renamed.ts", "fourth\n");
    f.git("add", "renamed.ts");
    f.git("commit", "-qm", "fourth");
    const head = f.git("rev-parse", "HEAD");
    const status = f.git("status", "--porcelain=v1");
    expect((await f.reader.history("renamed.ts", 2)).map((row) => row.subject)).toEqual(["fourth", "rename"]);
    const older = await f.reader.history("renamed.ts", 2, 2);
    expect(older.map((row) => row.subject)).toEqual(["second", "first"]);
    expect(older.every((row) => /^[a-f0-9]{40}$/.test(row.commit))).toBe(true);
    expect(f.git("rev-parse", "HEAD")).toBe(head);
    expect(f.git("status", "--porcelain=v1")).toBe(status);
  } finally { f.cleanup(); }
});
test("CR-083 bounded source and explicit history pages", async () => {
  const f = fixture();
  try {
    f.write("a.ts", "small");
    f.git("add", ".");
    f.git("commit", "-qm", "first");
    f.write("a.ts", "new");
    f.git("add", ".");
    f.git("commit", "-qm", "second");
    const rows = await f.reader.history("a.ts", 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.subject).toBe("second");
    expect((await f.reader.history("a.ts", 1, 1))[0]?.subject).toBe("first");
    await expect(f.reader.history("a.ts", 101)).rejects.toThrow(
      "Invalid history",
    );
    f.write("large.txt", "x".repeat(2 * 1024 * 1024 + 1));
    await expect(
      f.reader.capture({ path: "large.txt", mode: "source" }),
    ).rejects.toThrow("byte limit");
  } finally {
    f.cleanup();
  }
});

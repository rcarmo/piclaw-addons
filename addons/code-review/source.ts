import { execFileSync } from "node:child_process";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { devNull } from "node:os";
import { LIMITS, ReviewError, type CaptureFile, type SourceCapture, type SourceMode } from "./contracts.js";
import { hashText, stableJson } from "./validation.js";
export interface CaptureRequest { path: string; mode: SourceMode; commit?: string; parent?: string; includeUntracked?: boolean }
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const inside = (root: string, path: string) => path === root || path.startsWith(root + sep);
export class SourceReader {
  readonly root: string;
  readonly workspaceId: string;
  constructor(workspaceRoot: string, workspaceId?: string) { this.root = realpathSync(workspaceRoot); this.workspaceId = workspaceId ?? hashText(this.root); }
  private path(input: string, allowMissing = false): string {
    if (typeof input !== "string" || !input || input.includes("\0") || input.length > 4096 || isAbsolute(input) || input.split(/[\\/]/).includes("..")) throw new ReviewError("unsafe_path", "Select a workspace-relative path.");
    const absolute = resolve(this.root, input);
    if (!inside(this.root, absolute)) throw new ReviewError("unsafe_path", "Path is outside the workspace.");
    let cursor = this.root;
    for (const part of relative(this.root, absolute).split(sep).filter(Boolean)) {
      cursor = resolve(cursor, part);
      try { const st = lstatSync(cursor); if (st.isSymbolicLink()) throw new ReviewError("unsafe_path", "Source symlinks are not followed."); if (!inside(this.root, realpathSync(cursor))) throw new ReviewError("unsafe_path", "Path escaped the workspace."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissing) return absolute; throw error; }
    }
    return absolute;
  }
  private read(path: string): { text: string; identity: string; stamp: string } {
    const lexical = this.path(relative(this.root, path));
    const fd = openSync(lexical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const st = fstatSync(fd, { bigint: true });
      if (!st.isFile()) throw new ReviewError("unsupported", "Only regular source files can be reviewed.");
      if (st.size > BigInt(LIMITS.fileBytes)) throw new ReviewError("limit", "Source exceeds review byte limit.");
      const bytes = Buffer.alloc(Number(st.size) + 1), count = readSync(fd, bytes, 0, bytes.length, 0);
      const after = fstatSync(fd, { bigint: true });
      const stamp = (v: typeof st) => `${v.dev}:${v.ino}:${v.size}:${v.mtimeNs}:${v.ctimeNs}`;
      if (count !== Number(st.size) || stamp(st) !== stamp(after) || realpathSync(lexical) !== lexical || stamp(statSync(lexical, { bigint: true })) !== stamp(st)) throw new ReviewError("changed_during_read", "Source changed during capture.", 409);
      return { text: this.decode(bytes.subarray(0, count)), identity: `${st.dev}:${st.ino}:${st.birthtimeNs}`, stamp: stamp(st) };
    } finally { closeSync(fd); }
  }
  private decode(bytes: Uint8Array): string {
    if (bytes.byteLength > LIMITS.fileBytes || bytes.includes(0)) throw new ReviewError("unsupported", "Source is binary or exceeds the byte limit.");
    let text: string; try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new ReviewError("unsupported", "Source must be valid UTF-8."); }
    if (text.split(/\r\n|\n|\r/).length > LIMITS.fileLines) throw new ReviewError("limit", "Source exceeds line limit."); return text;
  }
  private git(cwd: string, args: string[], signal?: AbortSignal): Buffer {
    signal?.throwIfAborted();
    try {
      return execFileSync("git", ["--no-pager", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=" + devNull, "-c", "diff.external=", "-c", "core.quotePath=false", ...args], { cwd, timeout: 5000, maxBuffer: LIMITS.captureBytes + 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH || "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_LITERAL_PATHSPECS: "1", LC_ALL: "C", LANG: "C" } });
    } catch { throw new ReviewError("git_failed", "Git could not read the selected bounded revision or path."); }
  }
  private repository(path: string): string | null {
    let dir = path;
    while (true) {
      try { if (!statSync(dir).isDirectory()) dir = dirname(dir); else break; } catch { dir = dirname(dir); }
      if (!inside(this.root, dir)) return null;
    }
    try { const root = realpathSync(this.git(dir, ["rev-parse", "--show-toplevel"]).toString().trim()); if (!inside(this.root, root)) throw new ReviewError("unsafe_path", "Repository root is outside the workspace."); return root; }
    catch (error) { if (error instanceof ReviewError && error.code === "unsafe_path") throw error; return null; }
  }
  private object(repo: string, value: string, kind: "commit" | "tree" = "commit"): string {
    if (!/^[a-f0-9]{7,64}$/i.test(value)) throw new ReviewError("invalid_revision", "Select an explicit hexadecimal Git object ID.");
    const result = this.git(repo, ["rev-parse", "--verify", "--end-of-options", `${value}^{${kind}}`]).toString().trim();
    if (!/^[a-f0-9]{40,64}$/.test(result)) throw new ReviewError("invalid_revision", "Invalid Git revision."); return result;
  }
  private blob(repo: string, oid: string, mode: string): string | null {
    if (/^0+$/.test(oid) || mode === "000000") return null;
    if (!/^100(644|755)$/.test(mode)) throw new ReviewError("unsupported", "Git symlinks and submodules cannot be reviewed as text.");
    const size = Number(this.git(repo, ["cat-file", "-s", oid]).toString());
    if (!Number.isSafeInteger(size) || size > LIMITS.fileBytes) throw new ReviewError("limit", "Git source exceeds byte limit.");
    return this.decode(this.git(repo, ["cat-file", "blob", oid]));
  }
  async capture(input: CaptureRequest, signal?: AbortSignal): Promise<SourceCapture> {
    if (!["source", "unstaged", "staged", "commit"].includes(input.mode)) throw new ReviewError("invalid_input", "Unknown source mode.");
    const absolute = this.path(input.path, input.mode !== "source"), repo = this.repository(absolute);
    const deadline=Date.now()+15_000;
    const result: SourceCapture = { workspaceId: this.workspaceId, worktreeId: hashText(repo ? realpathSync(repo) : this.root), mode: input.mode, base: null, head: null, capturedAt: new Date().toISOString(), files: [] };
    if (input.mode === "source") { const file = this.read(absolute); result.files.push({ oldPath: null, newPath: relative(this.root, absolute).split(sep).join("/"), change: "source", oldText: null, newText: file.text, fileIdentity: file.identity }); return result; }
    if (!repo) throw new ReviewError("no_git", "Git history is unavailable for this file.");
    const scope = relative(repo, absolute).split(sep).join("/") || ".";
    let head: string | null = null;
    try { head = this.git(repo, ["rev-parse", "--verify", "HEAD"]).toString().trim(); } catch { /* unborn branch */ }
    let base = head ?? EMPTY_TREE, destination: string | null = null;
    if (input.mode === "commit") {
      if (!input.commit) throw new ReviewError("invalid_revision", "Select a commit."); destination = this.object(repo, input.commit);
      const parents = this.git(repo, ["rev-list", "--parents", "-n", "1", destination]).toString().trim().split(/\s+/).slice(1);
      if (parents.length > 1 && !input.parent) throw new ReviewError("parent_required", "Select a merge parent.");
      base = input.parent ? this.object(repo, input.parent) : parents[0] ?? EMPTY_TREE;
      if (parents.length && !parents.includes(base)) throw new ReviewError("invalid_revision", "Selected base is not a parent of this commit.");
      if (!parents.length && input.parent) throw new ReviewError("invalid_revision", "Root commits compare against the empty tree.");
    }
    const args = ["diff", "--raw", "--no-abbrev", "-z", "-M", "--no-ext-diff", "--no-textconv", ...(input.mode === "staged" ? ["--cached", base] : input.mode === "commit" ? [base, destination!] : []), "--", scope];
    const raw = this.git(repo, args, signal), fields = raw.toString().split("\0");
    const indexBefore = input.mode !== "commit" ? this.git(repo, ["ls-files", "--stage", "-z", "--", scope]) : null;
    const stamps = new Map<string, string>();let totalBytes=0;
    for (let n = 0; n < fields.length && fields[n];) {
      signal?.throwIfAborted();if(Date.now()>deadline)throw new ReviewError('limit','Source capture exceeded its time budget.');
      const match = /^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) ([A-Z])\d*$/.exec(fields[n++]!);
      if (!match) throw new ReviewError("unsupported", "Unsupported Git change record.");
      const [, oldMode, newMode, oldOid, newOid, kind] = match; const oldRel = fields[n++]!; const newRel = kind === "R" || kind === "C" ? fields[n++]! : oldRel;
      if (!["A", "D", "M", "R"].includes(kind!)) throw new ReviewError("unsupported", "Unmerged, copied or special changes require a supported comparison.");
      const oldPath = relative(this.root, resolve(repo, oldRel)).split(sep).join("/"), newPath = relative(this.root, resolve(repo, newRel)).split(sep).join("/");
      this.path(oldPath, true); this.path(newPath, true);
      let newText: string | null = null, fileIdentity: string | null = null;
      if (kind !== "D") {
        if (input.mode === "unstaged") { if (!/^100(644|755)$/.test(newMode!)) throw new ReviewError("unsupported", "Non-regular changed file."); const file = this.read(resolve(repo, newRel)); newText = file.text; fileIdentity = file.identity; stamps.set(newPath, file.stamp); }
        else newText = this.blob(repo, newOid!, newMode!);
      }
      const oldText=this.blob(repo,oldOid!,oldMode!);totalBytes+=Buffer.byteLength(oldText??'')+Buffer.byteLength(newText??'');if(totalBytes>LIMITS.captureBytes)throw new ReviewError('limit','Capture exceeds total byte limit.');
      result.files.push({ oldPath: kind === "A" ? null : oldPath, newPath: kind === "D" ? null : newPath, change: kind === "A" ? "added" : kind === "D" ? "deleted" : kind === "R" ? "renamed" : "modified", oldText, newText, fileIdentity });
      if (result.files.length > LIMITS.captureFiles) throw new ReviewError("limit", "Too many changed files.");
    }
    let untracked: Buffer | null = null;
    if (input.mode === "unstaged" && input.includeUntracked) {
      untracked = this.git(repo, ["ls-files", "--others", "--exclude-standard", "-z", "--", scope]);
      for (const path of untracked.toString().split("\0").filter(Boolean)) {
        signal?.throwIfAborted();if(Date.now()>deadline)throw new ReviewError('limit','Source capture exceeded its time budget.');
        const full = resolve(repo, path), display = relative(this.root, full).split(sep).join("/"); const file = this.read(full); stamps.set(display, file.stamp);
        totalBytes+=Buffer.byteLength(file.text);if(totalBytes>LIMITS.captureBytes)throw new ReviewError('limit','Capture exceeds total byte limit.');
        result.files.push({ oldPath: null, newPath: display, change: "added", oldText: null, newText: file.text, fileIdentity: file.identity });
        if (result.files.length > LIMITS.captureFiles) throw new ReviewError("limit", "Too many changed files.");
      }
    }
    if (input.mode !== "commit") {
      if (!raw.equals(this.git(repo, args, signal)) || !indexBefore!.equals(this.git(repo, ["ls-files", "--stage", "-z", "--", scope]))) throw new ReviewError("changed_during_read", "Git state changed during capture.", 409);
      for (const [path, stamp] of stamps) if (this.read(resolve(this.root, path)).stamp !== stamp) throw new ReviewError("changed_during_read", "Saved source changed during capture.", 409);
      if (untracked && !untracked.equals(this.git(repo, ["ls-files", "--others", "--exclude-standard", "-z", "--", scope]))) throw new ReviewError("changed_during_read", "Untracked files changed during capture.", 409);
    }
    const bytes = result.files.reduce((sum, f) => sum + Buffer.byteLength(f.oldText ?? "") + Buffer.byteLength(f.newText ?? ""), 0);
    if (bytes > LIMITS.captureBytes) throw new ReviewError("limit", "Capture exceeds total byte limit.");
    result.base = input.mode === "unstaged" ? `index:${hashText(indexBefore!.toString())}` : base;
    result.head = input.mode === "commit" ? destination : `${input.mode === "staged" ? "index" : "saved"}:${hashText(stableJson(result.files))}`;
    return result;
  }
  async history(path: string, limit = 30, skip = 0) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(skip) || skip < 0 || skip > 10000) throw new ReviewError("invalid_input", "Invalid history page.");
    const full = this.path(path, true), repo = this.repository(full); if (!repo) return [];
    const output = this.git(repo, ["log", `--max-count=${limit}`, `--skip=${skip}`, "--format=%H%x00%P%x00%at%x00%s%x00", "--", relative(repo, full)]).toString();
    const fields = output.split("\0"), rows = [];
    for (let n = 0; n + 3 < fields.length; n += 4) { const oid = fields[n]!.trim(); if (!oid) continue; rows.push({ commit: oid, parents: fields[n+1]!.split(" ").filter(Boolean), timestamp: Number(fields[n+2]) * 1000, subject: fields[n+3]!.slice(0, 512) }); } return rows;
  }
}

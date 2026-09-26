import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { posix } from "node:path";
import { Database } from "bun:sqlite";
import { assertBackupPaths } from "./repository.ts";
import type { BackupSource, StageManifest, StageResult } from "./contracts.ts";

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "utf8");
const COPY_CHUNK_SIZE = 1024 * 1024;
const MANIFEST_NAME = ".restic-manifest.json";
const OWNER_NAME = ".restic-stage-owner";
const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return new DOMException("Aborted", "AbortError");
}
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}
function ensureAbsolute(path: string, label: string): string {
  if (!path || !isAbsolute(path) || normalize(path) !== path) throw new Error(`Restic ${label} must be an absolute path`);
  return path;
}
function ensureSourceName(name: string): string {
  if (!name || name !== name.trim() || /[\x00-\x1f\x7f/\\]/.test(name) || name === "." || name === ".." || name === MANIFEST_NAME || name === OWNER_NAME) {
    throw new Error("Restic source name is invalid");
  }
  return name;
}
function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
function ensurePathWithin(root: string, target: string): void {
  if (!contains(root, target)) throw new Error("Restic path escapes restore root");
}
function normalizeRelativePath(path: string): string {
  if (!path || path.startsWith("/") || path.includes("\\") || posix.normalize(path) !== path) throw new Error("Restic manifest path is invalid");
  const parts = path.split("/");
  if (parts.some(part => !part || part === "." || part === "..")) throw new Error("Restic manifest path is invalid");
  return path;
}
function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function hashSymlinkTarget(target: string): string {
  return createHash("sha256").update("symlink\0").update(target).digest("hex");
}
async function hasSqliteHeader(path: string): Promise<boolean> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(SQLITE_HEADER.length);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead === SQLITE_HEADER.length && buffer.equals(SQLITE_HEADER);
  } finally {
    await handle.close();
  }
}
function removeSqliteSidecars(path: string): void {
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) rmSync(`${path}${suffix}`, { force: true });
}
function runQuickCheck(path: string): void {
  const db = new Database(path, { readonly: true });
  try {
    const rows = db.query("PRAGMA quick_check").all() as Array<Record<string, string>>;
    if (!rows.length || rows.some(row => Object.values(row)[0] !== "ok")) throw new Error("Restic SQLite quick_check failed");
  } finally {
    db.close();
    removeSqliteSidecars(path);
  }
}
async function hashRegularFile(path: string, signal?: AbortSignal): Promise<string> {
  const handle = await open(path, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(COPY_CHUNK_SIZE);
  try {
    while (true) {
      throwIfAborted(signal);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}
async function copyRegularFile(source: string, destination: string, mode: number, signal?: AbortSignal): Promise<string> {
  const expected=await lstat(source);
  const sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  const actual=await sourceHandle.stat();
  if(expected.dev!==actual.dev||expected.ino!==actual.ino){await sourceHandle.close();throw Error("Source changed while opening");}
  if(!(await sourceHandle.stat()).isFile()){await sourceHandle.close();throw Error("Source is not a regular file");}
  const destinationHandle = await open(destination, "w", mode);
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(COPY_CHUNK_SIZE);
  try {
    while (true) {
      throwIfAborted(signal);
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      let written=0;while(written<chunk.length){const result=await destinationHandle.write(chunk.subarray(written));written+=result.bytesWritten;}
    }
    return hash.digest("hex");
  } finally {
    await destinationHandle.close();
    await sourceHandle.close();
  }
}
async function snapshotSqlite(source: string, destination: string, mode: number): Promise<string> {
  // SQLITE_OPEN_READONLY | SQLITE_OPEN_NOFOLLOW rejects final symlink substitution.
  const expected=await lstat(source);
  if(expected.isSymbolicLink())throw Error("SQLite source is a symlink");
  const db = new Database(source, 0x1 | 0x01000000);
  try {
    const bytes = db.serialize();
    const after=await lstat(source);
    if(after.isSymbolicLink()||expected.dev!==after.dev||expected.ino!==after.ino)throw Error("SQLite source changed during snapshot");
    // Standalone snapshots must not require WAL/SHM files when reopened.
    bytes[18] = 1; bytes[19] = 1;
    await writeFile(destination, bytes, { mode });
    await chmod(destination, mode);
    runQuickCheck(destination);
    return hashBytes(bytes);
  } finally {
    db.close();
  }
}
async function isSqliteSidecar(path: string): Promise<boolean> {
  const suffix = SQLITE_SIDECAR_SUFFIXES.find(candidate => path.endsWith(candidate));
  if (!suffix) return false;
  const base = path.slice(0, -suffix.length);
  if (!existsSync(base)) return false;
  const stat = lstatSync(base);
  return stat.isFile() && await hasSqliteHeader(base);
}
function compileExcludes(patterns: string[]): Bun.Glob[] {
  return patterns.map(pattern => new Bun.Glob(pattern));
}
function excluded(globs: Bun.Glob[], sourceName: string, relativePath: string): boolean {
  return globs.some(glob => glob.match(relativePath) || glob.match(`${sourceName}/${relativePath}`));
}
function manifestToFilesystemPath(root: string, manifestPath: string): string {
  return join(root, ...manifestPath.split("/"));
}
function ensureRestoreAncestors(root: string, fullPath: string): void {
  const rel = relative(root, fullPath);
  if (!rel) return;
  let current = root;
  for (const part of rel.split(sep).slice(0, -1)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error("Restic restore path crosses a symlink");
    if (!stat.isDirectory()) throw new Error("Restic restore ancestor is not a directory");
  }
}
function resolveSymlinkWithinRoot(root: string, fullPath: string, depth = 0): string {
  if (depth > 40) throw new Error("Restic restore symlink depth exceeded");
  ensurePathWithin(root, fullPath);
  if (!existsSync(fullPath)) return fullPath;
  ensureRestoreAncestors(root, fullPath);
  const stat = lstatSync(fullPath);
  if (stat.isSymbolicLink()) {
    const linkTarget = readlinkSync(fullPath);
    if (linkTarget.startsWith("/")) throw new Error("Restic restore symlink escapes root");
    const next = resolve(dirname(fullPath), linkTarget);
    ensurePathWithin(root, next);
    return resolveSymlinkWithinRoot(root, next, depth + 1);
  }
  if (!stat.isDirectory() && !stat.isFile()) throw new Error("Restic restore contains unsupported file type");
  return fullPath;
}
async function collectActualEntries(root: string): Promise<Set<string>> {
  const entries = new Set<string>();
  async function walk(current: string, relativePath = ""): Promise<void> {
    const listing = await readdir(current, { withFileTypes: true });
    listing.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of listing) {
      const childRelative = relativePath ? posix.join(relativePath, entry.name) : entry.name;
      const childPath = join(current, entry.name);
      if (!relativePath && (entry.name === MANIFEST_NAME || entry.name === OWNER_NAME)) continue;
      if (entry.isDirectory()) {
        await walk(childPath, childRelative);
        continue;
      }
      if (entry.isFile() || entry.isSymbolicLink()) {
        entries.add(childRelative);
        continue;
      }
      throw new Error("Restic restore contains unsupported file type");
    }
  }
  await walk(root);
  return entries;
}

/** Preserve only relative symlinks whose resolved target stays inside the same source root. */
export async function stageSources(sources: BackupSource[], directory: string, excludes: string[], signal?: AbortSignal): Promise<StageResult> {
  if (!sources.length) throw new Error("Restic backup source is required");
  const stageDirectory = ensureAbsolute(directory, "staging directory");
  const prepared: BackupSource[] = [];
  const seenNames = new Set<string>();
  for (const source of sources) {
    const name = ensureSourceName(source.name);
    if (seenNames.has(name)) throw new Error("Restic source name must be unique");
    seenNames.add(name);
    const sourcePath = ensureAbsolute(source.path, "backup source path");
    const stat = await lstat(sourcePath);
    if (!stat.isDirectory()) throw new Error("Restic backup source must be an existing directory");
    if(realpathSync(sourcePath)!==sourcePath)throw Error("Backup source must use its canonical path");
    prepared.push({ name, path: sourcePath });
  }
  assertBackupPaths(prepared.map(source => source.path), [stageDirectory]);
  if (existsSync(stageDirectory)) throw new Error("Restic staging directory already exists");

  const ownerToken = randomUUID();
  const ownerPath = join(stageDirectory, OWNER_NAME);
  const globs = compileExcludes(excludes);
  let created = false;
  const ownedCleanup = () => {
    if (!created || !existsSync(stageDirectory) || !existsSync(ownerPath)) return;
    try {
      const token = readFileSync(ownerPath, "utf8");
      if (token === ownerToken) rmSync(stageDirectory, { recursive: true, force: true });
    } catch {
      /* cleanup is best-effort and must never remove unowned directories */
    }
  };

  try {
    throwIfAborted(signal);
    await mkdir(stageDirectory, { recursive: false, mode: 0o700 });
    created = true;
    await writeFile(ownerPath, ownerToken, { mode: 0o600 });
    const manifest: StageManifest = { version: 1, sources: prepared.map(source => ({ name: source.name, path: source.path })), files: [] };

    for (const source of prepared) {
      throwIfAborted(signal);
      const stagedSourceRoot = join(stageDirectory, source.name);
      await mkdir(stagedSourceRoot, { recursive: false, mode: 0o700 });

      async function walk(currentSourcePath: string, currentStagePath: string, currentRelativePath = ""): Promise<void> {
        throwIfAborted(signal);
        const currentStat = await lstat(currentSourcePath);
        if (!currentStat.isDirectory()) throw new Error("Restic backup source directory changed during staging");
        const listing = await readdir(currentSourcePath, { withFileTypes: true });
        listing.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of listing) {
          throwIfAborted(signal);
          const childSourcePath = join(currentSourcePath, entry.name);
          const childStagePath = join(currentStagePath, entry.name);
          const childRelativePath = currentRelativePath ? posix.join(currentRelativePath, entry.name) : entry.name;
          if (excluded(globs, source.name, childRelativePath)) continue;

          ensureRestoreAncestors(source.path,childSourcePath);
          if (entry.isDirectory()) {
            const childStat = await lstat(childSourcePath);
            if(!childStat.isDirectory()||childStat.isSymbolicLink())throw Error("Source directory changed");
            await mkdir(childStagePath, { recursive: false, mode: childStat.mode & 0o777 });
            await walk(childSourcePath, childStagePath, childRelativePath);
            continue;
          }
          if (entry.isSymbolicLink()) {
            const linkTarget = await readlink(childSourcePath);
            if (linkTarget.startsWith("/")) throw new Error("Restic only preserves relative symlinks inside the same source");
            const resolvedTarget = resolve(dirname(childSourcePath), linkTarget);
            if (!contains(source.path, resolvedTarget)) throw new Error("Restic only preserves symlinks that stay inside the same source");
            if(existsSync(resolvedTarget)&&!contains(realpathSync(source.path),realpathSync(resolvedTarget)))throw Error("Restic source symlink escapes root");
            await symlink(linkTarget, childStagePath);
            manifest.files.push({ path: posix.join(source.name, childRelativePath), sha256: hashSymlinkTarget(linkTarget), sqlite: false });
            continue;
          }

          const childStat = await lstat(childSourcePath);
          if(childStat.isSymbolicLink())throw Error("Source changed to a symlink");
          if (!childStat.isFile()) {
            if (await isSqliteSidecar(childSourcePath)) continue;
            throw new Error("Restic staging does not support sockets or special files");
          }
          if (await isSqliteSidecar(childSourcePath)) continue;

          const manifestPath = posix.join(source.name, childRelativePath);
          const mode = childStat.mode & 0o777;
          if (await hasSqliteHeader(childSourcePath)) {
            const sha256 = await snapshotSqlite(childSourcePath, childStagePath, mode);
            manifest.files.push({ path: manifestPath, sha256, sqlite: true });
          } else {
            const sha256 = await copyRegularFile(childSourcePath, childStagePath, mode, signal);
            manifest.files.push({ path: manifestPath, sha256, sqlite: false });
          }
        }
      }

      await walk(source.path, stagedSourceRoot);
    }

    if(!manifest.files.length)throw Error("Backup source/exclusions produced no files");
    manifest.files.sort((a, b) => a.path.localeCompare(b.path));
    await writeFile(join(stageDirectory, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    return { directory: stageDirectory, manifest, cleanup: ownedCleanup };
  } catch (error) {
    ownedCleanup();
    throw error;
  }
}

export async function verifyRestore(directory: string): Promise<{ files: number; databases: number }> {
  const root = ensureAbsolute(directory, "restore directory");
  if(lstatSync(root).isSymbolicLink()||realpathSync(root)!==root)throw Error("Restic restore root must be a real directory");
  const manifestPath = join(root, MANIFEST_NAME);
  if(existsSync(manifestPath)&&lstatSync(manifestPath).isSymbolicLink())throw Error("Restic manifest must be a regular file");
  if (!existsSync(manifestPath)) throw new Error("Restic restore manifest is missing");
  const raw = JSON.parse(await readFile(manifestPath, "utf8")) as StageManifest;
  if (raw.version !== 1 || !Array.isArray(raw.sources) || !Array.isArray(raw.files)) throw new Error("Restic restore manifest is invalid");

  for (const source of raw.sources) {
    if (!source || typeof source.name !== "string" || typeof source.path !== "string") throw new Error("Restic restore manifest is invalid");
    ensureSourceName(source.name);
    ensureAbsolute(source.path, "source path");
  }

  const actualEntries = await collectActualEntries(root);
  const seen = new Set<string>();
  let databases = 0;
  for (const entry of raw.files) {
    if (!entry || typeof entry.path !== "string" || typeof entry.sha256 !== "string" || typeof entry.sqlite !== "boolean") throw new Error("Restic restore manifest is invalid");
    const manifestEntryPath = normalizeRelativePath(entry.path);
    if (seen.has(manifestEntryPath)) throw new Error("Restic restore manifest has duplicate paths");
    seen.add(manifestEntryPath);
    if (!actualEntries.has(manifestEntryPath)) throw new Error("Restic restore manifest does not match files on disk");

    const fullPath = manifestToFilesystemPath(root, manifestEntryPath);
    ensurePathWithin(root, fullPath);
    ensureRestoreAncestors(root, fullPath);
    const stat = lstatSync(fullPath);
    if (stat.isSymbolicLink()) {
      if (entry.sqlite) throw new Error("Restic restore manifest mismatches a symlink");
      const linkTarget = await readlink(fullPath);
      if (linkTarget.startsWith("/")) throw new Error("Restic restore symlink escapes root");
      const resolved = resolve(dirname(fullPath), linkTarget);
      ensurePathWithin(root, resolved);
      resolveSymlinkWithinRoot(root, resolved);
      if (hashSymlinkTarget(linkTarget) !== entry.sha256) throw new Error("Restic restore hash mismatch");
      continue;
    }
    if (!stat.isFile()) throw new Error("Restic restore contains unsupported file type");

    const sqlite = await hasSqliteHeader(fullPath);
    if (sqlite !== entry.sqlite) throw new Error("Restic restore manifest mismatches SQLite detection");
    if (sqlite) {
      runQuickCheck(fullPath);
      databases += 1;
    }
    const sha256 = await hashRegularFile(fullPath);
    if (sha256 !== entry.sha256) throw new Error("Restic restore hash mismatch");
  }

  for (const actualEntry of actualEntries) {
    if (!seen.has(actualEntry)) throw new Error("Restic restore contains files not declared in the manifest");
  }
  return { files: raw.files.length, databases };
}

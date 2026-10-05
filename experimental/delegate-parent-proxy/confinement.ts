import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdirSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative } from 'node:path';
import { ProxyError } from './contracts.ts';

export interface ApprovedFileExport {
  /** Host-approved exact regular file, never a child-selected path. No directory grants. */
  source: string;
  /** Host-owned private export directory. Files must be inside it, not arbitrary live paths. */
  exportRoot: string;
  /** Relative path inside /work. */
  target: string;
  sha256: string;
}
export interface ApprovedRuntimeFile { source: string; target: string; sha256: string; executable?: boolean; }
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function target(value: string) {
  if (!value || isAbsolute(value) || normalize(value) !== value || value.split('/').some(p => !p || p === '.' || p === '..') || value.includes('\0')) throw new ProxyError('UNSUPPORTED_PLAN');
  return value;
}
function descriptorBytes(fd: number, expected: string, maxBytes: number, runtime: boolean): Buffer {
    if (!/^[a-f0-9]{64}$/.test(expected)) throw new ProxyError('UNSUPPORTED_PLAN');
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > maxBytes || !runtime && (before.nlink !== 1 || before.uid !== process.getuid?.() || (before.mode & 0o022))) throw new ProxyError('UNSUPPORTED_PLAN');
    const buffer = Buffer.alloc(before.size + 1); let count = 0, read = 0;
    while (count < buffer.length && (read = readSync(fd, buffer, count, buffer.length - count, null)) > 0) count += read;
    const bytes = buffer.subarray(0, count), after = fstatSync(fd);
    if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || hash(bytes) !== expected) throw new ProxyError('UNSUPPORTED_PLAN');
    return bytes;
}
function snapshot(source: string, expected: string, maxBytes: number, runtime: boolean): Buffer {
  if (!isAbsolute(source) || realpathSync(source) !== source) throw new ProxyError('UNSUPPORTED_PLAN');
  const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { return descriptorBytes(fd, expected, maxBytes, runtime); } finally { closeSync(fd); }
}
/** Open each directory relative to its predecessor descriptor. Renaming an
 * ancestor cannot redirect this walk; symbolic directory components are denied. */
function directory(path: string): number {
  if (!isAbsolute(path) || normalize(path) !== path) throw new ProxyError('UNSUPPORTED_PLAN');
  let fd = openSync('/', constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (const part of path.split('/').filter(Boolean)) {
      const next = openSync(`/proc/self/fd/${fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      closeSync(fd); fd = next;
    }
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}
function exportedBytes(file: ApprovedFileExport, afterOpen?: () => void): Buffer {
  const rel = relative(file.exportRoot, file.source);
  if (!rel || rel.startsWith('../') || isAbsolute(rel) || normalize(file.source) !== file.source) throw new ProxyError('UNSUPPORTED_PLAN');
  let fd = directory(file.exportRoot);
  try {
    const root = fstatSync(fd);
    if (root.uid !== process.getuid?.() || (root.mode & 0o077)) throw new ProxyError('UNSUPPORTED_PLAN');
    afterOpen?.();
    const parts = rel.split('/');
    for (const part of parts.slice(0, -1)) {
      const next = openSync(`/proc/self/fd/${fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      closeSync(fd); fd = next;
      const st = fstatSync(fd);
      if (st.uid !== process.getuid?.() || (st.mode & 0o022)) throw new ProxyError('UNSUPPORTED_PLAN');
    }
    const source = openSync(`/proc/self/fd/${fd}/${parts.at(-1)}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { return descriptorBytes(source, file.sha256, 16 * 1024 * 1024, false); } finally { closeSync(source); }
  } finally { closeSync(fd); }
}

/** Build only private copied regular files. No bind of /workspace, HOME, /run,
 * /etc or host proc. Grants and runtime hashes must come from the trusted host. */
export function stageConfinement(input: {
  profile: 'read_only' | 'workspace_write';
  runtime: readonly ApprovedRuntimeFile[];
  files: readonly ApprovedFileExport[];
}, testHooks: { afterExportRootOpened?: () => void } = {}): { root: string; dispose(): void } {
  if (process.platform !== 'linux' || process.arch !== 'x64' || !['read_only','workspace_write'].includes(input.profile)
    || input.runtime.length > 128 || input.files.length > 256) throw new ProxyError('UNSUPPORTED_PLAN');
  const root = mkdtempSync(join(tmpdir(), 'delegate-confined-'));
  try {
    for (const path of ['dev', 'proc', 'home', 'tmp', 'work', 'app', 'bin', 'usr/bin', 'lib', 'lib64', 'etc']) mkdirSync(join(root, path), { recursive: true, mode: 0o700 });
    for (const path of ['null','zero','urandom','random']) writeFileSync(join(root,'dev',path), '', { mode: 0o600 });
    const used = new Set<string>(); let total = 0;
    function copy(bytes: Buffer, path: string, executable: boolean, runtime: boolean) {
      if (used.has(path)) throw new ProxyError('UNSUPPORTED_PLAN'); used.add(path);
      if ((total += bytes.length) > 384 * 1024 * 1024) throw new ProxyError('LIMIT');
      mkdirSync(dirname(join(root,path)), { recursive: true, mode: 0o700 });
      writeFileSync(join(root,path), bytes, { mode: executable ? 0o500 : !runtime && input.profile === 'workspace_write' ? 0o600 : 0o400, flag: 'wx' });
    }
    for (const file of input.runtime) {
      const path = target(file.target);
      if (!['app/','bin/','usr/bin/','lib/','lib64/'].some(p => path.startsWith(p))) throw new ProxyError('UNSUPPORTED_PLAN');
      copy(snapshot(file.source, file.sha256, 256 * 1024 * 1024, true), path, file.executable ?? false, true);
    }
    for (const file of input.files) {
      copy(exportedBytes(file, testHooks.afterExportRootOpened), 'work/' + target(file.target), false, false);
    }
    return { root, dispose() { rmSync(root, { recursive: true, force: true }); } };
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}

/** Use as a trusted launcher boundary, never child/tool input. No unconfined fallback.
 * Private provider fds 3/4 pass through; descriptors >=5 are closed by the helper. */
export function confinementCommand(input: { helper: string; helperSha256: string; root: string; profile: 'read_only' | 'workspace_write'; entrypoint: string; args?: readonly string[] }) {
  const bytes = snapshot(input.helper, input.helperSha256, 1024 * 1024, true);
  if (!isAbsolute(input.root) || !input.entrypoint.startsWith('/app/') || normalize(input.entrypoint) !== input.entrypoint
    || !['read_only', 'workspace_write'].includes(input.profile)) throw new ProxyError('UNSUPPORTED_PLAN');
  const captured = mkdtempSync(join(tmpdir(), 'delegate-helper-'));
  const command = join(captured, 'helper');
  try { writeFileSync(command, bytes, { mode: 0o500, flag: 'wx' }); }
  catch (error) { rmSync(captured, { recursive: true, force: true }); throw error; }
  return { command, dispose() { rmSync(captured, { recursive: true, force: true }); }, args: [input.root, input.profile, '/bin/bun', '--no-env-file', input.entrypoint, ...(input.args ?? [])],
    env: { PATH: '/usr/bin:/bin', HOME: '/home', TMPDIR: '/tmp', XDG_CONFIG_HOME: '/home', XDG_CACHE_HOME: '/tmp', XDG_DATA_HOME: '/home',
      PI_CODING_AGENT_DIR: '/home/agent', PI_OFFLINE: '1', PI_TELEMETRY: '0', OTEL_SDK_DISABLED: 'true' } };
}

import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const consumer = process.env.PICLAW_DELEGATE_AUTH_103_CONSUMER;
const archives = process.env.PICLAW_DELEGATE_AUTH_103_ARCHIVES;
const enabled = process.env.PICLAW_E2E_DISPOSABLE === '1' && consumer && archives;
const integration = enabled ? test : test.skip;
const saved = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/child-auth-103.json'), 'utf8'));

test('current1.0.3 auth receipt preserves exact artifacts, private pipe scope and historical evidence', () => {
  expect(saved.referenceGitHead).toBe('d78dc83d633229d12f8b79631384c4c2717c399f');
  expect(saved.filesCompared).toBe(564); expect(saved.receipt.version).toBe('1.0.3');
  expect(saved.receipt.networkAttempts).toBe(0);
  expect(createHash('sha256').update(readFileSync(join(import.meta.dir, 'fixtures/child-auth-103.log'))).digest('hex')).toBe(saved.rawLogSha256);
  expect(saved.sandbox.devices).toEqual(['lo']); expect(saved.sandbox.noNewPrivs).toBe(1); expect(saved.sandbox.nonRoot).toBe(true);
  expect(Object.values(saved.sandbox.capabilities)).toEqual(Array(4).fill('0000000000000000'));
  expect(saved.receipt.rows.map((r: { mode: string; authRequests: number; observations: number; refreshes: number }) => [r.mode, r.authRequests, r.observations, r.refreshes])).toEqual([
    ['rotate',2,2,1], ['api-key-env',2,2,0], ['logout',2,1,0], ['denied',1,0,0], ['disconnect',2,1,0], ['terminate',2,1,0],
  ]);
  expect(saved.receipt.scope).toBe('synthetic public extension/provider IPC seam only; not production Delegate or real-provider parity');
  expect(saved.limits).toContain('synthetic provider only');
  expect(saved.limits).toContain('currentauthpipe qualification doesnot establishpublic rawauth/provider settlement oraccountgeneration');
  expect(saved.limits).toContain('production Delegate unchanged');
  expect(saved.limits).toContain('no atomic logout-to-dispatch guarantee');
  for (const [path, hash] of Object.entries(saved.fingerprints as Record<string, string>)) {
    expect(createHash('sha256').update(readFileSync(join(import.meta.dir, '../..', path))).digest('hex')).toBe(hash);
  }
  expect(Object.keys(saved.fingerprints).sort()).toEqual(['scripts/qualification/delegate-auth-103-child.ts', 'scripts/qualification/delegate-auth-103-parent.ts']);
  expect(saved.run).toEqual({ pass: 1, fail: 0, assertions: 587 });
  expect(saved.failures).toHaveLength(1);
  expect(saved.failures.every((r: { qualifying: boolean }) => r.qualifying === false)).toBe(true);
  const history = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/delegate-103-history-preserved.json'), 'utf8')) as Array<{ path: string; sha256: string }>;
  expect(history).toHaveLength(10);
  for (const row of history) expect(createHash('sha256').update(readFileSync(join(import.meta.dir, '../..', row.path))).digest('hex')).toBe(row.sha256);
});

const integrity = {
  'pi-ai': 'sha512-p+/EUrbmfT0xWOtL/NJRtWOsyzcKKFSyiivHLDBMG0DUVpHdaIykd5jFibq0YZDFGBN/nv61zdOelMb+ylPfSg==',
  'pi-coding-agent': 'sha512-t2lb0dw4y/jr5a2PRo6eTHGTZOPB3/YAMVyhhYFC1W3Hl5xE+462I/gMWjF4gCLuhGipNEfuNqONFmdqLFz4SQ==',
};

integration('published Pi 1.0.3 child auth pipe uses current artifacts and fails closed', async () => {
  if (!consumer || !archives || !isAbsolute(consumer) || !isAbsolute(archives)) throw Error('Explicit isolated consumer/archive paths required');
  const parentNamespace = process.env.PICLAW_DELEGATE_PARENT_NETNS;
  if (process.platform !== 'linux' || !parentNamespace || readlinkSync('/proc/self/ns/net') === parentNamespace) throw Error('Separate loopback-only namespace required');
  const devices = readFileSync('/proc/net/dev', 'utf8').split('\n').filter(line => line.includes(':')).map(line => line.split(':')[0].trim());
  expect(devices).toEqual(['lo']);
  const status = readFileSync('/proc/self/status', 'utf8');
  const capabilities = Object.fromEntries(['CapEff', 'CapPrm', 'CapBnd', 'CapAmb'].map(key => {
    const value = status.split('\n').find(line => line.startsWith(key + ':'))?.split(':')[1].trim();
    expect(value).toBe('0000000000000000'); return [key, value];
  }));
  const noNewPrivs = Number(status.match(/^NoNewPrivs:\s+(\d+)$/m)?.[1]);
  expect(noNewPrivs).toBe(1); expect(process.getuid?.()).not.toBe(0);
  const root = mkdtempSync(join(tmpdir(), 'delegate-auth103-'));
  try {
    let filesCompared = 0;
    for (const [name, expected] of Object.entries(integrity)) {
      const archive = join(archives, name + '-1.0.3.tgz');
      expect('sha512-' + createHash('sha512').update(readFileSync(archive)).digest('base64')).toBe(expected);
      const unpack = join(root, name); mkdirSync(unpack);
      expect(Bun.spawnSync(['tar', '-xzf', archive, '-C', unpack], { stderr: 'pipe' }).exitCode).toBe(0);
      const source = join(unpack, 'package'), installed = join(consumer, 'node_modules/@earendil-works', name);
      const metadata = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
      expect(metadata.version).toBe('1.0.3');
      const walk = (dir: string): string[] => readdirSync(join(source, dir), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
      const payload = (path: string) => path === 'package.json' || path.startsWith('dist/') && /\.(?:js|json)$/.test(path);
      const archiveFiles = walk('').filter(payload).sort();
      const installedWalk = (dir: string): string[] => readdirSync(join(installed, dir), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? installedWalk(join(dir, entry.name)) : [join(dir, entry.name)]);
      expect(installedWalk('').filter(payload).sort()).toEqual(archiveFiles);
      for (const path of archiveFiles) {
        expect(readFileSync(join(source, path)).equals(readFileSync(join(installed, path))), name + '/' + path).toBe(true); filesCompared++;
      }
    }
    expect(filesCompared).toBeGreaterThan(100);
    cpSync(join(import.meta.dir, 'delegate-auth-103-parent.ts'), join(root, 'parent.ts'));
    cpSync(join(import.meta.dir, 'delegate-auth-103-child.ts'), join(root, 'child.ts'));
    symlinkSync(join(consumer, 'node_modules'), join(root, 'node_modules'), 'dir');
    const scenarios = join(root, 'scenarios'); mkdirSync(scenarios);
    const manifest = JSON.parse(readFileSync(join(consumer, 'node_modules/@earendil-works/pi-coding-agent/package.json'), 'utf8'));
    expect(manifest.bin.pi).toBe('dist/bundle/cli.js');
    const cli = join(consumer, 'node_modules/@earendil-works/pi-coding-agent', manifest.bin.pi);
    const child = spawn(process.execPath, ['--no-env-file', join(root, 'parent.ts'), scenarios, cli, join(root, 'child.ts')], {
      cwd: root, env: { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root, PI_OFFLINE: '1', PI_TELEMETRY: '0', OTEL_SDK_DISABLED: 'true' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const killGroup = (signal: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } } };
    let stdout = '', stderr = '';
    child.stdout!.on('data', bytes => { stdout += bytes.toString(); if (stdout.length > 200000) killGroup('SIGKILL'); });
    child.stderr!.on('data', bytes => { stderr += bytes.toString(); if (stderr.length > 200000) killGroup('SIGKILL'); });
    const exited = new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    const timer = setTimeout(() => killGroup('SIGTERM'), 40000), hardTimer = setTimeout(() => killGroup('SIGKILL'), 43000);
    try {
      const exit = await exited; expect(exit, stderr).toBe(0);
      expect(stdout).not.toContain('SYNTHETIC_'); expect(stderr).not.toContain('SYNTHETIC_');
      const receipt = JSON.parse(stdout); expect(receipt.version).toBe('1.0.3');
      expect(receipt.rows.map((row: { mode: string }) => row.mode)).toEqual(['rotate', 'api-key-env', 'logout', 'denied', 'disconnect', 'terminate']);
      expect(receipt.networkAttempts).toBe(0);
      console.log(JSON.stringify({ filesCompared, receipt, sandbox: { capabilities, noNewPrivs, nonRoot: true, devices } }));
    } finally { clearTimeout(timer); clearTimeout(hardTimer); killGroup('SIGKILL'); await exited; }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 50000);

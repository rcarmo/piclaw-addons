import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

// Local-only qualification. Run in a non-root, cap-zero loopback namespace.
// The exact SDK is supplied as an isolated install, never substituted into the live tree.
if (process.argv.slice(2).length !== 3) throw Error('Expected three paths');
const [sdkRoot, archives, out] = process.argv.slice(2).map(x => resolve(x));
if (![sdkRoot, archives, out].every(isAbsolute)) throw Error('Usage: bun delegate-proxy-103-check.ts ISOLATED_CONSUMER TARBALL_DIR NEW_OUTPUT_DIR');
if (process.platform !== 'linux' || process.getuid?.() === 0) throw Error('Non-root Linux qualification required');
const devices = readFileSync('/proc/net/dev', 'utf8').split('\n').filter(s => s.includes(':')).map(s => s.split(':')[0].trim());
const status = readFileSync('/proc/self/status', 'utf8');
if (devices.join(',') !== 'lo' || !/^NoNewPrivs:\s+1$/m.test(status)) throw Error('Loopback-only NoNewPrivs namespace required');
for (const key of ['CapEff', 'CapPrm', 'CapBnd', 'CapAmb']) if (!new RegExp('^' + key + ':\\s+0000000000000000$', 'm').test(status)) throw Error('Capabilities must be zero');
if (existsSync(out)) throw Error('Use a new evidence directory; historical receipts must not be overwritten');
mkdirSync(out, { recursive: true });
const root = resolve(import.meta.dir, '../..'), target = join(out, 'consumer');
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const integrity: Record<string, string> = {
  'pi-ai': 'sha512-p+/EUrbmfT0xWOtL/NJRtWOsyzcKKFSyiivHLDBMG0DUVpHdaIykd5jFibq0YZDFGBN/nv61zdOelMb+ylPfSg==',
  'pi-coding-agent': 'sha512-t2lb0dw4y/jr5a2PRo6eTHGTZOPB3/YAMVyhhYFC1W3Hl5xE+462I/gMWjF4gCLuhGipNEfuNqONFmdqLFz4SQ==',
};
const walk = (dir: string, prefix = ''): string[] => readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(dir, join(prefix, entry.name)) : [join(prefix, entry.name)]);
const compared: Record<string, number> = {};
for (const [name, expected] of Object.entries(integrity)) {
  const archive = join(archives, name + '-1.0.3.tgz');
  if ('sha512-' + createHash('sha512').update(readFileSync(archive)).digest('base64') !== expected) throw Error('Archive integrity: ' + name);
  const unpack = join(out, 'verify-' + name); mkdirSync(unpack);
  if (Bun.spawnSync(['tar', '-xzf', archive, '-C', unpack]).exitCode) throw Error('Archive extraction failed');
  const source = join(unpack, 'package'), installed = join(sdkRoot, 'node_modules/@earendil-works', name);
  const filter = (p: string) => p === 'package.json' || p.startsWith('dist/') && /\.(?:js|json|ts)$/.test(p);
  const files = walk(source).filter(filter).sort();
  if (JSON.stringify(files) !== JSON.stringify(walk(installed).filter(filter).sort())) throw Error('Installed inventory mismatch');
  for (const file of files) if (hash(readFileSync(join(source, file))) !== hash(readFileSync(join(installed, file)))) throw Error('Installed mismatch: ' + name + '/' + file);
  if (JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version !== '1.0.3') throw Error('Expected Pi1.0.3');
  compared[name] = files.length; rmSync(unpack, { recursive: true });
}
mkdirSync(target);
for (const path of ['experimental/delegate-parent-proxy', 'scripts/test-preload.ts', 'scripts/check-test-preloads.ts', 'scripts/lib/test-filesystem-isolation.ts', 'bunfig.toml']) {
  mkdirSync(resolve(target, path, '..'), { recursive: true }); cpSync(join(root, path), join(target, path), { recursive: true });
}
const deps = realpathSync(join(sdkRoot, 'node_modules')); symlinkSync(deps, join(target, 'node_modules'), 'dir');
// Compiler/bun types are build tools only; SDK module resolution is the exact isolated install.
const require = createRequire(join(root, 'package.json'));
const tsc = join(dirname(require.resolve('typescript/package.json')), 'bin/tsc');
const buildDeps = dirname(dirname(require.resolve('bun-types/package.json')));
const config = { compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true, types: ['bun-types'], typeRoots: [buildDeps, join(buildDeps, '@types')] }, include: [join(target, 'experimental/delegate-parent-proxy/*.ts')] };
writeFileSync(join(out, 'tsconfig.json'), JSON.stringify(config, null, 2));
const results = [];
for (const [label, args] of [['types', [process.execPath, tsc, '-p', join(out, 'tsconfig.json')]], ['tests', [process.execPath, 'test', 'experimental/delegate-parent-proxy']]] as const) {
  const started = performance.now();
  const child = Bun.spawn(['nice', '-n', '10', ...args], { cwd: target, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  writeFileSync(join(out, label + '.log'), stdout + stderr);
  results.push({ label, code, elapsedMs: Math.round(performance.now() - started) }); console.log(label, code, stderr.slice(-240));
  if (code) throw Error(label + ' failed; retained ' + out);
}
const source = join(root, 'experimental/delegate-parent-proxy');
const fingerprints = Object.fromEntries(walk(source).sort().map(p => [p, hash(readFileSync(join(source, p)))]));
writeFileSync(join(out, 'receipt.json'), JSON.stringify({ date: new Date().toISOString(), pi: '1.0.3', upstream: 'd78dc83d633229d12f8b79631384c4c2717c399f', bun: Bun.version, compared, fingerprints, results,
  sandbox: { devices, nonRoot: true, capabilities: 'all zero', noNewPrivs: true },
  confinement: process.env.PICLAW_DELEGATE_CONFINEMENT_TEST === '1' ? 'Linux x64 namespace+seccomp read/bash snapshot and detached-descendant tests enabled' : 'opt-in confinement tests skipped',
  limits: ['synthetic host; no real accounts/provider/network', 'parent raw-tail promise is injected, not a released Pi capability', 'no production registration, account/budget policy or activation', 'confinement requires explicit host-approved file/runtime snapshots; no whole-workspace grant or automatic writeback', 'Linux x64 only; host-export admission and resource quotas require qualification'] }, null, 2) + '\n');
rmSync(target, { recursive: true });
console.log(out);

import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { resolvePiPackageCli } from './delegate.ts';

const saved = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/pi103-cli-admission.json'), 'utf8'));
test('current1.0.3 published CLI receipt stays separate from historical package evidence', () => {
  expect(saved.referenceGitHead).toBe('d78dc83d633229d12f8b79631384c4c2717c399f');
  expect(saved.result).toMatchObject({ version: '1.0.3', filesCompared: 76, publishedManifestCli: true, offlineVersionExecution: true, emptyDisposableProfile: true });
  expect(createHash('sha256').update(readFileSync(join(import.meta.dir, 'fixtures/pi103-cli-admission.log'))).digest('hex')).toBe(saved.rawLogSha256);
  expect(saved.run).toEqual({ pass: 1, fail: 0, assertions: 94 });
  expect(saved.limits).toContain('productionDelegateunchanged');
});

const pkg = process.env.PICLAW_DELEGATE_103_PACKAGE, archive = process.env.PICLAW_DELEGATE_103_ARCHIVE;
const integration = process.env.PICLAW_E2E_DISPOSABLE === '1' && pkg && archive ? test : test.skip;

integration('released1.0.3 CLI uses published manifest and isolated offline profile', async () => {
  if (!pkg || !archive || !isAbsolute(pkg) || !isAbsolute(archive)) throw Error('Explicit isolated package/archive inputs required');
  const parent = process.env.PICLAW_DELEGATE_PARENT_NETNS;
  if (!parent || readlinkSync('/proc/self/ns/net') === parent) throw Error('Separate network namespace required');
  expect(readFileSync('/proc/net/dev', 'utf8').split('\n').filter(l => l.includes(':')).map(l => l.split(':')[0].trim())).toEqual(['lo']);
  expect(process.getuid?.()).not.toBe(0);
  const status = readFileSync('/proc/self/status','utf8');
  expect(Number(status.match(/^NoNewPrivs:\s+(\d+)$/m)?.[1])).toBe(1);
  for (const key of ['CapEff','CapPrm','CapBnd','CapAmb']) expect(status.split('\n').find(l => l.startsWith(key+':'))?.split(':')[1].trim()).toBe('0000000000000000');
  expect('sha512-'+createHash('sha512').update(readFileSync(archive)).digest('base64')).toBe('sha512-t2lb0dw4y/jr5a2PRo6eTHGTZOPB3/YAMVyhhYFC1W3Hl5xE+462I/gMWjF4gCLuhGipNEfuNqONFmdqLFz4SQ==');
  const root = mkdtempSync(join(tmpdir(),'delegate-cli103-'));
  try {
    const unpack=join(root,'unpack');mkdirSync(unpack);
    expect(Bun.spawnSync(['tar','-xzf',archive,'-C',unpack],{stderr:'pipe'}).exitCode).toBe(0);
    const source=join(unpack,'package'),manifestPath=join(pkg,'package.json'),manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
    expect(manifest.version).toBe('1.0.3');expect(manifest.bin.pi).toBe('dist/bundle/cli.js');
    const files=(dir:string):string[]=>readdirSync(join(source,dir),{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(dir,e.name)):[join(dir,e.name)]);
    const compared=files('').filter(p=>p==='package.json'||p.startsWith('dist/bundle/')&&/\.(?:js|json)$/.test(p));
    const installedFiles=(dir:string):string[]=>readdirSync(join(pkg,dir),{withFileTypes:true}).flatMap(e=>e.isDirectory()?installedFiles(join(dir,e.name)):[join(dir,e.name)]);
    expect(installedFiles('').filter(p=>p==='package.json'||p.startsWith('dist/bundle/')&&/\.(?:js|json)$/.test(p)).sort()).toEqual([...compared].sort());
    for(const file of compared)expect(readFileSync(join(source,file)).equals(readFileSync(join(pkg,file))),file).toBe(true);
    expect(compared.length).toBeGreaterThan(50);
    const cli=resolvePiPackageCli(manifestPath);expect(cli).toBe(join(pkg,manifest.bin.pi));
    const profile=join(root,'profile'),home=join(root,'home'),workspace=join(root,'workspace');for(const p of[profile,home,workspace])mkdirSync(p);
    const env={PATH:'/usr/bin:/bin',HOME:home,PI_CODING_AGENT_DIR:profile,PI_OFFLINE:'1',PI_TELEMETRY:'0',OTEL_SDK_DISABLED:'true'};
    const version=Bun.spawn([process.execPath,'--no-env-file',cli!,'--offline','--version'],{cwd:workspace,env,stdout:'pipe',stderr:'pipe'});
    const timer=setTimeout(()=>version.kill('SIGKILL'),10000);
    try {
      const [exit,stdout,stderr]=await Promise.all([version.exited,new Response(version.stdout).text(),new Response(version.stderr).text()]);
      expect(exit,stderr).toBe(0);expect(stdout.trim()).toBe('1.0.3');
    } finally {clearTimeout(timer);if(version.exitCode===null){version.kill('SIGKILL');await version.exited;}}
    expect(readdirSync(workspace)).toEqual([]);expect(readdirSync(profile)).toEqual([]);
    console.log(JSON.stringify({version:'1.0.3',filesCompared:compared.length,publishedManifestCli:true,offlineVersionExecution:true,emptyDisposableProfile:true,scope:'PublishedCLIartifact/version only; no provider execution orcredential source proof'}));
  } finally {rmSync(root,{recursive:true,force:true});}
},15000);

import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, closeSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageConfinement, confinementCommand, type ApprovedRuntimeFile } from './confinement.ts';
import { runConfinedProxyChild } from './confined-child.ts';
import type { ChildRequestScopeV1 } from './contracts.ts';

const integration = process.env.PICLAW_DELEGATE_CONFINEMENT_TEST === '1' ? test : test.skip;
const out = mkdtempSync(join(tmpdir(), 'confinement-check-'));
afterAll(() => rmSync(out, { recursive: true, force: true }));
const hash = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
function run(args: string[]) { const p = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' }); if (p.exitCode) throw Error(p.stderr.toString()); return p.stdout.toString(); }
let compiled: { helper: string; helperSha256: string; runtime: ApprovedRuntimeFile[] } | undefined;
function prepare() {
  if (compiled) return compiled;
  if (process.platform !== 'linux' || process.arch !== 'x64' || process.getuid?.() === 0) throw Error('Non-root Linux x64 required');
  const helper = join(out, 'confinement');
  for (const [file, destination] of [['confinement.c', helper], ['confinement-probe.c', join(out, 'probe')]])
    run(['/usr/bin/cc', '-O2', '-Wall', '-Wextra', '-Werror', join(import.meta.dir, file), '-o', destination]);
  run([process.execPath, 'build', join(import.meta.dir, 'confinement-fixture.ts'), '--target=bun', '--external', './fixture-child.ts', '--outfile', join(out, 'probe.js')]);
  run([process.execPath, 'build', join(import.meta.dir, 'fixture-child.ts'), '--target=bun', '--outfile', join(out, 'agent.js')]);
  const runtime = new Map<string, ApprovedRuntimeFile>();
  function add(src: string, target: string, executable = false) { const source = realpathSync(src); runtime.set(target, { source, target, sha256: hash(source), executable }); }
  for (const [src, target] of [[realpathSync(process.execPath), 'bin/bun'], ['/usr/bin/bash', 'bin/bash'], ['/usr/bin/dash', 'bin/sh'], ['/usr/bin/cat', 'usr/bin/cat'], ['/usr/bin/setsid', 'usr/bin/setsid'], ['/usr/bin/sleep', 'usr/bin/sleep'], [join(out,'probe'), 'bin/probe']]) {
    add(src, target, true);
    for (const match of run(['/usr/bin/ldd', src]).matchAll(/(?:=>\s*)?(\/[^\s]+)\s+\(/g)) if (existsSync(match[1])) add(match[1], match[1].slice(1), true);
  }
  add(join(out,'probe.js'), 'app/probe.js'); add(join(out,'agent.js'), 'app/agent.js');
  writeFileSync(join(out,'fixture.txt'), 'SYNTHETIC_APPROVED_INPUT'); writeFileSync(join(out,'outside-canary'), 'SYNTHETIC_PRIVATE_NOT_EXPORTED');
  compiled = { helper, helperSha256: hash(helper), runtime: [...runtime.values()] }; return compiled;
}
function files() { return [{ source: join(out,'fixture.txt'), exportRoot: out, target: 'fixture.txt', sha256: hash(join(out,'fixture.txt')) }]; }
function processes() { return readdirSync('/proc').filter(x => /^\d+$/.test(x)).flatMap(pid => { try { const row = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' '); return [{ pid: Number(pid), ppid: Number(row[1]), state: row[0], session: Number(row[3]) }]; } catch { return []; } }); }
async function start(snapshot: ReturnType<typeof stageConfinement>, profile: 'read_only' | 'workspace_write', mode: string) {
  const c = confinementCommand({ ...prepare(), root: snapshot.root, profile, entrypoint: '/app/probe.js', args: [mode, join(out,'outside-canary')] });
  const secretFd = openSync(join(out,'outside-canary'), 'r');
  const child = spawn(c.command, c.args, { env: c.env, cwd: '/', detached: true, stdio: ['ignore','pipe','pipe','pipe','pipe',secretFd] }); closeSync(secretFd);
  let stdout = '', stderr = ''; let ready!: () => void; const line = new Promise<void>(r => { ready = r; });
  child.stdout!.on('data', bytes => { stdout += bytes; if (stdout.includes('\n')) ready(); }); child.stderr!.on('data', bytes => { stderr += bytes; });
  const closed = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const deadline = setTimeout(() => { if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 7000);
  void closed.then(() => { clearTimeout(deadline); c.dispose(); }, () => { clearTimeout(deadline); c.dispose(); });
  return { child, line, closed, output: () => ({ stdout, stderr }) };
}

test('grants reject path traversal, symlinks, hardlinks, digest changes and directories', () => {
  const root = join(out,'grants'); mkdirSync(root, { mode: 0o700 }); const source = join(root,'file'); writeFileSync(source,'approved');
  const grant = { source, exportRoot: root, target: 'file', sha256: hash(source) };
  for (const change of [{ target: '../escape' }, { target: '/absolute' }, { target: 'a/../b' }, { sha256: '0'.repeat(64) }, { source: root }, { exportRoot: join(root,'not-parent') }]) {
    expect(() => stageConfinement({ profile: 'read_only', runtime: [], files: [{ ...grant, ...change }] })).toThrow();
  }
  symlinkSync(source, join(root,'link')); expect(() => stageConfinement({ profile: 'read_only', runtime: [], files: [{ ...grant, source: join(root,'link') }] })).toThrow();
  linkSync(source, join(root,'hardlink')); expect(() => stageConfinement({ profile: 'read_only', runtime: [], files: [grant] })).toThrow();
});

integration.each(['read_only','workspace_write'] as const)('real %s filesystem/process/network boundary runs bash with no host grants', async profile => {
  const fixture = prepare(); const snapshot = stageConfinement({ ...fixture, profile, files: files() });
  const socketPath = join(out,'provider.sock'), server = createServer(); await new Promise<void>(r => server.listen(socketPath,r));
  try {
    expect(() => stageConfinement({ ...fixture, profile, files: [{ source: socketPath, exportRoot: out, target: 'provider.sock', sha256: '0'.repeat(64) }] })).toThrow();
    const child = await start(snapshot,profile,'probe'); expect(await child.closed, child.output().stderr).toBe(0);
    const result = JSON.parse(child.output().stdout);
    expect(Object.values(result.denied).every(Boolean)).toBe(true); expect(result.hostCanaryVisible).toBe(false);
    expect(result.workWrite).toBe(profile === 'workspace_write'); expect(result.workOverwrite).toBe(profile === 'workspace_write'); expect(result.symlinkEscape).toBe(false); expect(result.runtimeWrite).toBe(false); expect(result.tempWrite).toBe(true);
    expect(result.network).not.toBe('CONNECTED'); expect(result.sockets).not.toBe('CONNECTED'); expect(result.fixture).toBe('SYNTHETIC_APPROVED_INPUT');
    expect(result.bash.status).toBe(0); expect(result.bash.stdout).toContain('BASH_OK'); expect(result.escape.status).toBe(0);
    expect(result.caps).toHaveLength(4); expect(result.caps.every((v: string) => v.endsWith('0000000000000000'))).toBe(true);
    expect(result.nnp).toBe('NoNewPrivs:\t1'); expect(result.pids).toEqual(['1']);
    expect(JSON.stringify(result.fds)).not.toContain('outside-canary'); expect(readFileSync(join(out,'fixture.txt'),'utf8')).toBe('SYNTHETIC_APPROVED_INPUT');
  } finally { snapshot.dispose(); await new Promise<void>(r => server.close(()=>r())); }
}, 20000);

integration.each(['killed-supervisor','normal-init-exit'] as const)('%s reaps a detached setsid descendant', async mode => {
  const snapshot = stageConfinement({ ...prepare(), profile: 'read_only', files: files() });
  const child = await start(snapshot,'read_only',mode === 'normal-init-exit' ? 'daemon-exit' : 'daemon');
  try {
    await Promise.race([child.line,child.closed.then(()=>{throw Error(child.output().stderr)})]); await Bun.sleep(30);
    const rows = processes(), init = rows.find(r=>r.ppid===child.child.pid); expect(init).toBeDefined();
    const daemon = rows.find(r=>r.ppid===init!.pid); expect(daemon).toBeDefined(); expect(daemon!.session).not.toBe(init!.session);
    if (mode === 'killed-supervisor') process.kill(child.child.pid!, 'SIGKILL'); await child.closed;
    for (let n=0;n<60&&processes().some(r=>r.pid===daemon!.pid&&r.state!=='Z');n++) await Bun.sleep(10);
    expect(processes().some(r=>r.pid===daemon!.pid&&r.state!=='Z')).toBe(false);
  } finally { if (child.child.pid) try { process.kill(-child.child.pid,'SIGKILL'); } catch {} await child.closed; snapshot.dispose(); }
}, 15000);

integration.each(['read_only','workspace_write'] as const)('public Pi agent read/bash continuation confined as %s', async profile => {
  let requests=0,closes=0; const transcripts: string[]=[];
  const scope: ChildRequestScopeV1 = { plan: {version:1,execution:'parent-provider-proxy',model:{provider:'synthetic',id:'fixture'},mcp:'none'},
    stream(context) { requests++; transcripts.push(JSON.stringify(context)); const first=requests===1,second=requests===2;
      const message={role:'assistant' as const,provider:'synthetic',model:'fixture',api:'openai-completions',timestamp:requests,
        content:first?[{type:'toolCall' as const,id:'read_1',name:'read',arguments:{path:'fixture.txt'}}]:second?[{type:'toolCall' as const,id:'bash_1',name:'bash',arguments:{command:'set -e; cat /work/fixture.txt; test ! -e /workspace/.piclaw; test ! -e /run; echo CONFINED_BASH_OK'}}]:[{type:'text' as const,text:'confined agent complete'}],
        stopReason:first||second?'toolUse' as const:'stop' as const,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
      return{settled:Promise.resolve(),cancel(){},async *[Symbol.asyncIterator](){yield{type:'start' as const,partial:{...message,stopReason:'pending' as const}};yield{type:'done' as const,reason:message.stopReason,message}}};
    },async close(){closes++}};
  const result=await runConfinedProxyChild({...prepare(),scope,files:files(),profile,entrypoint:'/app/agent.js',args:['agent-bash'],signal:new AbortController().signal,timeoutMs:15000});
  expect(JSON.parse(result.output).responses).toEqual(['confined agent complete']);expect(requests).toBe(3);expect(closes).toBe(1);
  expect(transcripts[1]).toContain('SYNTHETIC_APPROVED_INPUT');expect(transcripts[2]).toContain('CONFINED_BASH_OK');
},20000);

integration('confined cancellation waits the host raw tail after killing namespace init', async () => {
  const fixture = prepare(); let resolveTail!:()=>void, entered!:()=>void;
  const tail=new Promise<void>(r=>{resolveTail=r}), admission=new Promise<void>(r=>{entered=r});
  let closes=0,cancels=0;
  const scope:ChildRequestScopeV1={plan:{version:1,execution:'parent-provider-proxy',mcp:'none',model:{provider:'synthetic',id:'fixture'}},
    stream(){entered();return{settled:tail,cancel(){cancels++},async *[Symbol.asyncIterator](){await tail}}},async close(){closes++;await tail}};
  const signal=new AbortController();let finished=false;
  const task=runConfinedProxyChild({...fixture,scope,files:files(),profile:'read_only',entrypoint:'/app/agent.js',args:['twice'],signal:signal.signal,timeoutMs:5000}).finally(()=>{finished=true});void task.catch(()=>{});
  try {
    await Promise.race([admission,task.then(()=>{throw Error('child ended before admission')})]);
    signal.abort();await Bun.sleep(150);expect(finished).toBe(false);expect(cancels).toBeGreaterThan(0);
  } finally { resolveTail(); }
  await expect(task).rejects.toThrow('CANCELLED');expect(closes).toBe(1);
});

test('invalid approved export/helper fails before launch and closes scope without fallback',async()=>{
  let closed=0,requests=0;
  const scope:ChildRequestScopeV1={plan:{version:1,execution:'parent-provider-proxy',mcp:'none',model:{provider:'synthetic',id:'fixture'}},stream(){requests++;throw Error('must not launch')},async close(){closed++}};
  await expect(runConfinedProxyChild({scope,helper:'/nonexistent/confinement',helperSha256:'0'.repeat(64),runtime:[],files:[],profile:'read_only',entrypoint:'/app/absent',signal:new AbortController().signal,timeoutMs:100})).rejects.toThrow();
  expect(closed).toBe(1);expect(requests).toBe(0);
});

test('export directory private-mode and file writability are enforced, ancestor replacement cannot redirect opened root',()=>{
  const root=join(out,'race-export');mkdirSync(root,{mode:0o700});const source=join(root,'data');writeFileSync(source,'approved');
  const file={source,exportRoot:root,target:'data',sha256:hash(source)};
  chmodSync(root,0o777);expect(()=>stageConfinement({profile:'read_only',runtime:[],files:[file]})).toThrow();chmodSync(root,0o700);
  chmodSync(source,0o666);expect(()=>stageConfinement({profile:'read_only',runtime:[],files:[file]})).toThrow();chmodSync(source,0o600);
  const snapshot=stageConfinement({profile:'read_only',runtime:[],files:[file]},{afterExportRootOpened(){
    renameSync(root,root+'-captured');mkdirSync(root,{mode:0o700});writeFileSync(source,'unapproved replacement');
  }});
  try{expect(readFileSync(join(snapshot.root,'work/data'),'utf8')).toBe('approved')}finally{snapshot.dispose()}
});

integration('helper path replacement after verification cannot change captured executable',async()=>{
  const prepared=prepare(), original=join(out,'mutable-helper');writeFileSync(original,readFileSync(prepared.helper),{mode:0o700});
  const snapshot=stageConfinement({...prepared,profile:'read_only',files:files()});
  const launch=confinementCommand({helper:original,helperSha256:hash(original),root:snapshot.root,profile:'read_only',entrypoint:'/app/probe.js',args:['probe']});
  writeFileSync(original,'#!/bin/sh\necho UNVERIFIED_HELPER_EXECUTED\n');
  try{
    const child=spawn(launch.command,launch.args,{env:launch.env,stdio:['ignore','pipe','pipe','pipe','pipe']});let text='';child.stdout!.on('data',b=>text+=b);child.stderr!.resume();
    expect(await new Promise<number|null>((r,j)=>{child.once('error',j);child.once('close',r)})).toBe(0);
    expect(text).not.toContain('UNVERIFIED_HELPER_EXECUTED');expect(JSON.parse(text).runtimeWrite).toBe(false);
  }finally{launch.dispose();snapshot.dispose()}
});

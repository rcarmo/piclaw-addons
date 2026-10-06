import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { delegateCliDiagnostics, getExecutableCatalog, invalidateExecutableCatalog, resolveDelegateCliCommand, resolveRunningPiclawCli, getDelegateWorkspaceRoot } from './delegate.ts';

function piPackage(root: string, version: string, model: string) {
  const directory = join(root, 'node_modules/@earendil-works/pi-coding-agent');
  const cli = join(directory, 'dist/bundle/cli.js');
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version, exports: { '.': './index.js' }, bin: { pi: 'dist/bundle/cli.js' } }));
  writeFileSync(join(directory, 'index.js'), 'throw Error("package imports must not run");');
  writeFileSync(cli, `console.log('provider model context max-out thinking images');console.log('github-copilot ${model} 1M 128K yes yes');`);
  return cli;
}
function host(root: string) {
  const entry = join(root, 'runtime/src/index.ts');
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'piclaw', version: 'fixture', bin: { piclaw: 'runtime/src/index.ts' } }));
  writeFileSync(entry, '// host fixture');
  return entry;
}

test('running-release CLI wins over older add-on peers, global guesses and PATH, with override preserved', () => {
  const root = mkdtempSync(join(tmpdir(), 'delegate-host-'));
  try {
    const entry = host(join(root, 'release'));
    const selected = piPackage(join(root, 'release/runtime'), '1.0.1', 'gpt-6.1-sol');
    const stale = piPackage(join(root, 'addon'), '0.85.1', 'gpt-5.4-mini');
    const options = { hostEntryPoint: entry, execPath: process.execPath, env: { PATH: '' }, resolvePackageCli: () => stale };
    const result = resolveDelegateCliCommand(options);
    expect(result.argsPrefix).toEqual([selected]);
    expect(result.command).toBe(process.execPath);
    expect(delegateCliDiagnostics(result)).toMatchObject({ path: selected, package_version: '1.0.1' });
    expect(resolveDelegateCliCommand({ ...options, env: { PI_DELEGATE_CLI: 'custom --fixture', PATH: '' } }).argsPrefix).toEqual(['--fixture']);
    expect(resolveDelegateCliCommand({ ...options, hostEntryPoint: null }).argsPrefix).toEqual([stale]);
    const standalone = join(root, 'standalone');mkdirSync(standalone);
    writeFileSync(join(standalone, 'package.json'), JSON.stringify({ name: 'unrelated' }));writeFileSync(join(standalone, 'main.js'), '');
    expect(resolveRunningPiclawCli(join(standalone, 'main.js'))).toBeNull();
    rmSync(join(root, 'release/runtime/node_modules'), { recursive: true });
    expect(() => resolveDelegateCliCommand(options)).toThrow('Running Piclaw release has no valid Pi CLI');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('canonical launcher symlinks follow the running release; metadata/bin changes invalidate identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'delegate-release-symlink-'));
  try {
    const entry = host(join(root, 'release'));
    const cli = piPackage(join(root, 'release'), '1.0.1', 'gpt-6-sol');
    const launcher = join(root, 'piclaw');symlinkSync(entry, launcher);
    expect(resolveRunningPiclawCli(launcher)).toBe(cli);
    const resolved = resolveDelegateCliCommand({ hostEntryPoint: launcher, env: {}, execPath: process.execPath });
    const before = delegateCliDiagnostics(resolved);
    writeFileSync(join(dirname(dirname(dirname(cli))), 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.0.2', bin: { pi: 'dist/bundle/cli.js' } }));
    const after = delegateCliDiagnostics(resolved);
    expect(after.package_version).toBe('1.0.2');expect(after.identity).not.toBe(before.identity);
    writeFileSync(cli, '// replacement CLI');expect(delegateCliDiagnostics(resolved).identity).not.toBe(after.identity);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('catalog cache is scoped to the selected CLI and cannot reuse another runtime after discovery failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delegate-catalog-identity-'));const old = process.env.PI_DELEGATE_CLI;
  try {
    const a = piPackage(join(root, 'a'), '1.0.0', 'gpt-6-sol'), b = piPackage(join(root, 'b'), '1.0.1', 'gpt-6.1-sol');
    process.env.PI_DELEGATE_CLI = `${process.execPath} ${a}`;
    const first = await getExecutableCatalog(true);expect(first.models[0].id).toBe('gpt-6-sol');
    expect(first.cliPackageVersion).toBe('1.0.0');
    process.env.PI_DELEGATE_CLI = `${process.execPath} ${b}`;
    const changed = await getExecutableCatalog();expect(changed.models[0].id).toBe('gpt-6.1-sol');expect(changed.cliIdentity).not.toBe(first.cliIdentity);
    const bad = join(root, 'bad.js');writeFileSync(bad, 'console.error("fixture discovery failure");process.exit(1);');
    process.env.PI_DELEGATE_CLI = `${process.execPath} ${bad}`;
    const failure = await getExecutableCatalog();expect(failure.models).toEqual([]);expect(failure.stale).toBe(true);expect(failure.lastError).toContain('fixture discovery failure');
  } finally { if(old===undefined)delete process.env.PI_DELEGATE_CLI;else process.env.PI_DELEGATE_CLI=old;invalidateExecutableCatalog();rmSync(root,{recursive:true,force:true}); }
});

test('in-flight discovery retains only its own previous catalog when another CLI finishes first', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delegate-catalog-race-'));const old = process.env.PI_DELEGATE_CLI;
  try {
    const mode = join(root, 'fail'), waiting = join(root, 'waiting'), release = join(root, 'release');
    const a = join(root, 'a.js'), b = piPackage(join(root, 'b'), '1.0.1', 'gpt-6.1-sol');
    writeFileSync(a, `import{existsSync,writeFileSync}from'node:fs';if(existsSync(${JSON.stringify(mode)})){writeFileSync(${JSON.stringify(waiting)},'');while(!existsSync(${JSON.stringify(release)}))await Bun.sleep(5);console.error('fixture fail');process.exit(1);}console.log('provider model context max-out thinking images');console.log('github-copilot gpt-6-sol 1M 128K yes yes');`);
    process.env.PI_DELEGATE_CLI = `${process.execPath} ${a}`;await getExecutableCatalog(true);writeFileSync(mode, '');
    const pending = getExecutableCatalog(true);
    try {
      const deadline = Date.now()+2000;while(!existsSync(waiting)&&Date.now()<deadline)await Bun.sleep(5);expect(existsSync(waiting)).toBe(true);
      process.env.PI_DELEGATE_CLI = `${process.execPath} ${b}`;expect((await getExecutableCatalog()).models[0].id).toBe('gpt-6.1-sol');
    } finally { writeFileSync(release, ''); }
    const failed = await pending;expect(failed.models.map(x=>x.id)).toEqual(['gpt-6-sol']);expect(failed.stale).toBe(true);
    expect((await getExecutableCatalog()).models[0].id).toBe('gpt-6.1-sol');
  } finally { if(old===undefined)delete process.env.PI_DELEGATE_CLI;else process.env.PI_DELEGATE_CLI=old;invalidateExecutableCatalog();rmSync(root,{recursive:true,force:true}); }
});

test('model discovery and child attempts share a pinned CLI even if configuration changes mid-turn', async () => {
  const root = mkdtempSync(join(getDelegateWorkspaceRoot(), 'delegate-pinned-'));
  const globals=globalThis as any, oldRegistrar=globals.__piclaw_registerAddonConfigApi, oldCli=process.env.PI_DELEGATE_CLI;
  let configApi:any;
  try {
    const cli=join(root,'cli.js'),bad=join(root,'bad.js'),marker=join(root,'executed'),foreign=join(root,'wrong-cli');
    writeFileSync(cli, `import{writeFileSync}from'node:fs';if(process.argv.includes('--list-models')){console.log('provider model context max-out thinking images');console.log('github-copilot gpt-6-sol 1M 128K yes yes');process.exit(0);}await Bun.stdin.text();writeFileSync(${JSON.stringify(marker)},'');console.log(JSON.stringify({type:'message_end',message:{role:'assistant',provider:'github-copilot',model:'gpt-6-sol',content:[{type:'text',text:'PINNED_OK'}],stopReason:'stop'}}));`);
    writeFileSync(bad, `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(foreign)},'');process.exit(1);`);
    process.env.PI_DELEGATE_CLI=`${process.execPath} ${cli}`;
    globals.__piclaw_registerAddonConfigApi=(_id:string,action:string,api:any)=>{if(action==='config')configApi=api;};
    const mod=await import(`./delegate.ts?pinned=${encodeURIComponent(root)}`);globals.__piclaw_registerAddonConfigApi=oldRegistrar;
    let tool:any;mod.default({on(){},registerTool(value:any){tool=value;}});await configApi.set({searchable_providers:['github-copilot'],excluded_providers:[],excluded_models:[]});
    const ctx={model:{provider:'github-copilot',id:'gpt-6-sol'},modelRegistry:{getAvailable(){return [];}}};
    const result=await tool.execute('pinned',{prompt:'fixture',model:'github-copilot/gpt-6-sol',tools:'read'},undefined,()=>{process.env.PI_DELEGATE_CLI=`${process.execPath} ${bad}`;},ctx);
    expect(result.content[0].text).toContain('PINNED_OK');expect(existsSync(marker)).toBe(true);expect(existsSync(foreign)).toBe(false);
    // Environment pinning alone is insufficient: reject a file rewrite by the progress callback.
    process.env.PI_DELEGATE_CLI=`${process.execPath} ${cli}`;rmSync(marker);
    await expect(tool.execute('replaced',{prompt:'fixture',model:'github-copilot/gpt-6-sol',tools:'read'},undefined,()=>{
      writeFileSync(cli,`import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(foreign)},'replacement executed');`);
    },ctx)).rejects.toThrow('CLI changed after discovery');
    expect(existsSync(marker)).toBe(false);expect(existsSync(foreign)).toBe(false);
  } finally {globals.__piclaw_registerAddonConfigApi=oldRegistrar;if(oldCli===undefined)delete process.env.PI_DELEGATE_CLI;else process.env.PI_DELEGATE_CLI=oldCli;rmSync(root,{recursive:true,force:true});}
});

test('bare overrides pin PATH executables so changed paths cannot reuse another runtime catalog', async () => {
 const { pinDelegateCliCommand } = await import('./delegate.ts');
 const root=mkdtempSync(join(tmpdir(),'delegate-path-pin-'));const oldPath=process.env.PATH,oldCli=process.env.PI_DELEGATE_CLI;
 try{
  for(const [name,model] of [['a','gpt-6-sol'],['b','gpt-6.1-sol']]){const dir=join(root,name);mkdirSync(dir);writeFileSync(join(dir,'fixture-pi'),`#!${process.execPath}\nconsole.log('provider model context max-out thinking images');console.log('github-copilot ${model} 1M 128K yes yes');`,{mode:0o700});}
  process.env.PI_DELEGATE_CLI='fixture-pi';process.env.PATH=join(root,'a');
  const pinned=pinDelegateCliCommand(resolveDelegateCliCommand());expect(pinned.command).toBe(join(root,'a/fixture-pi'));
  expect((await getExecutableCatalog(true)).models[0].id).toBe('gpt-6-sol');
  process.env.PATH=join(root,'b');
  expect((await getExecutableCatalog()).models[0].id).toBe('gpt-6.1-sol');
  expect(pinned.command).toBe(join(root,'a/fixture-pi'));
 }finally{if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;if(oldCli===undefined)delete process.env.PI_DELEGATE_CLI;else process.env.PI_DELEGATE_CLI=oldCli;invalidateExecutableCatalog();rmSync(root,{recursive:true,force:true});}
});

test('an older failing refresh cannot replace a newer successful same-CLI catalog',async()=>{
 const root=mkdtempSync(join(tmpdir(),'delegate-discovery-cas-')),old=process.env.PI_DELEGATE_CLI;
 const mode=join(root,'mode'),waiting=join(root,'waiting'),release=join(root,'release'),cli=join(root,'cli.js');let pending:Promise<any>|undefined;
 try{
  writeFileSync(mode,'old');
  writeFileSync(cli,`import{readFileSync,writeFileSync,existsSync}from'node:fs';const mode=readFileSync(${JSON.stringify(mode)},'utf8');if(mode==='fail'){writeFileSync(${JSON.stringify(waiting)},'');while(!existsSync(${JSON.stringify(release)}))await Bun.sleep(5);process.exit(1);}console.log('provider model context max-out thinking images');console.log('github-copilot '+(mode==='new'?'gpt-6.1-sol':'gpt-6-sol')+' 1M 128K yes yes');`);
  process.env.PI_DELEGATE_CLI=`${process.execPath} ${cli}`;await getExecutableCatalog(true);
  writeFileSync(mode,'fail');pending=getExecutableCatalog(true);
  const deadline=Date.now()+2000;while(!existsSync(waiting)&&Date.now()<deadline)await Bun.sleep(5);expect(existsSync(waiting)).toBe(true);
  writeFileSync(mode,'new');const latest=await getExecutableCatalog(true);expect(latest.models[0].id).toBe('gpt-6.1-sol');
  writeFileSync(release,'');expect((await pending).models[0].id).toBe('gpt-6-sol');
  expect(await getExecutableCatalog()).toBe(latest);
 }finally{writeFileSync(release,'');await pending;if(old===undefined)delete process.env.PI_DELEGATE_CLI;else process.env.PI_DELEGATE_CLI=old;invalidateExecutableCatalog();rmSync(root,{recursive:true,force:true});}
});

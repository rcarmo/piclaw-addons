import {expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {defaultJobConfig} from './job-config.ts';
import {instancePaths,verifyExpectedMount} from './paths.ts';
test('startup import registers direct APIs once, ignores ambient secrets, rejects unknown action fields, shutdown cleans up',async()=>{
 const g=globalThis as any,oldRuntime=g.__piclaw_runtime,oldRegister=g.__piclaw_registerAddonConfigApi,oldInterop=g.__piclawRuntimeInterop;
 const oldWorkspace=process.env.PICLAW_WORKSPACE;const root=mkdtempSync(join(tmpdir(),'restic-runtime-')),workspace=join(root,'workspace');mkdirSync(workspace);
 const apis=new Map<string,any>();const shutdown:Array<()=>void>=[];
 try{
  process.env.PICLAW_WORKSPACE=workspace;
  g.__piclaw_runtime={messaging:{getAddonDataDir:()=>join(root,'state')},lifecycle:{onShutdown:(fn:()=>void)=>shutdown.push(fn)}};
  g.__piclaw_registerAddonConfigApi=(_id:string,action:string,handlers:any)=>apis.set(action,handlers);
  g.__piclawRuntimeInterop={getKeychainEntry:(name:string)=>name==='fixture/key'?{secret:'selected-secret'}:null};
  const mod=await import(`./runtime.ts?test=${encodeURIComponent(root)}`);
  expect([...apis.keys()]).toEqual(['config','status','action']);expect(shutdown).toHaveLength(1);
  expect((await apis.get('status').get()).state.running).toBe(false);
  expect(await mod.resolveKeychainSecret('fixture/key')).toBe('selected-secret');
  await expect(mod.resolveKeychainSecret('missing')).rejects.toThrow('missing');
  await expect(apis.get('action').set({action:'test',env:{SECRET:'no'}})).rejects.toThrow('payload');
  await expect(apis.get('action').set({action:'unlock'})).rejects.toThrow('Unknown');
  await expect(apis.get('config').set({config:{...defaultJobConfig(),enabled:true}})).rejects.toThrow();
  const addon=await import('./index.ts');let tool:any;addon.default({registerTool(value:any){tool=value;}});
  await tool.execute('agent-config',{action:'set_config',config:{...defaultJobConfig(),excludes:['**/.cache','workspace/tmp']}});
  expect((await apis.get('config').get()).config.excludes).toEqual(['**/.cache','workspace/tmp']);
  await apis.get('config').set({config:{...defaultJobConfig(),excludes:['profile/tmp']}});
  expect((await tool.execute('agent-read',{action:'get_config'})).details.config.excludes).toEqual(['profile/tmp']);
  mod.default();expect(shutdown).toHaveLength(1);shutdown[0]();
  await expect(tool.execute('after-shutdown',{action:'status'})).rejects.toThrow('startup runtime');
 }finally{g.__piclaw_runtime=oldRuntime;g.__piclaw_registerAddonConfigApi=oldRegister;g.__piclawRuntimeInterop=oldInterop;if(oldWorkspace===undefined)delete process.env.PICLAW_WORKSPACE;else process.env.PICLAW_WORKSPACE=oldWorkspace;rmSync(root,{recursive:true,force:true});}
});
test('paths use supplied workspace/store/data/profile without fixed host names; mount validation fails closed',()=>{
 const root=mkdtempSync(join(tmpdir(),'restic-path-resolution-'));try{
  for(const name of ['workspace','store','data','profile','state','fake-mount'])mkdirSync(join(root,name));
  const paths=instancePaths(join(root,'workspace'),join(root,'state'),{PICLAW_STORE:join(root,'store'),PICLAW_DATA:join(root,'data'),PI_CODING_AGENT_DIR:join(root,'profile')});
  expect(paths.sources.map(s=>s.name)).toEqual(['workspace','store','data','profile']);expect(paths.stageDir).not.toContain('smith');
  expect(()=>verifyExpectedMount(join(root,'fake-mount'),join(root,'fake-mount'))).toThrow('not mounted');
  expect(()=>instancePaths('relative',join(root,'state'),{})).toThrow();
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('state-directory aliases preserve staging identity',async()=>{
 const {symlinkSync}=await import('node:fs');const root=mkdtempSync(join(tmpdir(),'restic-state-alias-'));
 try{const workspace=join(root,'workspace'),state=join(root,'state'),alias=join(root,'alias');mkdirSync(workspace);mkdirSync(state);symlinkSync(state,alias);
 const a=instancePaths(workspace,state,{}),b=instancePaths(workspace,alias,{});expect(a.stateDir).toBe(b.stateDir);expect(a.stageDir).toBe(b.stageDir);
 expect(()=>instancePaths(workspace,'relative',{})).toThrow('absolute');
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('workspace TMPDIR uses external staging; explicit scratch roots are validated',async()=>{
 const {tmpdir}=await import('node:os');const {stagingRoot}=await import('./paths.ts');
 const tmp=tmpdir(),root=mkdtempSync(join(tmp,'restic-production-paths-'));
 try{
  const state=join(root,'state');mkdirSync(state);
  // Model a host whose entire temporary directory is inside its backup workspace.
  const sources=[{name:'workspace',path:tmp}];
  const safe=stagingRoot(sources,'piclaw-restic-fixture',{});
  expect(safe.startsWith(tmp+'/')).toBe(false);
  const paths=instancePaths(tmp,state,{});expect(paths.stageDir.startsWith(tmp+'/')).toBe(false);
  expect(()=>stagingRoot(sources,'fixture',{PICLAW_RESTIC_STAGING_ROOT:root})).toThrow('No safe');
  expect(()=>stagingRoot(sources,'fixture',{PICLAW_RESTIC_STAGING_ROOT:'relative'})).toThrow('No safe');
  expect(()=>stagingRoot(sources,'fixture',{PICLAW_RESTIC_STAGING_ROOT:''})).toThrow('No safe');
  const custom=stagingRoot([{name:'workspace',path:join(root,'subsource')}],'fixture',{PICLAW_RESTIC_STAGING_ROOT:tmp});
  expect(custom).toBe(join(tmp,'fixture'));
 }finally{rmSync(root,{recursive:true,force:true});}
});

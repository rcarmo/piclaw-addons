import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import resticAddon from './index.ts';
import { resticRuntime } from './runtime-state.ts';
import { ResticService } from './service.ts';
import { defaultJobConfig } from './job-config.ts';

function fixture() {
  const root=mkdtempSync(join(tmpdir(),'restic-tool-'));
  const state=resticRuntime(),previous=state.service;let secretReads=0,runs=0;
  const service=new ResticService({paths:{sources:[{name:'workspace',path:root}],stateDir:join(root,'state'),stageDir:join(root,'stage'),cacheDir:join(root,'cache')},resolveSecret:async()=>{secretReads++;throw Error('Must not resolve secrets');},run:async()=>{runs++;throw Error('Must not execute Restic');}});
  state.service=service;let tool:any;resticAddon({registerTool(value:any){tool=value;}});
  const execute=(params:any,signal?:AbortSignal)=>tool.execute('fixture',params,signal);
  return {root,service,tool,execute,counts:()=>({secretReads,runs}),cleanup(){service.stop();state.service=previous;rmSync(root,{recursive:true,force:true});}};
}
test('agent reads/sets complete validated config shared with Settings without secret lookup or child launch',async()=>{
 const f=fixture();try{
  expect(f.tool.name).toBe('restic');expect(f.tool.parameters.properties.action.enum).toEqual(['get_config','set_config','status']);
  const initial=await f.execute({action:'get_config'});expect(initial.details.config).toEqual(defaultJobConfig());
  const config={...initial.details.config,repository:{backend:'azure',account:'backupaccount',container:'backups',prefix:'instance',accountKeyRef:'azure/key'},passwordRef:'restic/password',schedule:{enabled:false,hours:[7,12,23],minute:15,timezone:'Europe/Lisbon'},retention:{enabled:false,hourly:6,daily:5,weekly:3,monthly:2}};
  const saved=await f.execute({action:'set_config',config});expect(saved.details.config).toEqual(config);
  expect(JSON.parse(readFileSync(join(f.root,'state/config.json'),'utf8'))).toEqual(config);
  expect((await f.execute({action:'get_config'})).details.config).toEqual(config);
  expect((await f.execute({action:'status'})).details.state.running).toBe(false);
  // Backend/Settings changes are reflected; no stale per-chat configuration copy.
  await f.service.setConfig({...config,excludes:['**/.cache','workspace/tmp']});
  expect((await f.execute({action:'get_config'})).details.config.excludes).toEqual(['**/.cache','workspace/tmp']);
  expect(f.counts()).toEqual({secretReads:0,runs:0});
 }finally{f.cleanup();}
});
test('tool cannot bypass validation, successful-backup gate or running-job locks',async()=>{
 const f=fixture();try{
  const config={...defaultJobConfig(),repository:{backend:'local',path:join(f.root,'repo')},passwordRef:'restic/password'};
  await expect(f.execute({action:'set_config',config:{...config,password:'do-not-store-secret'}})).rejects.toThrow('config fields');
  await expect(f.execute({action:'set_config',config:{...config,enabled:true}})).rejects.toThrow('manual backup');
  await f.execute({action:'set_config',config});
  const release=(f.service as any).acquire();try{await expect(f.execute({action:'set_config',config})).rejects.toThrow('running');}finally{release();}
  for(const action of ['backup','init','applyRetention','installBinary','restore'])await expect(f.execute({action})).rejects.toThrow('Invalid');
  await expect(f.execute({action:'get_config',config})).rejects.toThrow('Only set_config');
  await expect(f.execute({action:'get_config',workspaceRoot:'/forged'})).rejects.toThrow('Invalid');
  await expect(f.execute({action:'set_config'})).rejects.toThrow('config');
  expect(f.counts()).toEqual({secretReads:0,runs:0});
 }finally{f.cleanup();}
});
test('legacy configs load through agent reads and save without the retired acknowledgement',async()=>{
 const f=fixture();try{
  writeFileSync(join(f.root,'state/config.json'),JSON.stringify({...defaultJobConfig(),migrationAcknowledged:false}));
  const read=await f.execute({action:'get_config'});expect(read.details.config).not.toHaveProperty('migrationAcknowledged');
  await f.execute({action:'set_config',config:read.details.config});
  expect(JSON.parse(readFileSync(join(f.root,'state/config.json'),'utf8'))).not.toHaveProperty('migrationAcknowledged');
 }finally{f.cleanup();}
});
test('tool registration does not initialise services, and runtime absence/cancel fail closed',async()=>{
 const state=resticRuntime(),previous=state.service;state.service=undefined;
 try{let tool:any;resticAddon({registerTool(value:any){tool=value;}});expect(state.service).toBeUndefined();
  await expect(tool.execute('no-runtime',{action:'get_config'})).rejects.toThrow('startup runtime');
  const controller=new AbortController();controller.abort();await expect(tool.execute('aborted',{action:'get_config'},controller.signal)).rejects.toThrow();
  const other=await import(`./runtime-state.ts?another-loader=${Date.now()}`);expect(other.resticRuntime()).toBe(state);
 }finally{state.service=previous;}
 const manifest=JSON.parse(readFileSync(new URL('./package.json',import.meta.url),'utf8'));
 expect(manifest.piclaw.tags).toContain('core');expect(manifest.files).toContain('runtime-state.ts');
});

test('strict provider schema accepts config:null for both reads without mutations',async()=>{
 const {Type}=await import('typebox');const {Check}=await import('typebox/value');
 const f=fixture();try{
  // Mimic providers which recursively require all declared object properties.
  const strict=(v:any):any=>{if(Array.isArray(v))return v.map(strict);if(!v||typeof v!=='object')return v;const out=Object.fromEntries(Object.entries(v).map(([k,x])=>[k,strict(x)]));if(out.properties){out.required=Object.keys(out.properties);out.additionalProperties=false;}return out;};
  const schema=Type.Unsafe(strict(f.tool.parameters));
  expect(f.tool.parameters.required).toEqual(['action','config']);
  for(const action of ['get_config','status']){
   expect(Check(schema,{action,config:null})).toBe(true);
   const result=await f.execute({action,config:null});expect(result.details[action==='get_config'?'config':'state']).toBeTruthy();
  }
  expect(f.service.config).toEqual(defaultJobConfig());expect(f.counts()).toEqual({secretReads:0,runs:0});
  await expect(f.execute({action:'set_config',config:null})).rejects.toThrow('complete configuration');
  await expect(f.execute({action:'get_config',config:defaultJobConfig()})).rejects.toThrow('Only set_config');
  const fields=Object.keys(f.tool.parameters.properties.config.properties.repository.properties);
  const cases=[
   {backend:'local',path:join(f.root,'repo')},
   {backend:'sftp',host:'backup.example',port:22,user:'backup',path:'/repo',privateKeyRef:'ssh/key',knownHostsRef:'ssh/hosts'},
   {backend:'s3',endpoint:'https://s3.example',region:'us-east-1',bucket:'backups',prefix:'',accessKeyRef:'s3/key',secretKeyRef:'s3/secret'},
   {backend:'azure',account:'backupaccount',container:'backups',prefix:'',accountKeyRef:'azure/key'},
  ];
  for(const repository of cases){
   const expanded={...Object.fromEntries(fields.map(k=>[k,null])),...repository};
   const config={...defaultJobConfig(),repository:expanded,passwordRef:'restic/password'};
   expect(Check(schema,{action:'set_config',config})).toBe(true);
   expect((await f.execute({action:'set_config',config})).details.config.repository).toEqual(repository);
   expect(config.repository).toEqual(expanded); // callers are not mutated
  }
  const base={...defaultJobConfig(),repository:cases[0],passwordRef:'restic/password'};
  await expect(f.execute({action:'set_config',config:{...base,repository:{...base.repository,unknown:null}}})).rejects.toThrow('fields');
  await expect(f.execute({action:'set_config',config:{...base,repository:{...base.repository,path:null}}})).rejects.toThrow();
  expect(f.counts()).toEqual({secretReads:0,runs:0});
 }finally{f.cleanup();}
});

import { expect,test } from 'bun:test';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { ResticService } from './service.ts';
import { defaultJobConfig,nextRun,validateJobConfig } from './job-config.ts';
import type { RunOptions,RunResult } from './contracts.ts';
function fixture(run?: (o:RunOptions)=>Promise<RunResult>){
  const root=mkdtempSync(join(tmpdir(),'restic-service-'));const source=join(root,'source');mkdirSync(source);writeFileSync(join(source,'note.txt'),'recover me');
  const paths={sources:[{name:'workspace',path:source}],stateDir:join(root,'state'),stageDir:join(root,'stage'),cacheDir:join(root,'cache')};
  const wrappedRun=run?async(o:RunOptions)=>o.args[0]==='options'?{code:0,stdout:'local.connections\nsftp.command\ns3.region\nazure.connections\n',stderr:'',durationMs:0}:run(o):undefined;
  const service=new ResticService({paths,resolveSecret:async()=> 'fixture-encryption-password-only',run:wrappedRun});
  const config={...defaultJobConfig(),binary:process.env.PICLAW_RESTIC_TEST_BINARY||'restic',repository:{backend:'local' as const,path:join(root,'repo')},passwordRef:'fixture/password'};
  return {root,source,paths,service,config,cleanup(){service.stop();rmSync(root,{recursive:true,force:true});}};
}
(process.env.PICLAW_RESTIC_TEST_BINARY?test:test.skip)('real local init → WAL-consistent backup → scoped list → check → empty restore; no production IO',async()=>{
  const f=fixture();const db=new Database(join(f.source,'live.db'));
  try{
    db.exec('PRAGMA journal_mode=WAL;CREATE TABLE items(id INTEGER);INSERT INTO items VALUES(1);PRAGMA wal_checkpoint(TRUNCATE);INSERT INTO items VALUES(2)');
    await f.service.setConfig(f.config);
    await expect(f.service.execute('test')).rejects.toThrow();expect(existsSync(join(f.root,'repo','config'))).toBe(false);
    await expect(f.service.execute('init')).rejects.toThrow('confirmation');
    await f.service.execute('init',{confirmation:'INITIALISE REPOSITORY'});
    expect((await f.service.execute('test') as any).version).toBeGreaterThan(0);
    const backup:any=await f.service.execute('backup');expect(backup.status).toBe('success');expect(backup.snapshotId).toBeTruthy();
    expect(existsSync(f.paths.stageDir)).toBe(false);
    const snapshots:any=await f.service.execute('snapshots');expect(snapshots).toHaveLength(1);
    await f.service.execute('check');
    const target=join(f.root,'restored');mkdirSync(target);
    await expect(f.service.execute('restore',{snapshot:snapshots[0].id,target:f.source,confirmation:'RESTORE TO EMPTY DIRECTORY'})).rejects.toThrow('empty');
    const restored:any=await f.service.execute('restore',{snapshot:snapshots[0].id,target,confirmation:'RESTORE TO EMPTY DIRECTORY'});
    expect(readFileSync(join(restored.restored,'workspace/note.txt'),'utf8')).toBe('recover me');expect(restored.databases).toBe(1);
    const recovered=new Database(join(restored.restored,'workspace/live.db'),{readonly:true});expect(recovered.query('select count(*) as n from items').get()).toEqual({n:2});recovered.close();
    expect(db.query('select count(*) as n from items').get()).toEqual({n:2});
    await f.service.setConfig({...f.config,enabled:true,schedule:{...f.config.schedule,enabled:true}});
    expect(f.service.status.nextRun).toBeGreaterThan(Date.now());
    const reload=new ResticService({paths:f.paths,resolveSecret:async()=>''});expect(reload.state.instanceId).toBe(f.service.state.instanceId);reload.stop();
  }finally{db.close();f.cleanup();}
},60000);
test('single missed schedule slot claimed once; no burst and timezone validation',async()=>{
  const s={enabled:true,hours:[8,12,20],minute:0,timezone:'Europe/Lisbon'};
  expect(nextRun(s,Date.parse('2026-01-01T08:00:00Z'))).toBe(Date.parse('2026-01-01T12:00:00Z'));
  expect(()=>validateJobConfig({...defaultJobConfig(),schedule:{...s,timezone:'invalid'}})).toThrow();
  const f=fixture();try{let calls=0;f.service.config={...f.config,enabled:true,schedule:s};f.service.state.nextRun=1;writeFileSync(join(f.paths.stateDir,'config.json'),JSON.stringify(f.service.config));writeFileSync(join(f.paths.stateDir,'state.json'),JSON.stringify(f.service.state));(f.service as any).perform=async(_a:any,_p:any,release:()=>void)=>{calls++;(f.service as any).active=undefined;release();};const now=Date.parse('2026-01-02T13:00:00Z');await f.service.tick(now);await f.service.tick(now);expect(calls).toBe(1);expect(f.service.status.nextRun).toBeGreaterThan(now);}finally{f.cleanup();}
});
test('overlap blocks independent service instances; cancellation releases lock',async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);
  const run=async(o:RunOptions)=>{if(o.args[0]==='version')return {code:0,stdout:'restic 0.18.1',stderr:'',durationMs:0};await gate;return {code:0,stdout:'{}',stderr:'',durationMs:0};};
  const f=fixture(run);const other=new ResticService({paths:f.paths,resolveSecret:async()=>'',run:async o=>o.args[0]==='options'?{code:0,stdout:'local.connections\nsftp.command\ns3.region\nazure.connections\n',stderr:'',durationMs:0}:run(o)});
  try{await f.service.setConfig(f.config);await other.setConfig(f.config);const job=f.service.execute('test');await Bun.sleep(10);await expect(other.execute('test')).rejects.toThrow('running');await expect(f.service.setConfig(f.config)).rejects.toThrow('running');release();await job;await expect(other.execute('test')).resolves.toEqual({});}finally{release();other.stop();f.cleanup();}
});
test('incomplete backups never qualify retention; errors redact secrets and no force unlock',async()=>{
  const calls:string[][]=[];const run=async(o:RunOptions)=>{calls.push(o.args);if(o.args[0]==='version')return {code:0,stdout:'restic 0.18.1',stderr:'',durationMs:0};return {code:3,stdout:'{"message_type":"summary","snapshot_id":"abc"}\n',stderr:'',durationMs:1};};
  const f=fixture(run);try{await f.service.setConfig({...f.config,retention:{...f.config.retention,enabled:true}});expect((await f.service.execute('backup') as any).status).toBe('incomplete');await expect(f.service.execute('previewRetention')).rejects.toThrow('succeeded');expect(calls.some(args=>args.includes('prune')||args.includes('forget')||args.includes('unlock'))).toBe(false);}finally{f.cleanup();}
});

test('retention pins exact scoped IDs, rejects stale preview and reports prune separately',async()=>{
  const id='a'.repeat(64),id2='b'.repeat(64),calls:string[][]=[];let alter=false,pruneFailure=false;
  let f:ReturnType<typeof fixture>;
  const run=async(o:RunOptions):Promise<RunResult>=>{
    calls.push(o.args);let stdout='';let code=0,stderr='';
    const snapshot=(id:string)=>({id,time:new Date().toISOString(),hostname:f.service.state.instanceId,tags:[f.service.tag],paths:[f.paths.stageDir]});
    if(o.args[0]==='version')stdout='restic 0.18.1';
    else if(o.args.includes('backup'))stdout=JSON.stringify({message_type:'summary',snapshot_id:id});
    else if(o.args.includes('snapshots'))stdout=JSON.stringify([snapshot(id),snapshot(id2)]);
    else if(o.args.includes('--dry-run'))stdout=JSON.stringify([{remove:[snapshot(alter?id2:id)]}]);
    else if(o.args.includes('prune')&&pruneFailure){code=1;stderr='fixture prune failed';}
    return {code,stdout,stderr,durationMs:0};
  };
  f=fixture(run);
  try{
    await f.service.setConfig({...f.config,retention:{...f.config.retention,enabled:true}});await f.service.execute('backup');
    let preview:any=await f.service.execute('previewRetention');
    await expect(f.service.execute('applyRetention',{...preview,ids:[id2],confirmation:'DELETE PREVIEWED SNAPSHOTS'})).rejects.toThrow('Fresh exact');
    alter=true;await expect(f.service.execute('applyRetention',{...preview,confirmation:'DELETE PREVIEWED SNAPSHOTS'})).rejects.toThrow('changed');
    expect(calls.some(x=>x.includes('forget')&&!x.includes('--dry-run'))).toBe(false);
    alter=false;preview=await f.service.execute('previewRetention');pruneFailure=true;
    await expect(f.service.execute('applyRetention',{...preview,confirmation:'DELETE PREVIEWED SNAPSHOTS'})).rejects.toThrow('prune');
    expect(f.service.status.backup?.status).toBe('success');expect(f.service.status.maintenance?.status).toBe('failed');
    expect(calls.find(x=>x.includes('forget')&&!x.includes('--dry-run'))?.slice(-2)).toEqual(['forget',id]);
    const changed={...f.service.config,repository:{backend:'local' as const,path:join(f.root,'other-repo')}};
    await f.service.setConfig(changed);expect(f.service.status.lastSuccess).toBeUndefined();
    await expect(f.service.execute('previewRetention')).rejects.toThrow('succeeded');
    await expect(f.service.setConfig({...changed,enabled:true})).rejects.toThrow('manual backup');
  }finally{f.cleanup();}
});

test('failed/locked repository and missing binary never launch maintenance',async()=>{
  const calls:string[][]=[];const run=async(o:RunOptions):Promise<RunResult>=>{calls.push(o.args);return o.args[0]==='version'?{code:0,stdout:'restic 0.18.1',stderr:'',durationMs:0}:{code:11,stdout:'',stderr:'repository locked fixture-encryption-password-only',durationMs:0};};
  const f=fixture(run);try{
    await f.service.setConfig(f.config);await expect(f.service.execute('backup')).rejects.toThrow('repository locked [redacted]');
    expect(JSON.stringify(f.service.status)).not.toContain('fixture-encryption-password-only');expect(f.service.status.backup?.status).toBe('failed');
    await f.service.setConfig({...f.config,binary:join(f.root,'missing')});await expect(f.service.execute('test')).rejects.toThrow('binary is missing');
    expect(calls.some(x=>x.includes('unlock')||x.includes('prune'))).toBe(false);
  }finally{f.cleanup();}
});

test('migration guard and rollback keep only one scheduler enabled',async()=>{
 const f=fixture(async o=>({code:0,stdout:o.args[0]==='version'?'restic 0.18.1':JSON.stringify({message_type:'summary',snapshot_id:'a'.repeat(64)}),stderr:'',durationMs:0}));
 let legacy=true;const guarded=new ResticService({paths:f.paths,resolveSecret:async()=> 'fixture-only',legacySchedulerActive:async()=>legacy,run:async o=>({code:0,stdout:o.args[0]==='options'?'local.connections\nsftp.command\ns3.region\nazure.connections\n':o.args[0]==='version'?'restic 0.18.1':JSON.stringify({message_type:'summary',snapshot_id:'a'.repeat(64)}),stderr:'',durationMs:0})});
 try{
  await guarded.setConfig(f.config);await expect(guarded.execute('backup')).rejects.toThrow('Previous Restic scheduler');
  await expect(guarded.setConfig({...f.config,enabled:true})).rejects.toThrow('Previous Restic scheduler');
  legacy=false;await guarded.execute('backup');
  await guarded.setConfig({...f.config,enabled:true,schedule:{...f.config.schedule,enabled:true}});expect(guarded.status.nextRun).toBeTruthy();
  await guarded.setConfig({...guarded.config,enabled:false});expect(guarded.status.nextRun).toBeUndefined();
  // Only after disabled add-on state is persisted can operator restore the previous timer.
  legacy=true;const reopened=new ResticService({paths:f.paths,resolveSecret:async()=>''});expect(reopened.config.enabled).toBe(false);reopened.stop();
 }finally{guarded.stop();f.cleanup();}
});

test('configuration await cannot race admitted backup; interrupted attempt revokes retention eligibility',async()=>{
 const f=fixture();let validateRelease!:()=>void;let workRelease!:()=>void;
 const validationGate=new Promise<void>(r=>validateRelease=r),workGate=new Promise<void>(r=>workRelease=r);
 const run=async(o:RunOptions):Promise<RunResult>=>{if(o.args[0]==='version')return {code:0,stdout:'restic 0.18.1',stderr:'',durationMs:0};if(o.args[0]==='options')return {code:0,stdout:'local.connections\nsftp.command\ns3.region\nazure.connections\n',stderr:'',durationMs:0};await workGate;return {code:0,stdout:JSON.stringify({message_type:'summary',snapshot_id:'a'.repeat(64)}),stderr:'',durationMs:0};};
 let guard=false;
 const service=new ResticService({paths:f.paths,resolveSecret:async()=> 'fixture',run,legacySchedulerActive:async()=>{if(guard){guard=false;await validationGate;}return false;}});
 try{
  await service.setConfig(f.config);
  // Establish valid success, then hold the next operation in flight.
  service.state.lastSuccess=new Date().toISOString();service.state.backup={status:'success',at:service.state.lastSuccess};
  (service.state as any).successRepository=(service as any).repositoryIdentity();
  writeFileSync(join(f.paths.stateDir,'state.json'),JSON.stringify(service.state));
  guard=true;const saving=service.setConfig({...f.config,enabled:true}).then(()=>null,e=>e);
  await Bun.sleep(1);const job=service.execute('backup');validateRelease();expect((await saving)?.message).toContain('started while validating');
  const persisted=JSON.parse(readFileSync(join(f.paths.stateDir,'state.json'),'utf8'));
  expect(persisted.backup.status).toBe('failed');expect(persisted.operation.status).toBe('running');
  const reloaded=new ResticService({paths:f.paths,resolveSecret:async()=>''});expect(reloaded.state.backup?.status).toBe('failed');expect(reloaded.status.operation?.status).toBe('interrupted');reloaded.stop();
  workRelease();await job;
 }finally{validateRelease();workRelease();service.stop();f.cleanup();}
});
test('queued admission rejects stale/active lock before acknowledging work',async()=>{
 const f=fixture();try{
  mkdirSync(join(f.paths.stateDir,'job.lock'));writeFileSync(join(f.paths.stateDir,'job.lock/owner.json'),JSON.stringify({pid:process.pid,token:'other'}));
  expect(()=>f.service.submit('backup')).toThrow('running');expect(f.service.status.running).toBe(false);
 }finally{f.cleanup();}
});

test('durable admission blocks stale-instance retention after failed, incomplete or successful peer backup',async()=>{
 const id='a'.repeat(64),calls:string[][]=[];let backupCode=0;let f:ReturnType<typeof fixture>;
 const run=async(o:RunOptions):Promise<RunResult>=>{
  calls.push(o.args);const snapshot={id,time:new Date().toISOString(),hostname:f.service.state.instanceId,tags:[f.service.tag],paths:[f.paths.stageDir]};
  if(o.args[0]==='version')return {code:0,stdout:'restic 0.18.1',stderr:'',durationMs:0};
  if(o.args[0]==='options')return {code:0,stdout:'local.connections\nsftp.command\ns3.region\nazure.connections\n',stderr:'',durationMs:0};
  if(o.args.includes('backup'))return {code:backupCode,stdout:JSON.stringify({message_type:'summary',snapshot_id:id}),stderr:backupCode===1?'fixture failed':'',durationMs:0};
  return {code:0,stdout:JSON.stringify(o.args.includes('snapshots')?[snapshot]:[{remove:[snapshot]}]),stderr:'',durationMs:0};
 };
 f=fixture(run);let peer:ResticService|undefined;
 try{
  await f.service.setConfig({...f.config,retention:{...f.config.retention,enabled:true}});await f.service.execute('backup');
  peer=new ResticService({paths:f.paths,resolveSecret:async()=> 'fixture',run});
  for(const code of [1,3,0]){
   backupCode=0;await f.service.execute('backup');const preview:any=await f.service.execute('previewRetention');
   const beforeAttempt=f.service.state.backupAttempt;backupCode=code;
   if(code===1)await expect(peer.execute('backup')).rejects.toThrow('backup failed (exit 1)');else await peer.execute('backup');
   expect(peer.state.backupAttempt).not.toBe(beforeAttempt);
   // Snapshot listing/retention IDs did not change, but the durable attempt identity did.
   await expect(f.service.execute('applyRetention',{...preview,confirmation:'DELETE PREVIEWED SNAPSHOTS'})).rejects.toThrow(code===0?'Fresh exact':'succeeded');
   const persisted=JSON.parse(readFileSync(join(f.paths.stateDir,'state.json'),'utf8'));
   expect(persisted.backupAttempt).toBe(peer.state.backupAttempt);
   expect(persisted.backup.status).toBe(code===0?'success':code===3?'incomplete':'failed');
  }
  expect(calls.some(x=>x.includes('prune')||(x.includes('forget')&&!x.includes('--dry-run')))).toBe(false);
  await peer.setConfig({...peer.config,repository:{backend:'local',path:join(f.root,'changed-repo')}});
  await f.service.execute('snapshots');expect(f.service.config.repository).toEqual(peer.config.repository);
  expect(f.service.state.lastSuccess).toBeUndefined();
 }finally{peer?.stop();f.cleanup();}
});

test('service construction cannot overwrite durable in-flight state and config cannot bypass peer lock',async()=>{
 const f=fixture();try{
  const current={...f.service.state,backupAttempt:'durable-attempt',backup:{status:'failed',at:new Date().toISOString()},operation:{action:'backup',status:'running',at:new Date().toISOString()}};
  writeFileSync(join(f.paths.stateDir,'state.json'),JSON.stringify(current));
  mkdirSync(join(f.paths.stateDir,'job.lock'));writeFileSync(join(f.paths.stateDir,'job.lock/owner.json'),JSON.stringify({pid:process.pid,token:'active-peer'}));
  const peer=new ResticService({paths:f.paths,resolveSecret:async()=>''});
  expect(JSON.parse(readFileSync(join(f.paths.stateDir,'state.json'),'utf8'))).toEqual(current);
  await expect(peer.setConfig(f.config)).rejects.toThrow('running');peer.stop();
 }finally{f.cleanup();}
});

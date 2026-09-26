import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, readdirSync, realpathSync, lstatSync } from 'node:fs';
import { dirname, join, isAbsolute, relative } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { defaultJobConfig, validateJobConfig, nextRun, type JobConfig } from './job-config.ts';
import { prepareTransport, runRestic } from './runner.ts';
import { stageSources, verifyRestore } from './staging.ts';
import { assertBackupPaths } from './repository.ts';
import { verifyExpectedMount, type InstancePaths } from './paths.ts';
import { installManaged, resolveBinary } from './binary.ts';
import type { RunOptions, RunResult } from './contracts.ts';
export interface Snapshot { id:string; time:string; hostname:string; tags:string[]; paths:string[]; }
type Outcome={status:'success'|'failed'|'incomplete';at:string;message?:string;snapshotId?:string;durationMs?:number;bytes?:number};
interface State { instanceId:string; lastAttempt?:string;lastSuccess?:string;successRepository?:string;backup?:Outcome;maintenance?:Outcome;nextRun?:number;logs:string[]; operation?:{action:string;status:string;result?:unknown;message?:string;at:string}; }
interface Options { paths:InstancePaths; resolveSecret:(ref:string)=>Promise<string>; run?:(o:RunOptions)=>Promise<RunResult>; legacySchedulerActive?:()=>Promise<boolean>; }
export class ResticService {
  config:JobConfig; state:State; private active?:AbortController; private timer?:ReturnType<typeof setInterval>;
  private preview?:{token:string;ids:string[];expires:number;fingerprint:string}; private run:(o:RunOptions)=>Promise<RunResult>;
  readonly paths:InstancePaths;
  constructor(private options:Options){
    this.paths=options.paths;this.run=options.run||runRestic;
    mkdirSync(this.paths.stateDir,{recursive:true,mode:0o700});
    this.config=this.load('config.json',defaultJobConfig());this.config=validateJobConfig(this.config);
    this.state=this.load('state.json',{instanceId:randomUUID(),logs:[]});
    if(!/^[a-f0-9-]{36}$/.test(this.state.instanceId))throw Error('Invalid persisted instance identity');
    if(this.state.operation?.status==='running')this.state.operation={...this.state.operation,status:'interrupted',message:'Previous operation did not finish; inspect job lock and staging before recovery'};
    this.save('state.json',this.state);
  }
  private load<T>(name:string,fallback:T):T {const p=join(this.paths.stateDir,name);return existsSync(p)?JSON.parse(readFileSync(p,'utf8')):fallback;}
  private save(name:string,value:unknown){const p=join(this.paths.stateDir,name),t=p+'.tmp';writeFileSync(t,JSON.stringify(value,null,2)+'\n',{mode:0o600});renameSync(t,p);}
  private persist(){this.state.logs=this.state.logs.slice(-40);this.save('state.json',this.state);}
  private repositoryIdentity(){return createHash('sha256').update(JSON.stringify({repository:this.config.repository,passwordRef:this.config.passwordRef,sources:this.paths.sources})).digest('hex');}
  private fingerprint(){return createHash('sha256').update(JSON.stringify(this.config)).digest('hex');}
  get status(){return {...this.state,running:Boolean(this.active)};}
  get tag(){return `piclaw:${this.state.instanceId}`;}
  async setConfig(input:unknown){
    if(this.active)throw Error('Backup operation is running');const c=validateJobConfig(input);
    if(c.enabled && (await this.options.legacySchedulerActive?.()))throw Error('Previous Restic scheduler is active; disable it explicitly before enabling');
    if(this.active)throw Error('Backup operation started while validating configuration; retry after it finishes');
    if(c.enabled && (this.state.successRepository!==this.repositoryIdentity()||!this.state.lastSuccess||this.state.backup?.status!=='success'||JSON.stringify(c.repository)!==JSON.stringify(this.config.repository)||c.passwordRef!==this.config.passwordRef))throw Error('Verify a successful manual backup with this repository before enabling');
    const oldIdentity=this.repositoryIdentity();
    this.config=c;if(oldIdentity!==this.repositoryIdentity()){this.state.lastSuccess=undefined;this.state.successRepository=undefined;this.state.backup=undefined;}this.preview=undefined;this.state.nextRun=c.enabled&&c.schedule.enabled?nextRun(c.schedule,Date.now()):undefined;
    this.save('config.json',c);this.persist();return c;
  }
  start(){if(this.timer)return;this.timer=setInterval(()=>{void this.tick().catch(()=>{});},30000);this.timer.unref();}
  stop(){if(this.timer)clearInterval(this.timer);this.timer=undefined;this.active?.abort();}
  async tick(now=Date.now()){
    if(!this.config.enabled||!this.config.schedule.enabled||this.active)return;
    if(!this.state.nextRun){this.state.nextRun=nextRun(this.config.schedule,now);this.persist();return;}
    if(this.state.nextRun>now)return;
    // Persist the single claimed run before launch: restart never replays a burst.
    this.state.nextRun=nextRun(this.config.schedule,now);this.persist();
    await this.execute('backup');
  }
  private acquire(){
    const lock=join(this.paths.stateDir,'job.lock');
    try{mkdirSync(lock,{mode:0o700});}catch{
      const p=join(lock,'owner.json');if(!existsSync(p))throw Error('Backup lock requires operator inspection');
      const owner=JSON.parse(readFileSync(p,'utf8'));if(!Number.isInteger(owner.pid)||owner.pid<1)throw Error('Invalid backup lock');
      try{process.kill(owner.pid,0);throw Error('Another backup operation is running');}catch(e:any){if(e.code!=='ESRCH')throw e;}
      throw Error('Interrupted backup lock requires operator recovery after confirming all Restic children exited');
    }
    const token=randomUUID();writeFileSync(join(lock,'owner.json'),JSON.stringify({pid:process.pid,token}),{mode:0o600});
    return ()=>{if(existsSync(join(lock,'owner.json'))&&JSON.parse(readFileSync(join(lock,'owner.json'),'utf8')).token===token)rmSync(lock,{recursive:true});};
  }
  private async binary(){return resolveBinary(this.config.binary,this.paths.stateDir,this.run);}
  async info(){let binary;try{binary=await this.binary();}catch(e){binary={error:(e as Error).message};}return {config:this.config,paths:this.paths,binary,migration:{acknowledged:this.config.migrationAcknowledged,legacySchedulerActive:await this.options.legacySchedulerActive?.()||false}};}
  cancel(){this.active?.abort();return {cancelled:Boolean(this.active)};}
  async execute(action:string,payload:Record<string,any>={}){return this.submit(action,payload);}
  /** Synchronous admission must succeed before the API acknowledges queued work. */
  submit(action:string,payload:Record<string,any>={}):Promise<any>{
    if(action==='cancel')return Promise.resolve(this.cancel());
    if(!['test','backup','snapshots','check','previewRetention','applyRetention','init','restore','installBinary'].includes(action))throw Error('Unknown Restic action');
    if(this.active)throw Error('Another backup operation is running');
    const release=this.acquire();this.active=new AbortController();this.state.operation={action,status:'running',at:new Date().toISOString()};this.state.lastAttempt=new Date().toISOString();
    if(action==='backup'){this.state.backup={status:'failed',at:this.state.lastAttempt,message:'Backup started but has not completed; an interruption is not a successful backup'};this.preview=undefined;}
    this.persist();return this.perform(action,payload,release);
  }
  private async perform(action:string,payload:Record<string,any>,release:()=>void){
    let transport:Awaited<ReturnType<typeof prepareTransport>>|undefined;
    try{
      if(action==='installBinary'){const result=await installManaged(this.paths.stateDir,payload.confirmation,this.active!.signal);this.config={...this.config,binary:'managed'};this.save('config.json',this.config);this.state.operation={action,status:'success',result,at:new Date().toISOString()};return result;}
      const binary=await this.binary();
      if(this.config.repository?.backend==='local'){
        assertBackupPaths(this.paths.sources.map(x=>x.path),[this.config.repository.path]);
        verifyExpectedMount(this.config.repository.path,this.config.repository.expectedMount);
      }
      mkdirSync(dirname(this.paths.stageDir),{recursive:true,mode:0o700});
      assertBackupPaths(this.paths.sources.map(x=>x.path),[this.paths.stageDir,this.paths.cacheDir]);
      const {binary:_binary,excludes:_excludes,migrationAcknowledged:_migration,schedule:_schedule,...transportConfig}=this.config;
      // A prior process may have died before its credential finally block. The job lock proves no active owner.
      rmSync(join(dirname(this.paths.stageDir),'credentials'),{recursive:true,force:true});
      transport=await prepareTransport(transportConfig,join(dirname(this.paths.stageDir),'credentials'),this.options.resolveSecret);
      const command=async(args:string[],allowIncomplete=false)=>{
        const r=await this.run({binary:binary.path,args:[...transport!.args,'--cache-dir',this.paths.cacheDir,'--json',...args],env:transport!.env,signal:this.active!.signal,timeoutMs:6*3600000,maxOutputBytes:16*1024*1024,redact:transport!.secrets});
        if(r.code!==0&&!(allowIncomplete&&r.code===3))throw Error(`Restic ${args[0]} failed (exit ${r.code}): ${r.stderr.slice(-2000)}`);
        return r;
      };
      const scoped=['--host',this.state.instanceId,'--tag',this.tag,'--path',this.paths.stageDir];
      const snapshots=async():Promise<Snapshot[]>=>{
        const list=JSON.parse((await command(['snapshots',...scoped])).stdout);
        if(!Array.isArray(list)||list.some((x:any)=>!/^([a-f0-9]{64})$/.test(x.id)||x.hostname!==this.state.instanceId||!x.tags?.includes(this.tag)||x.paths?.length!==1||x.paths[0]!==this.paths.stageDir))throw Error('Snapshot scope validation failed');
        return list;
      };
      if(action==='test')return JSON.parse((await command(['cat','config'])).stdout);
      if(action==='snapshots')return await snapshots();
      if(action==='check'){await command(['check']);return {checked:'repository metadata (data packs not fully read)'};}
      if(action==='init'){if(payload.confirmation!=='INITIALISE REPOSITORY')throw Error('Explicit repository initialisation confirmation required');await command(['init']);return {initialised:true};}
      if(action==='backup'){
        if(await this.options.legacySchedulerActive?.())throw Error('Previous Restic scheduler is active; stop it before manual or scheduled backup');
        const exclusions=[...this.config.excludes];
        for(const source of this.paths.sources){const rel=relative(source.path,this.paths.stateDir);if(rel&&!rel.startsWith('..')&&!isAbsolute(rel))exclusions.push(`${source.name}/${rel}`);}
        const staged=await stageSources(this.paths.sources,this.paths.stageDir,exclusions,this.active!.signal);
        try{
          const r=await command(['backup','--host',this.state.instanceId,'--tag',this.tag,'--',staged.directory],true);
          const lines=r.stdout.split('\n').filter(Boolean).map(x=>JSON.parse(x));const summary=lines.find(x=>x.message_type==='summary');
          const complete=r.code===0&&summary?.snapshot_id;
          this.state.backup={status:complete?'success':'incomplete',at:new Date().toISOString(),snapshotId:summary?.snapshot_id,durationMs:r.durationMs,bytes:summary?.total_bytes_processed};
          if(complete){this.state.lastSuccess=this.state.backup.at;this.state.successRepository=this.repositoryIdentity();}
          this.preview=undefined;return this.state.backup;
        }finally{staged.cleanup();}
      }
      if(action==='restore'){
        if(payload.confirmation!=='RESTORE TO EMPTY DIRECTORY')throw Error('Explicit restore confirmation required');
        const list=await snapshots();const snapshot=list.find(x=>x.id===payload.snapshot);if(!snapshot)throw Error('Snapshot is outside this instance scope');
        const target=payload.target;if(typeof target!=='string'||!isAbsolute(target)||!existsSync(target)||!lstatSync(target).isDirectory()||lstatSync(target).isSymbolicLink()||realpathSync(target)!==target||readdirSync(target).length)throw Error('Restore target must be an existing empty real directory');
        assertBackupPaths([...this.paths.sources.map(x=>x.path),this.paths.stageDir,this.paths.cacheDir,this.paths.stateDir,...(this.config.repository?.backend==='local'?[this.config.repository.path]:[])],[target]);
        await command(['restore',snapshot.id,'--target',target]);
        const restored=join(target,this.paths.stageDir.replace(/^\/+/ ,''));
        let ancestor=target;for(const part of relative(target,restored).split('/')){ancestor=join(ancestor,part);if(lstatSync(ancestor).isSymbolicLink())throw Error('Restore tree contains an unsafe symlink ancestor');}
        const verification=await verifyRestore(restored);
        const result={target,restored,...verification,cutover:'Operator-controlled; live data has not been changed'};this.state.operation={action,status:'success',result,at:new Date().toISOString()};return result;
      }
      if(!this.state.lastSuccess||this.state.backup?.status!=='success'||this.state.successRepository!==this.repositoryIdentity())throw Error('Retention requires the latest backup attempt to have succeeded');
      const policy=this.config.retention;
      if(!policy.enabled)throw Error('Retention maintenance is disabled');
      const preview=async()=>{
        const args=['forget','--dry-run',...scoped,'--group-by','host,paths,tags'];
        for(const [key,val]of Object.entries(policy))if(key!=='enabled'&&val)args.push(`--keep-${key}`,String(val));
        const groups=JSON.parse((await command(args)).stdout);if(!Array.isArray(groups))throw Error('Invalid retention preview');
        const all=await snapshots();const ids=groups.flatMap((x:any)=>(x.remove||[]).map((s:any)=>s.id)).sort();
        if(ids.some((id:string)=>!all.some(s=>s.id===id)))throw Error('Retention scope validation failed');return ids as string[];
      };
      if(action==='previewRetention'){const ids=await preview();this.preview={token:randomUUID(),ids,expires:Date.now()+5*60000,fingerprint:this.fingerprint()};return {...this.preview};}
      if(payload.confirmation!=='DELETE PREVIEWED SNAPSHOTS'||!this.preview||this.preview.token!==payload.token||this.preview.expires<Date.now()||this.preview.fingerprint!==this.fingerprint()||JSON.stringify(payload.ids)!==JSON.stringify(this.preview.ids))throw Error('Fresh exact retention preview and confirmation required');
      const selected=this.preview;this.preview=undefined;
      if(JSON.stringify(await preview())!==JSON.stringify(selected.ids))throw Error('Snapshot set changed; preview retention again');
      if(selected.ids.length){await command(['forget',...selected.ids]);await command(['prune']);}
      this.state.maintenance={status:'success',at:new Date().toISOString(),message:`Removed ${selected.ids.length} snapshots; prune completed`};return this.state.maintenance;
    }catch(e){
      let message=(e instanceof Error?e.message:'Restic operation failed');for(const secret of transport?.secrets||[])if(secret)message=message.split(secret).join('[redacted]');message=message.slice(0,2000);
      if(action==='backup')this.state.backup={status:'failed',at:new Date().toISOString(),message};
      if(action==='applyRetention')this.state.maintenance={status:'failed',at:new Date().toISOString(),message};
      this.state.operation={action,status:'failed',message,at:new Date().toISOString()};this.state.logs.push(`${action}: ${message}`);throw Error(message);
    }finally{try{transport?.cleanup();this.active=undefined;if(this.state.operation?.status==='running')this.state.operation={action,status:'finished',at:new Date().toISOString()};this.persist();}finally{release();}}
  }
}

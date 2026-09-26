import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ResticService } from './service.ts';
import { instancePaths } from './paths.ts';
import { resticRuntime } from './runtime-state.ts';
export async function resolveKeychainSecret(name:string):Promise<string>{
  const bridge=(globalThis as any).__piclawRuntimeInterop;
  // Only the named entry; never import the entire keychain into a child process.
  if(typeof bridge?.getKeychainEntry==='function'){
    const entry=await bridge.getKeychainEntry(name);
    if(typeof entry?.secret==='string'&&entry.secret)return entry.secret;
    throw Error('Required keychain reference is missing');
  }
  const value=process.env[name.replace(/[/.-]/g,'_').toUpperCase()];
  if(!value)throw Error('Required keychain reference is unavailable');return value;
}
async function legacySchedulerActive():Promise<boolean>{
  if(process.platform!=='linux')return false;
  // Read-only detection; never disable units or evaluate imported scripts.
  const systemctl=Bun.which('systemctl');
  if(systemctl){
    const proc=Bun.spawn([systemctl,'--user','is-active','restic-backup.timer','restic-backup.service'],{stdout:'pipe',stderr:'ignore',env:{PATH:process.env.PATH||'',XDG_RUNTIME_DIR:process.env.XDG_RUNTIME_DIR||'',DBUS_SESSION_BUS_ADDRESS:process.env.DBUS_SESSION_BUS_ADDRESS||''}});
    const timer=setTimeout(()=>proc.kill(),3000);const output=await new Response(proc.stdout).text();await proc.exited;clearTimeout(timer);
    if(output.split('\n').some(x=>x==='active'||x==='activating'))return true;
  }
  for(const pid of readdirSync('/proc').filter(x=>/^\d+$/.test(x))){try{const cmd=readFileSync(`/proc/${pid}/cmdline`,'utf8');if(cmd.includes('daytime-backup-loop.sh'))return true;}catch{}}
  return false;
}
function ensureService(req?:Request):ResticService{
  const state=resticRuntime();
  if(state.service)return state.service;
  const host=(globalThis as any).__piclaw_runtime;
  const ctx=req?host?.localContext?.getRequestContext(req):undefined;
  const workspace=ctx?.workspaceRoot||process.env.PICLAW_WORKSPACE;
  const stateDir=host?.messaging?.getAddonDataDir?.('restic');
  if(!workspace||!stateDir)throw Error('Restic requires host workspace and add-on data-directory capabilities');
  const service=new ResticService({paths:instancePaths(workspace,stateDir),resolveSecret:resolveKeychainSecret,legacySchedulerActive});
  state.service=service;
  service.start();host?.lifecycle?.onShutdown?.(stopRestic);return service;
}
export function stopRestic(){const state=resticRuntime();state.service?.stop();state.service=undefined;}
const register=(globalThis as any).__piclaw_registerAddonConfigApi;
if(typeof register==='function'){
  register('restic','config',{
    get:async(_body:unknown,req:Request)=>({ok:true,...await ensureService(req).info()}),
    set:async(body:any,req:Request)=>({ok:true,config:await ensureService(req).setConfig(body?.config)}),
  },import.meta.dir);
  register('restic','status',{get:async(_body:unknown,req:Request)=>({ok:true,state:ensureService(req).status})},import.meta.dir);
  register('restic','action',{set:async(body:any,req:Request)=>{
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(x=>!['action','confirmation','snapshot','target','token','ids'].includes(x)))throw Error('Invalid Restic action payload');
    const s=ensureService(req);const action=body.action;
    if(['backup','check','restore','applyRetention','installBinary'].includes(action)){
      if(s.status.running)throw Error('Another backup operation is running');
      // Explicit POST starts deterministic work; success is visible through Refresh status.
      void s.submit(action,body).catch(()=>{});
      return {ok:true,queued:true,state:s.status};
    }
    return {ok:true,result:await s.execute(action,body)};
  }},import.meta.dir);
}
function bootstrap(){
  // Startup registration is process-owned, not tied to individual chat sessions.
  if(process.env.PICLAW_WORKSPACE&&(globalThis as any).__piclaw_runtime?.messaging?.getAddonDataDir){ensureService();}
}

bootstrap();
export default bootstrap;

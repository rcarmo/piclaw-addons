import { existsSync, mkdirSync, realpathSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { BackupSource } from './contracts.ts';
import { assertBackupPaths } from './repository.ts';
/** Select scratch space outside all backup roots, including when host TMPDIR is in the workspace. */
export function stagingRoot(sources:BackupSource[],name:string,env:NodeJS.ProcessEnv=process.env):string {
  const candidates=env.PICLAW_RESTIC_STAGING_ROOT!==undefined?[env.PICLAW_RESTIC_STAGING_ROOT]:[tmpdir(),...(process.platform==='linux'?['/tmp','/var/tmp']:[])];
  for(const candidate of candidates){
    if(!isAbsolute(candidate)||!existsSync(candidate))continue;
    const base=join(realpathSync(candidate),name);
    try{assertBackupPaths(sources.map(s=>s.path),[base]);return base;}catch{}
  }
  throw Error('No safe Restic staging root outside backup sources; set PICLAW_RESTIC_STAGING_ROOT to an existing external directory');
}
export interface InstancePaths { sources: BackupSource[]; stateDir:string; stageDir:string; cacheDir:string; }
export function instancePaths(workspace:string, stateDir:string, env:NodeJS.ProcessEnv=process.env):InstancePaths {
  if(!isAbsolute(workspace)||!existsSync(workspace))throw Error('Authoritative workspace is unavailable');
  workspace=realpathSync(workspace);
  if(!isAbsolute(stateDir))throw Error('State directory must be absolute');
  mkdirSync(stateDir,{recursive:true,mode:0o700});stateDir=realpathSync(stateDir);
  const sources:BackupSource[]=[{name:'workspace',path:workspace}];
  for(const [name,path] of [['store',env.PICLAW_STORE||join(workspace,'.piclaw/store')],['data',env.PICLAW_DATA||join(workspace,'.piclaw/data')],['profile',env.PI_CODING_AGENT_DIR||join(homedir(),'.pi/agent')]]) {
    if(!isAbsolute(path))throw Error('Instance paths must be absolute');
    if(!existsSync(path)){if(name==='profile'&&env.PI_CODING_AGENT_DIR)throw Error('Configured Pi profile is missing');continue;}
    const canonical=realpathSync(path);
    if(sources.some(s=>{const r=relative(s.path,canonical);return r===''||(!r.startsWith('..'+sep)&&r!=='..'&&!isAbsolute(r));}))continue;
    sources.push({name,path:canonical});
  }
  const key=createHash('sha256').update(workspace+'\0'+stateDir).digest('hex').slice(0,24);
  const base=stagingRoot(sources,`piclaw-restic-${key}`,env);
  return {sources,stateDir,stageDir:join(base,'snapshot'),cacheDir:join(base,'cache')};
}
export function verifyExpectedMount(path:string, expected?:string):void {
  if(!expected)return;
  if(process.platform!=='linux')throw Error('Expected-mount validation currently requires Linux');
  if(!existsSync(expected)||!existsSync(path))throw Error('Expected backup mount or repository is unavailable');
  const decode=(x:string)=>x.replace(/\\([0-7]{3})/g,(_,n)=>String.fromCharCode(parseInt(n,8)));
  const mounts=readFileSync('/proc/self/mountinfo','utf8').split('\n').filter(Boolean).map(x=>decode(x.split(' ')[4]));
  const mount=realpathSync(expected),repo=realpathSync(path),rel=relative(mount,repo);
  if(!mounts.includes(mount)||rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))throw Error('Expected backup mount is not mounted or does not contain repository');
}

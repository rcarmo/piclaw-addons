import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import { runRestic } from './runner.ts';
import type { RunOptions, RunResult } from './contracts.ts';

export const RESTIC_VERSION = '0.18.1';
export const INSTALL_CONFIRMATION = 'INSTALL VERIFIED RESTIC';
export interface Release { asset:string; archiveSha256:string; binarySha256:string; }
// SHA256SUMS fetched from upstream v0.18.1; unpacked hashes verified locally.
// These constants are reviewed source, never replaced by a downloaded checksum file.
export const RELEASES: Record<string,Release> = {
  'linux-x64': { asset:'restic_0.18.1_linux_amd64.bz2', archiveSha256:'680838f19d67151adba227e1570cdd8af12c19cf1735783ed1ba928bc41f363d', binarySha256:'01143daba61a1dc8afb0cb3d03ba83e6b118f55b6b146b27473a09efc3df13d6' },
  'linux-arm64': { asset:'restic_0.18.1_linux_arm64.bz2', archiveSha256:'87f53fddde38764095e9c058a3b31834052c37e5826d2acf34e18923c006bd45', binarySha256:'f04a6bf766a33fba44b5be068e29091259dda5ef37f1e68ba9a8e0cda053120e' },
};
const MAX_ARCHIVE = 40*1024*1024, MAX_BINARY=100*1024*1024;
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const safeEnv=()=>({PATH:process.env.PATH||'/usr/bin:/bin'});
export function selectedRelease(platform=process.platform as string,arch=process.arch as string):Release {
  const release=RELEASES[`${platform}-${arch}`];
  if(!release)throw Error('Managed Restic is available for Linux x64/arm64; configure a qualified custom binary on other platforms');
  return release;
}
function checkRealFile(path:string){if(!existsSync(path)||!lstatSync(path).isFile()||realpathSync(path)!==path)throw Error('Restic executable must be an existing canonical regular file');}
export function managedPath(stateDir:string){return join(stateDir,'bin',`restic-${RESTIC_VERSION}-${process.platform}-${process.arch}`);}
export async function inspectBinary(path:string,run:(o:RunOptions)=>Promise<RunResult>=runRestic){
  checkRealFile(path);
  const version=await run({binary:path,args:['version'],env:safeEnv(),timeoutMs:5000,maxOutputBytes:8192});
  const match=version.stdout.match(/^restic (\d+)\.(\d+)\.(\d+)(?:\s|$)/);
  if(version.code!==0||!match)throw Error('Configured executable is not a working Restic binary');
  const tuple=match.slice(1,4).map(Number),minimum=[0,18,1];let meets=false;
  for(let i=0;i<3;i++){if(tuple[i]>minimum[i]){meets=true;break;}if(tuple[i]<minimum[i])break;if(i===2)meets=true;}
  if(!meets)throw Error('Restic 0.18.1 or newer is required; install the verified managed binary');
  const options=await run({binary:path,args:['options'],env:safeEnv(),timeoutMs:5000,maxOutputBytes:128*1024});
  const backends=['local','sftp','s3','azure'];
  const missing=backends.filter(name=>!new RegExp(`^\\s*${name}\\.`, 'm').test(options.stdout));
  if(options.code!==0||missing.length)throw Error(`Restic binary lacks required backend support: ${missing.join(', ')||'options probe failed'}. Install verified Restic.`);
  return {path,version:match[0].trim(),backends};
}
export async function resolveBinary(selection:string,stateDir:string,run:(o:RunOptions)=>Promise<RunResult>=runRestic){
  const path=selection==='managed'?managedPath(stateDir):isAbsolute(selection)?selection:Bun.which(selection);
  if(!path||!existsSync(path))throw Error(selection==='managed'?'Managed Restic is not installed. Use Install verified Restic in Settings.':'Restic binary is missing; install verified Restic or configure its absolute path');
  const canonical=realpathSync(path);
  if(selection==='managed'){
    if(canonical!==path||digest(readFileSync(path))!==selectedRelease().binarySha256)throw Error('Managed Restic integrity check failed; reinstall verified Restic');
  }
  return {...await inspectBinary(canonical,run),managed:selection==='managed'};
}
async function download(url:string,signal:AbortSignal):Promise<Uint8Array>{
  const response=await fetch(url,{signal,redirect:'follow'});
  const final=new URL(response.url);
  if(!response.ok||final.protocol!=='https:'||!(final.hostname==='github.com'||final.hostname.endsWith('.githubusercontent.com')))throw Error('Verified Restic download failed');
  if(Number(response.headers.get('content-length')||0)>MAX_ARCHIVE)throw Error('Restic archive exceeds size limit');
  if(!response.body)throw Error('Restic download has no body');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{while(true){signal.throwIfAborted();const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_ARCHIVE)throw Error('Restic archive exceeds size limit');chunks.push(value);}}finally{await reader.cancel();}
  return Buffer.concat(chunks);
}
async function decompress(archive:string,signal:AbortSignal):Promise<Uint8Array>{
  const bzip=Bun.which('bzip2');if(!bzip)throw Error('Install bzip2 to unpack the verified upstream Restic archive');
  return new Promise((resolve,reject)=>{
    const child=spawn(bzip,['-dc',archive],{env:safeEnv(),stdio:['ignore','pipe','pipe'],shell:false});
    const chunks:Buffer[]=[];let size=0,failed=false;
    const fail=(message:string)=>{if(failed)return;failed=true;child.kill('SIGKILL');reject(Error(message));};
    const abort=()=>fail('Restic installation cancelled');signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>MAX_BINARY)fail('Unpacked Restic exceeds size limit');else chunks.push(chunk);});
    child.stderr.resume();child.on('error',()=>fail('Could not unpack Restic archive with bzip2'));
    child.on('close',code=>{signal.removeEventListener('abort',abort);if(!failed){if(code!==0)reject(Error('Invalid Restic archive'));else resolve(Buffer.concat(chunks));}});
  });
}
/** Dependencies are test seams only. Browser requests never supply URLs, hashes or executables. */
export interface InstallDependencies { release?:Release; fetchArchive?:(url:string,signal:AbortSignal)=>Promise<Uint8Array>; unpack?:(path:string,signal:AbortSignal)=>Promise<Uint8Array>; inspect?:typeof inspectBinary; }
export async function installManaged(stateDir:string,confirmation:string,signal?:AbortSignal,deps:InstallDependencies={}){
  if(confirmation!==INSTALL_CONFIRMATION)throw Error('Explicit verified Restic installation confirmation required');
  const release=deps.release||selectedRelease();const dir=join(stateDir,'bin');
  mkdirSync(dir,{recursive:true,mode:0o700});if(realpathSync(dir)!==dir)throw Error('Managed binary directory must not contain symlinks');chmodSync(dir,0o700);
  const lock=join(dir,'.install-lock');try{mkdirSync(lock,{mode:0o700});}catch{throw Error('Restic installation already running or interrupted; inspect the install lock');}
  let staging:string|undefined;const controller=new AbortController();const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const timeout=setTimeout(abort,120000);
  try{
    controller.signal.throwIfAborted();staging=mkdtempSync(join(dir,'.install-'));
    const archive=await (deps.fetchArchive||download)(`https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/${release.asset}`,controller.signal);
    if(archive.length>MAX_ARCHIVE||digest(archive)!==release.archiveSha256)throw Error('Restic archive checksum mismatch; installation refused');
    const archivePath=join(staging,'restic.bz2');writeFileSync(archivePath,archive,{mode:0o600});
    const bytes=await (deps.unpack||decompress)(archivePath,controller.signal);
    if(bytes.length>MAX_BINARY||digest(bytes)!==release.binarySha256)throw Error('Restic executable checksum mismatch; installation refused');
    const candidate=join(staging,'restic');writeFileSync(candidate,bytes,{mode:0o700});chmodSync(candidate,0o700);
    // Execute only after both reviewed hashes match.
    const info=await (deps.inspect||inspectBinary)(candidate);controller.signal.throwIfAborted();
    const path=managedPath(stateDir);renameSync(candidate,path);chmodSync(path,0o700);
    writeFileSync(join(dir,'receipt.json'),JSON.stringify({version:RESTIC_VERSION,asset:release.asset,archiveSha256:release.archiveSha256,binarySha256:release.binarySha256,installedAt:new Date().toISOString()},null,2)+'\n',{mode:0o600});
    return {...info,path,managed:true,sha256:release.binarySha256};
  }finally{clearTimeout(timeout);signal?.removeEventListener('abort',abort);if(staging)rmSync(staging,{recursive:true,force:true});rmSync(lock,{recursive:true,force:true});}
}

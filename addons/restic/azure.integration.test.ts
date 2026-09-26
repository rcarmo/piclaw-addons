import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {ResticService} from './service.ts';
import {defaultJobConfig} from './job-config.ts';
import {runRestic} from './runner.ts';
const enabled=process.env.PICLAW_RESTIC_AZURE==='1'&&process.env.PICLAW_E2E_DISPOSABLE==='1';
(enabled?test:test.skip)('Azure Blob emulator via trusted local TLS: init/backup/list/check/restore',async()=>{
 const root=mkdtempSync(join(tmpdir(),'restic-azure-')),name='restic-azure-'+randomUUID();let proxy:ReturnType<typeof Bun.serve>|undefined;let service:ResticService|undefined;
 const command=(args:string[])=>{const r=spawnSync(args[0],args.slice(1),{encoding:'utf8',timeout:30000});if(r.status!==0)throw Error(r.stderr||'fixture command failed');return r.stdout.trim();};
 try{
  const key=Buffer.from('disposable-azurite-account-key-32bytes-fixture').toString('base64'),account='resticfixture';
  command(['docker','run','--rm','-d','--name',name,'-p','127.0.0.1::10000','-e',`AZURITE_ACCOUNTS=${account}:${key}`,'mcr.microsoft.com/azure-storage/azurite:3.35.0','azurite-blob','--blobHost','0.0.0.0','--skipApiVersionCheck']);
  const port=command(['docker','port',name,'10000/tcp']).split(':').at(-1)!;
  for(let i=0;i<100;i++){try{await fetch(`http://127.0.0.1:${port}/`);break;}catch{await Bun.sleep(100);}}
  const cert=join(root,'cert.pem'),privateKey=join(root,'key.pem');const host='resticfixture.blob.127.0.0.1.nip.io';
  command(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',privateKey,'-out',cert,'-subj',`/CN=${host}`,'-addext',`subjectAltName=DNS:${host}`]);
  proxy=Bun.serve({hostname:'127.0.0.1',port:0,tls:{cert:readFileSync(cert),key:readFileSync(privateKey)},async fetch(req){
   const u=new URL(req.url);const headers=new Headers(req.headers);headers.set('host',`${host}:${proxy!.port}`);
   const response=await fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`,{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:await req.arrayBuffer(),redirect:'manual'});return response;
  }});
  const source=join(root,'source');mkdirSync(source);writeFileSync(join(source,'fixture.txt'),'Azure recovery fixture');
  const paths={sources:[{name:'workspace',path:source}],stateDir:join(root,'state'),stageDir:join(root,'stage'),cacheDir:join(root,'cache')};
  service=new ResticService({paths,resolveSecret:async ref=>ref==='azure/key'?key:'fixture-restic-password',run:o=>runRestic({...o,timeoutMs:12000,args:o.args[0]==='version'?o.args:['--cacert',cert,'-o','azure.access-tier=Hot',...o.args],env:{...o.env,AZURE_ENDPOINT_SUFFIX:`127.0.0.1.nip.io:${proxy!.port}`}})});
  await service.setConfig({...defaultJobConfig(),binary:process.env.PICLAW_RESTIC_TEST_BINARY||'restic',repository:{backend:'azure',account,container:'restic-tests',prefix:'fixture',accountKeyRef:'azure/key'},passwordRef:'restic/password'});
  await service.execute('init',{confirmation:'INITIALISE REPOSITORY'});expect((await service.execute('backup') as any).status).toBe('success');
  const snapshots=await service.execute('snapshots') as any[];expect(snapshots).toHaveLength(1);await service.execute('check');
  const target=join(root,'restore');mkdirSync(target);const restored=await service.execute('restore',{snapshot:snapshots[0].id,target,confirmation:'RESTORE TO EMPTY DIRECTORY'}) as any;
  expect(readFileSync(join(restored.restored,'workspace/fixture.txt'),'utf8')).toBe('Azure recovery fixture');
 }catch(e){console.error(spawnSync("docker",["logs",name],{encoding:"utf8"}).stdout);throw e;}finally{service?.stop();proxy?.stop(true);spawnSync('docker',['rm','-f',name],{stdio:'ignore',timeout:15000});rmSync(root,{recursive:true,force:true});}
},120000);

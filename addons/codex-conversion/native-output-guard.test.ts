import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeCodexOutput } from './src/native-provider.ts';
const sse = `data: ${JSON.stringify({type:'response.created',response:{id:'resp'}})}\n\ndata: ${JSON.stringify({type:'response.output_item.done',item:{type:'image_generation_call',id:'call',result:Buffer.from('image').toString('base64')}})}\n\n`;
test('native SSE image writes actual file and latest only while current', async () => {
 const cwd=await mkdtemp(join(tmpdir(),'codex-guard-')); await mkdir(join(cwd,'.git'));
 try {
  let active=true; const operation=Object.freeze({id:'op',sessionId:'session',cwd,model:{provider:'openai-codex',id:'test',api:'openai-codex-responses'},signal:new AbortController().signal,assertCurrent(){if(!active)throw Error('revoked');}});
  const activities:any[]=[];
  const output=await createNativeCodexOutput(operation,async (_op,a)=>{activities.push(a);});
  await output.capture(new Response(sse)); await output.finish();
  expect(await readFile(join(cwd,'.pi/openai-codex-images/call-resp.png'),'utf8')).toBe('image');
  expect(await readFile(join(cwd,'.pi/openai-codex-images/latest.png'),'utf8')).toBe('image');
  expect(activities).toHaveLength(1);
  await rm(join(cwd,'.pi'),{recursive:true});
  const revoked=await createNativeCodexOutput(operation,async()=>{throw Error('must not publish');});
  const response=new Response(new ReadableStream({start(controller){setTimeout(()=>{active=false;controller.enqueue(new TextEncoder().encode(sse));controller.close();},5);}}));
  await expect(revoked.capture(response)).rejects.toThrow('revoked');
  expect(await access(join(cwd,'.pi')).then(()=>true,()=>false)).toBe(false);
 } finally {await rm(cwd,{recursive:true,force:true});}
});
test('image writer checks ownership after workspace and mkdir awaits, and between image and latest writes', async()=>{
 const { saveOpenAICodexGeneratedImage }=await import('./src/providers/openai-codex-native-output-observer.ts');
 for(const revokeAt of [2,4,5,6]) {
  const cwd=await mkdtemp(join(tmpdir(),'codex-write-'));await mkdir(join(cwd,'.git'));
  try {
   let checks=0;
   await expect(saveOpenAICodexGeneratedImage(cwd,{callId:'guard',result:Buffer.from('image').toString('base64')},()=>{if(++checks===revokeAt)throw Error('revoked');})).rejects.toThrow('revoked');
   const exists=(name:string)=>access(join(cwd,'.pi/openai-codex-images',name)).then(()=>true,()=>false);
   expect(await exists('guard-response.png')).toBe(revokeAt>=5);
   expect(await exists('latest.png')).toBe(revokeAt>=6);
  }finally{await rm(cwd,{recursive:true,force:true});}
 }
});

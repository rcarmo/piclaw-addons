import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeCodexOutput } from './src/native-provider.ts';
const sse = `data: ${JSON.stringify({type:'response.created',response:{id:'resp'}})}\n\ndata: ${JSON.stringify({type:'response.output_item.done',item:{type:'image_generation_call',id:'call',result:Buffer.from('image').toString('base64')}})}\n\n`;
const webSse = `data: ${JSON.stringify({type:'response.created',response:{id:'resp'}})}\n\ndata: ${JSON.stringify({type:'response.output_item.done',item:{type:'web_search_call',id:'search',action:{query:'weather'},results:[{title:'Result',url:'https://example.test'}]}})}\n\n`;
const twoWebSearchSse = `data: ${JSON.stringify({type:'response.created',response:{id:'resp'}})}\n\ndata: ${JSON.stringify({type:'response.output_item.done',item:{type:'web_search_call',id:'search-1',action:{query:'first'}}})}\n\ndata: ${JSON.stringify({type:'response.output_item.done',item:{type:'web_search_call',id:'search-2',action:{query:'second'}}})}\n\n`;
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

test('body error is irrecoverable and explicitly discardable without publication', async () => {
 const operation={id:'failed',sessionId:'session',cwd:tmpdir(),model:{provider:'openai-codex',id:'test',api:'openai-codex-responses'},signal:new AbortController().signal,assertCurrent(){}};
 let published=0;
 const output=await createNativeCodexOutput(operation,async()=>{published++;});
 const response=new Response(new ReadableStream({start(controller){
  controller.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"id":"resp"}}\n\n'));
  setTimeout(()=>controller.error(Error('body failed')),5);
 }}));
 await expect(output.capture(response)).rejects.toThrow('body failed');
 expect(output.phase).toBe('capture-failed');
 await expect(output.finish()).rejects.toThrow('body failed');
 expect(output.discardFailedCapture()).toBe(true);
 expect(output.discardFailedCapture()).toBe(true);
 expect(output.phase).toBe('discarded');
 expect(published).toBe(0);
});
test('publication retry retains the identical pending activity', async()=>{
 const cwd=await mkdtemp(join(tmpdir(),'codex-retry-'));await mkdir(join(cwd,'.git'));
 try {
  const operation={id:'retry',sessionId:'session',cwd,model:{provider:'openai-codex',id:'test',api:'openai-codex-responses'},signal:new AbortController().signal,assertCurrent(){}};
  const attempts:any[]=[];const published:any[]=[];
  const output=await createNativeCodexOutput(operation,async(_op,item)=>{attempts.push(item);if(attempts.length===1)throw Error('transient');published.push(item);});
  await output.capture(new Response(sse));
  await expect(output.finish()).rejects.toThrow('transient');
  expect(output.discardFailedCapture()).toBe(false);
  await output.finish();await output.finish();
  expect(attempts).toHaveLength(2);expect(attempts[0]).toBe(attempts[1]);expect(published).toHaveLength(1);
 }finally{await rm(cwd,{recursive:true,force:true});}
});

test('generic capture leaves caller reader ownership unchanged', async()=>{
 const operation={id:'borrowed',sessionId:'session',cwd:tmpdir(),model:{provider:'openai-codex',id:'test',api:'openai-codex-responses'},signal:new AbortController().signal,assertCurrent(){}};
 const activities:any[]=[];
 const output=await createNativeCodexOutput(operation,async(_op,item)=>{activities.push(item);});
 const response=new Response(webSse);
 await output.capture(response);
 expect(response.bodyUsed).toBe(false);
 expect(await response.text()).toBe(webSse);
 await output.finish();
 expect(activities).toHaveLength(1);
 expect(activities[0].kind).toBe('web-search');
});

test('owned capture consumes its dedicated response without cloning it', async()=>{
 const operation={id:'owned',sessionId:'session',cwd:tmpdir(),model:{provider:'openai-codex',id:'test',api:'openai-codex-responses'},signal:new AbortController().signal,assertCurrent(){}};
 const activities:any[]=[];
 const output=await createNativeCodexOutput(operation,async(_op,item)=>{activities.push(item);});
 const response=new Response(webSse);
 let cloneCalls=0;
 Object.defineProperty(response,'clone',{value(){cloneCalls++;throw Error('owned response must not be cloned');}});
 const capture=output.captureOwned(response);
 expect(response.bodyUsed).toBe(false);
 await capture;
 expect(response.bodyUsed).toBe(true);
 expect(cloneCalls).toBe(0);
 await output.finish();
 expect(activities).toHaveLength(1);
 expect(activities[0].search.callId).toBe('search');
});

test('owned capture shares publication retry and pending activity identity', async()=>{
 const operation={id:'owned-retry',sessionId:'session',cwd:tmpdir(),model:{provider:'openai-codex',id:'test',api:'openai-codex-responses'},signal:new AbortController().signal,assertCurrent(){}};
 const attempts:any[]=[];const published:any[]=[];
 const output=await createNativeCodexOutput(operation,async(_op,item)=>{attempts.push(item);if(attempts.length===1)throw Error('transient');published.push(item);});
 const response=new Response(webSse);
 await output.captureOwned(response);
 await expect(output.finish()).rejects.toThrow('transient');
 expect(output.discardFailedCapture()).toBe(false);
 await output.finish();
 expect(attempts).toHaveLength(2);
 expect(attempts[0]).toBe(attempts[1]);
 expect(published).toEqual([attempts[0]]);
 expect(response.bodyUsed).toBe(true);
});

test('concurrent finish calls share one FIFO publication drain', async()=>{
 const operation={id:'finish-singleflight',sessionId:'session',cwd:tmpdir(),model:{provider:'openai-codex',id:'test',api:'openai-codex-responses'},signal:new AbortController().signal,assertCurrent(){}};
 let releaseFirst!:()=>void;let markStarted!:()=>void;
 const firstHeld=new Promise<void>(resolve=>{releaseFirst=resolve;});
 const firstStarted=new Promise<void>(resolve=>{markStarted=resolve;});
 const attempts:any[]=[];const published:any[]=[];
 const output=await createNativeCodexOutput(operation,async(_op,item)=>{
  attempts.push(item);
  if(attempts.length===1){markStarted();await firstHeld;}
  published.push(item);
 });
 await output.capture(new Response(twoWebSearchSse));
 const first=output.finish();const second=output.finish();
 await firstStarted;
 releaseFirst();
 await Promise.all([first,second]);
 expect(attempts.map(item=>item.search.callId)).toEqual(['search-1','search-2']);
 expect(published.map(item=>item.search.callId)).toEqual(['search-1','search-2']);
 expect(new Set(attempts).size).toBe(2);
 expect(output.phase).toBe('sealed');
 expect(()=>output.capture(new Response(webSse))).toThrow('Codex capture closed');
 await output.finish();
 expect(published).toHaveLength(2);
});

test('finish rechecks current authority after an earlier publication succeeds', async()=>{
 let current=true;const revoked=new Error('revoked');let publications=0;
 const operation={id:'finish-authority',sessionId:'session',cwd:tmpdir(),model:{provider:'openai-codex',id:'test',api:'openai-codex-responses'},signal:new AbortController().signal,assertCurrent(){if(!current)throw revoked;}};
 const output=await createNativeCodexOutput(operation,async()=>{publications++;});
 await output.captureOwned(new Response(webSse));
 await output.finish();
 expect(publications).toBe(1);
 current=false;
 const reason=await output.finish().then(()=>undefined,error=>error);
 expect(reason).toBe(revoked);
 expect(publications).toBe(1);
});

test('concurrent finish failure reaches all joiners and retries the identical FIFO head', async()=>{
 const operation={id:'finish-singleflight-retry',sessionId:'session',cwd:tmpdir(),model:{provider:'openai-codex',id:'test',api:'openai-codex-responses'},signal:new AbortController().signal,assertCurrent(){}};
 let rejectFirst!:(error:Error)=>void;let markStarted!:()=>void;
 const firstHeld=new Promise<void>((_resolve,reject)=>{rejectFirst=reject;});
 const firstStarted=new Promise<void>(resolve=>{markStarted=resolve;});
 const attempts:any[]=[];const published:any[]=[];
 const output=await createNativeCodexOutput(operation,async(_op,item)=>{
  attempts.push(item);
  if(attempts.length===1){markStarted();await firstHeld;}
  published.push(item);
 });
 await output.capture(new Response(twoWebSearchSse));
 const first=output.finish();const second=output.finish();
 await firstStarted;
 const outcomesPromise=Promise.allSettled([first,second]);
 const transient=new Error('transient');
 rejectFirst(transient);
 const outcomes=await outcomesPromise;
 expect(outcomes.every(outcome=>outcome.status==='rejected'&&outcome.reason===transient)).toBe(true);
 expect(attempts).toHaveLength(1);
 expect(published).toHaveLength(0);
 expect(output.discardFailedCapture()).toBe(false);
 await output.finish();
 expect(attempts.map(item=>item.search.callId)).toEqual(['search-1','search-1','search-2']);
 expect(attempts[0]).toBe(attempts[1]);
 expect(published.map(item=>item.search.callId)).toEqual(['search-1','search-2']);
 expect(output.phase).toBe('sealed');
});

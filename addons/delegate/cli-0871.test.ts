import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseDelegateJsonOutput, delegateProcessFailure, parsePiListModelsOutput } from './delegate.ts';

const base = process.env.PICLAW_DELEGATE_0871_PACKAGES;
const integration = process.env.PICLAW_E2E_DISPOSABLE === '1' && base ? test : test.skip;
const provenance = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/earendil-0.87.1-provenance.json'), 'utf8'));
const ids = provenance.models as Array<{provider:string;id:string}>;
const sha256 = (file:string) => createHash('sha256').update(readFileSync(file)).digest('hex');
function fixture() {
  if (!base || !isAbsolute(base)) throw Error('Explicit absolute 0.87.1 package directory required');
  for (const name of ['pi-ai','pi-coding-agent']) {
    if (JSON.parse(readFileSync(join(base,name,'package.json'),'utf8')).version !== '0.87.1') throw Error('Fixture requires exact 0.87.1 packages');
  }
  for (const [path,hash] of Object.entries(provenance.verifiedPackageFiles as Record<string,string>)) {
    expect(sha256(join(base,path)),path).toBe(hash);
  }
  for (const model of provenance.models) {
    const groups=JSON.parse(readFileSync(join(base,'pi-ai/dist/providers/data',`${model.provider}.json`),'utf8'));
    const source=Object.assign({},...Object.values(groups))[model.id];
    for (const key of ['input','reasoning','contextWindow','maxTokens']) expect(source[key],`${model.fullId}/${key}`).toEqual(model[key]);
  }
  const root=mkdtempSync(join(tmpdir(),'delegate0871-'));
  for(const d of ['home','profile','workspace','tmp'])mkdirSync(join(root,d));
  const env={PATH:process.env.PATH!,HOME:join(root,'home'),PI_CODING_AGENT_DIR:join(root,'profile'),TMPDIR:join(root,'tmp'),XDG_CONFIG_HOME:join(root,'home'),XDG_CACHE_HOME:join(root,'home'),XDG_DATA_HOME:join(root,'home'),NO_COLOR:'1',TERM:'dumb'};
  const cli=join(base,'pi-coding-agent/dist/cli.js');
  async function run(args:string[],preload:string) {
    const child=Bun.spawn([process.execPath,'--preload',preload,cli,...args],{cwd:join(root,'workspace'),env,stdin:'pipe',stdout:'pipe',stderr:'pipe'});
    const timer=setTimeout(()=>child.kill('SIGKILL'),20000);
    try {
      child.stdin.write('Return the deterministic fixture response.');child.stdin.end();
      const [stdout,stderr,exitCode]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
      return {stdout,stderr,exitCode};
    } finally {clearTimeout(timer);}
  }
  return {root,run,close:()=>rmSync(root,{recursive:true,force:true})};
}

integration('actual 0.87.1 child CLI emits the captured exact new IDs with synthetic offline credentials',async()=>{
  const f=fixture();try{
    writeFileSync(join(f.root,'profile/auth.json'),JSON.stringify({
      anthropic:{type:'api_key',key:'fixture-only'},openai:{type:'api_key',key:'fixture-only'},xai:{type:'api_key',key:'fixture-only'},'github-copilot':{type:'api_key',key:'fixture-only'},
      'openai-codex':{type:'oauth',access:'fixture-only',refresh:'fixture-only',expires:Date.now()+3600000,accountId:'fixture-only'},
    }));
    const pre=join(f.root,'offline.ts');writeFileSync(pre,"globalThis.fetch=()=>{throw Error('No network during catalogue capture')};");
    const result=await f.run(['--no-session','--no-extensions','--list-models'],pre);
    expect(result.exitCode,result.stderr).toBe(0);
    const actual=parsePiListModelsOutput(result.stdout).filter(m=>ids.some(id=>id.provider===m.provider&&id.id===m.id));
    const captured=parsePiListModelsOutput(readFileSync(join(import.meta.dir,'fixtures/cli-models-earendil-0.87.1.txt'),'utf8'));
    expect(actual).toEqual(captured);
    expect(readdirSync(join(f.root,'workspace'))).toEqual([]);
  }finally{f.close();}
},30000);

integration('actual 0.87.1 JSON/no-session remains parseable; missing and malformed modes fail without hidden fallback',async()=>{
  const f=fixture();let calls=0;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
    if(new URL(req.url).pathname!=='/v1/chat/completions')return new Response('Wrong fixture endpoint',{status:404});
    calls++;const body=await req.json() as any;
    expect(body.model).toBe('gpt-6-sol');
    const chunks=[{id:'fixture',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:{role:'assistant',content:'OFFLINE_JSON_OK'},finish_reason:null}]},{id:'fixture',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5}}];
    return new Response(chunks.map(c=>'data: '+JSON.stringify(c)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  }});
  try{
    writeFileSync(join(f.root,'profile/models.json'),JSON.stringify({providers:{'fixture-only':{baseUrl:server.url.href+'v1',api:'openai-completions',apiKey:'fixture-only-token',models:[{id:'gpt-6-sol',name:'Fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:100000,maxTokens:1000}]}}}));
    const pre=join(f.root,'loopback-only.ts');writeFileSync(pre,`const orig=globalThis.fetch;globalThis.fetch=(input,init)=>{const u=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(u.origin!==${JSON.stringify(server.url.origin)})throw Error('External network forbidden');return orig(input,init)};`);
    const common=['--no-session','--no-extensions','--no-skills','--no-prompt-templates','--no-themes','--no-tools','--model','fixture-only/gpt-6-sol'];
    const json=await f.run(['--mode','json',...common],pre);
    const parsed={...parseDelegateJsonOutput(json.stdout),stderr:json.stderr,exitCode:json.exitCode};
    expect(delegateProcessFailure(parsed)).toBeNull();expect(parsed.text).toBe('OFFLINE_JSON_OK');expect(parsed.stopReason).toBe('stop');
    expect(parsed.provider).toBe('fixture-only');expect(parsed.model).toBe('gpt-6-sol');expect(parsed.malformedEventCount).toBe(0);expect(calls).toBe(1);
    expect(parsed.usage).toMatchObject({input:3,output:2,totalTokens:5});
    const missing=await f.run(common,pre);
    expect(delegateProcessFailure({...parseDelegateJsonOutput(missing.stdout),stderr:missing.stderr,exitCode:missing.exitCode})).toBeTruthy();expect(calls).toBe(2);
    const invalid=await f.run(['--mode','not-a-mode',...common],pre);
    expect(delegateProcessFailure({...parseDelegateJsonOutput(invalid.stdout),stderr:invalid.stderr,exitCode:invalid.exitCode})).toBeTruthy();expect(calls).toBe(2);
    const files=(dir:string):string[]=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(dir,e.name)):[join(dir,e.name)]);
    expect(files(f.root).filter(p=>p.endsWith('.jsonl'))).toEqual([]);
  }finally{server.stop(true);f.close();}
},60000);

test('malformed or text-mode child output cannot become successful JSON delegation',()=>{
  for(const stdout of ['plain final text\n','{"type":"agent_end"}\n','{"type":"session"}\nnot-json\n']) {
    expect(delegateProcessFailure(parseDelegateJsonOutput(stdout))).toBeTruthy();
  }
  for (const stopReason of ['error','aborted']) {
    expect(delegateProcessFailure(parseDelegateJsonOutput(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'partial'}],stopReason,errorMessage:'fixture failure'}})))).toContain('fixture failure');
  }
});

test('captured CLI fixture matches the provenance checksum',()=>{
  expect(sha256(join(import.meta.dir,'fixtures/cli-models-earendil-0.87.1.txt'))).toBe(provenance.fixtureSha256);
});

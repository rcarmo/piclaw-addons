import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyModel, parsePiListModelsOutput, buildModelCandidates, getCurrentTier,
  buildDelegateModelChain, selectModel, validateExplicitDelegateModel,
  validateDelegateResponseModel, mergeExecutableRuntimeMetadata,
  describeImageCapability, getDelegateWorkspaceRoot,
} from './delegate.ts';

const models = parsePiListModelsOutput(readFileSync(join(import.meta.dir, 'fixtures/cli-models-earendil-0.87.1.txt'), 'utf8'));
const config = { searchable_providers: ['github-copilot', 'openai', 'openai-codex', 'anthropic', 'xai'], excluded_providers: [], excluded_models: [] };
test('captured 0.87.1 CLI rows classify exactly without broad GPT-6/Grok rules', () => {
  expect(models).toHaveLength(10);
  for (const model of models) {
    const opus = model.id.startsWith('claude-opus');
    expect(classifyModel(model)).toMatchObject({ status: 'classified', tier: opus ? 5 : 3, family: opus ? 'claude' : model.id.startsWith('grok') ? 'grok' : 'gpt' });
  }
  for (const id of ['gpt-6-sol-pro','gpt-6-sol-mini','gpt-6-sol-preview','gpt-6-sol:batch','gpt-6-luna-pro','gpt-6-lunar','gpt-6-luna:unknown','gpt-6-unknown','grok-4.7-pro','grok-4.7-preview','grok-4.8','openai/gpt-6-sol']) {
    expect(classifyModel({provider:'github-copilot', id})).toMatchObject({status:'unclassified',tier:null});
  }
  // Classification retains punctuation aliases, but cannot invent executable rows.
  for(const id of ['gpt_6_sol','gpt.6.luna','grok_4_7','grok-4-7']) {
    expect(classifyModel({provider:'github-copilot',id}).tier).toBe(3);
    expect(validateExplicitDelegateModel(`github-copilot/${id}`,models,models,config).approved).toBe(false);
  }
});
test('new-model approval, executable presence and exclusions remain independent gates', () => {
  expect(buildModelCandidates(models)).toEqual([]);
  expect(buildModelCandidates(models,{...config,searchable_providers:[]})).toEqual([]);
  for (const model of models) {
    expect(validateExplicitDelegateModel(model.fullId,models,models,config).approved).toBe(true);
    expect(validateExplicitDelegateModel(model.fullId,models,models,{...config,searchable_providers:[]}).approved).toBe(false);
    expect(validateExplicitDelegateModel(model.fullId,models,models,{...config,excluded_models:[model.fullId]}).approved).toBe(false);
    expect(validateExplicitDelegateModel(model.fullId,models.filter(m=>m.fullId!==model.fullId),models,config).approved).toBe(false);
  }
});
test('Sol/Luna current-model tiers cap automatic/fallback selection but retain judge family preference', () => {
  const candidates=buildModelCandidates(models,config);
  for(const id of ['gpt-6-sol','gpt-6-luna']){
    const current='github-copilot/'+id;
    expect(getCurrentTier({model:{provider:'github-copilot',id}})).toBe(3);
    const chain=buildDelegateModelChain('code',3,current,candidates,20);
    expect(chain.length).toBeGreaterThan(0);
    expect(chain.every(id=>candidates.find(c=>c.id===id)!.tier<=3)).toBe(true);
    expect(selectModel('judge',3,current,candidates)).toContain('grok-4.7');
    expect(selectModel('quick',2,current,candidates)).toBeNull();
  }
});
test('runtime capability enrichment cannot invent executable rows and image gates stay enforced', () => {
  const runtime=[...models.map(m=>({...m,supportsImages:true})),{provider:'openai',id:'gpt-6-sol-pro',fullId:'openai/gpt-6-sol-pro',supportsImages:true}];
  const merged=mergeExecutableRuntimeMetadata(models,runtime);
  expect(merged.map(m=>m.fullId)).toEqual(models.map(m=>m.fullId));
  expect(buildModelCandidates(merged,config).every(c=>c.supportsImages)).toBe(true);
  expect(describeImageCapability({id:'github-copilot/gpt-6-sol',supportsImages:false})).toContain('images=no');
});
test('response-model disclosure never approves a runtime-only or unknown new family', () => {
  const candidates=buildModelCandidates(models,config);
  expect(validateDelegateResponseModel('github-copilot/gpt-6-sol','github-copilot','gpt-6-luna',candidates)).toBeNull();
  expect(validateDelegateResponseModel('github-copilot/gpt-6-sol','github-copilot','gpt-6-luna-preview',candidates)).toBeTruthy();
  expect(validateDelegateResponseModel('github-copilot/gpt-6-sol','github-copilot','grok-4.7',buildModelCandidates(models,{...config,excluded_models:['*grok*']}))).toBeTruthy();
});

test('new current models reach approved children; fallback and explicit attempts cannot cross policy gates',async()=>{
 const root=mkdtempSync(join(getDelegateWorkspaceRoot(),'delegate-new-policy-'));
 const globals=globalThis as any,previous=globals.__piclaw_registerAddonConfigApi,oldCli=process.env.PI_DELEGATE_CLI;
 let configApi:any;
 try{
  const marker=join(root,'attempts'),mode=join(root,'mode'),image=join(root,'image.png');
  const cli=join(root,'cli.ts');
  writeFileSync(image,Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  writeFileSync(mode,'ok');
  writeFileSync(cli,`import{appendFileSync,readFileSync}from'node:fs';
   if(process.argv.includes('--list-models')){console.log('provider model context max-out thinking images');console.log('github-copilot gpt-6-sol 1M 128K yes no');console.log('github-copilot gpt-6-luna 1M 128K yes yes');console.log('github-copilot grok-4.7 500K 128K yes yes');console.log('github-copilot claude-opus-5.5 1M 128K yes yes');process.exit(0);}
   await Bun.stdin.text();const full=process.argv[process.argv.indexOf('--model')+1];appendFileSync(${JSON.stringify(marker)},full+'\\n');const mode=readFileSync(${JSON.stringify(mode)},'utf8');
   if(mode==='auth'&&full.endsWith('gpt-6-sol')){console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[],stopReason:'error',errorMessage:'No API key for provider'}}));process.exit(1);}
   const disclosed=mode.split(':').slice(1).join(':');
   console.log(JSON.stringify({type:'message_end',message:{role:'assistant',provider:'github-copilot',model:mode.startsWith('model:')?disclosed:full.split('/').slice(1).join('/'),responseModel:mode.startsWith('response:')?disclosed:undefined,content:[{type:'text',text:'NEW_POLICY_OK'}],stopReason:'stop'}}));
  `);
  process.env.PI_DELEGATE_CLI=`${process.execPath} ${cli}`;
  globals.__piclaw_registerAddonConfigApi=(_id:string,action:string,api:any)=>{if(action==='config')configApi=api;};
  const module=await import(`./delegate.ts?new-policy=${encodeURIComponent(root)}`);
  globals.__piclaw_registerAddonConfigApi=previous;
  let tool:any;module.default({on(){},registerTool(value:any){tool=value;}});
  await configApi.set({searchable_providers:['github-copilot'],excluded_providers:[],excluded_models:[]});
  const ctx={model:{provider:'github-copilot',id:'gpt-6-sol'},modelRegistry:{getAvailable(){return [];}}};
  const request={prompt:'fixture only',task_category:'code',tools:'read'};
  const attempted=()=>readFileSync(marker,'utf8').trim().split('\n');
  for(const [index,id] of ['gpt-6-sol','gpt-6-luna','grok-4.7','claude-opus-5.5'].entries()){
   const result=await tool.execute('auto',request,undefined,undefined,{...ctx,model:{...ctx.model,id}});
   expect(result.content[0].text).toContain('NEW_POLICY_OK');
   expect(attempted()).toEqual(Array(index+1).fill('github-copilot/gpt-6-sol'));
  }
  for(const [current,expected] of [['gpt-6-luna','grok-4.7'],['grok-4.7','gpt-6-sol']]){
   const before=attempted().length;
   await tool.execute('judge',{...request,task_category:'judge'},undefined,undefined,{...ctx,model:{...ctx.model,id:current}});
   expect(attempted().slice(before)).toEqual([`github-copilot/${expected}`]);
  }
  writeFileSync(mode,'auth');
  const fallback=await tool.execute('fallback',request,undefined,undefined,ctx);
  expect(fallback.content[0].text).toContain('NEW_POLICY_OK');
  let attempts=readFileSync(marker,'utf8').trim().split('\n');
  expect(attempts.slice(-2)).toEqual(['github-copilot/gpt-6-sol','github-copilot/gpt-6-luna']);
  await expect(tool.execute('explicit-no-fallback',{...request,model:'github-copilot/gpt-6-sol'},undefined,undefined,ctx)).rejects.toThrow();
  expect(readFileSync(marker,'utf8').trim().split('\n').length).toBe(attempts.length+1);
  writeFileSync(mode,'ok');
  const count=()=>readFileSync(marker,'utf8').trim().split('\n').length;
  const before=count();
  await expect(tool.execute('image-denied',{...request,model:'github-copilot/gpt-6-sol',files:[image]},undefined,undefined,ctx)).rejects.toThrow('images=no');
  expect(count()).toBe(before);
  await configApi.set({excluded_models:['*luna*']});
  await expect(tool.execute('excluded',{...request,model:'github-copilot/gpt-6-luna'},undefined,undefined,ctx)).rejects.toThrow();
  expect(count()).toBe(before);
  await configApi.set({excluded_models:[],searchable_providers:[]});
  await expect(tool.execute('no-approval',request,undefined,undefined,ctx)).rejects.toThrow();
  expect(count()).toBe(before);
  await configApi.set({searchable_providers:['github-copilot']});writeFileSync(mode,'response:gpt-6-unknown');
  await expect(tool.execute('disclosed-unknown',request,undefined,undefined,ctx)).rejects.toThrow('disclosed response model');
  expect(count()).toBe(before+1);
  for(const field of ['model','response']){
   // Both disclosed identity fields must pass request gates, with no retry.
   writeFileSync(mode,`${field}:claude-opus-5.5`);
   for(const current of ['gpt-6-sol','claude-opus-5.5']){
    const start=count();
    await expect(tool.execute('disclosed-over-cap',request,undefined,undefined,{...ctx,model:{...ctx.model,id:current}})).rejects.toThrow('disclosed response model');
    expect(count()).toBe(start+1); // current ceiling and category target both apply
   }
   const explicit=await tool.execute('explicit-tier-override',{...request,model:'github-copilot/claude-opus-5.5'},undefined,undefined,ctx);
   expect(explicit.content[0].text).toContain('NEW_POLICY_OK');
   expect(attempted().at(-1)).toBe('github-copilot/claude-opus-5.5');
   writeFileSync(mode,`${field}:gpt-6-sol`);
   for(const model of [undefined,'github-copilot/gpt-6-luna']){
    const start=count();
    await expect(tool.execute('disclosed-no-images',{...request,model,files:[image]},undefined,undefined,ctx)).rejects.toThrow('disclosed response model');
    expect(attempted().slice(start)).toEqual(['github-copilot/gpt-6-luna']);
   }
   writeFileSync(mode,`${field}:gpt-6-luna`);
   const allowed=await tool.execute('disclosed-eligible',request,undefined,undefined,ctx);
   expect(allowed.content[0].text).toContain('NEW_POLICY_OK');
  }
 }finally{
  globals.__piclaw_registerAddonConfigApi=previous;
  if(oldCli===undefined)delete process.env.PI_DELEGATE_CLI;else process.env.PI_DELEGATE_CLI=oldCli;
  rmSync(root,{recursive:true,force:true});
 }
});

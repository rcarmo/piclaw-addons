import { test, expect } from 'bun:test';
import { createLateNightRegrets } from './native.js';
import { selectReview, compactPacket, type Exchange } from './review.js';
import { DECISION_PROMPT } from './decision.js';
import type { Model, Context, SimpleStreamOptions } from '@earendil-works/pi-ai';
import { normalizeContext } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { estimateContextTokens, estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
const window={start:'2026-10-31T00:00:00Z',end:'2026-11-01T00:00:00Z',chat_jid:'web:fixture'};
const exchange=(content:string):Exchange=>({rowid:1,chat_jid:window.chat_jid,timestamp:window.end,target:{rowid:1,speaker:'user',content,truncated:false},context:[]});
const model:Model<'openai-completions'>={provider:'fixture',id:'decision',name:'Decision fixture',api:'openai-completions',baseUrl:'https://regrets.invalid/v1',reasoning:false,input:['text'],contextWindow:16000,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
let wires:Record<string,unknown>[]=[];
async function complete(context:Context,options:SimpleStreamOptions={}){
 return await streamSimple(model,normalizeContext(context),{...options,apiKey:'fixture',maxTokens:1024,fetch:(async(_url,init)=>{
  wires.push(JSON.parse(String(init?.body)));
  const content=JSON.stringify({decisions:[{rowid:1,choice:'routine'}]});
  const body=[{id:'fixture',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content},finish_reason:null}]},{id:'fixture',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10000,completion_tokens:20,total_tokens:10020}}].map(value=>`data: ${JSON.stringify(value)}\n\n`).join('')+'data: [DONE]\n\n';
  return new Response(body,{headers:{'content-type':'text/event-stream'}});
 }) as typeof fetch}).result();
}
const rows=[exchange('a'.repeat(33000))];
const packet=selectReview(rows,window,100000);
const content=JSON.stringify(compactPacket(packet));
const context:Context={systemPrompt:DECISION_PROMPT,messages:[{role:'user',content,timestamp:0}]};
test('control: actual offline SDK wire fits a packet the byte gate refuses',async()=>{
 wires=[];const tokens=estimateContextTokens(normalizeContext(context)).tokens;
 expect(tokens+model.maxTokens+4096).toBeLessThan(model.contextWindow);
 expect(Buffer.byteLength(content+DECISION_PROMPT)/2+1024).toBeGreaterThan(model.contextWindow);
 const result=await complete(context);expect(result.stopReason).toBe('stop');expect(wires).toHaveLength(1);
 expect(wires[0]!.max_tokens??wires[0]!.max_completion_tokens).toBe(1024);
 console.log('REGRETS_OFFLINE_CONTROL',JSON.stringify({tokens,window:model.contextWindow,wireOutput:wires[0]!.max_tokens??wires[0]!.max_completion_tokens}));
});
test('actual native Regrets tool must not veto a SDK-admissible decision by UTF8 bytes/2',async()=>{
 wires=[];
 const addon=createLateNightRegrets({chat:window.chat_jid,cwd:'/fixture',assertCurrent(){},assertSingleUser(){},config:{get:()=>({enabled:true,decision_model:'fixture/decision',review_budget_tokens:100000}),set(){}},history:async()=>({exchanges:rows,excluded:{}}),readFile:async()=>undefined,accountedDecision:{getAvailable:()=>[model],complete:async(_model,c,o)=>complete(c,o)},admitConversationInput:async()=>{throw Error('No input admission allowed')}});
 const result=await addon.tool.execute('fixture-call',{},undefined);
 const data=JSON.parse(result.content[0]!.text);
 expect(data.packet.exchanges).toHaveLength(1);
 expect(data.decision.status).toBe('complete');
 expect(wires).toHaveLength(1);
});
test('packet token budget should use SDK text units, not UTF8 bytes/3',()=>{
 const rows=[exchange('漢'.repeat(700))];const packet=selectReview(rows,window,512);
 const all={...packet,exchanges:rows};
 expect(estimateTextTokens(JSON.stringify(compactPacket(all)))).toBeLessThanOrEqual(512);
 expect(packet.exchanges).toHaveLength(1);
 expect(packet.coverage.estimated_tokens).toBe(estimateTextTokens(JSON.stringify(compactPacket(packet))));
});

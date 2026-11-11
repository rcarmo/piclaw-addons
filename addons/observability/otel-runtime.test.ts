import { afterAll, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { context, trace, SpanKind } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { bindObservabilityConfiguration, prepareObservabilityRuntime, recordToolCall, buildObservabilitySystemPrompt } from './index.ts';
const require = createRequire(import.meta.url);
const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ resource: resourceFromAttributes({ 'service.name': 'isolated-observer-test' }), spanProcessors: [new SimpleSpanProcessor(exporter)] });
trace.setGlobalTracerProvider(provider);
afterAll(async () => { await provider.shutdown(); trace.disable(); });

test('standalone Azure graph uses the same supported API and resource generation', () => {
  const api = require('@opentelemetry/api/package.json');
  const resource = require('@opentelemetry/resources/package.json');
  const sdk = require('@opentelemetry/sdk-trace-base/package.json');
  expect(api.version).toMatch(/^1\.9\./);
  expect(resource.version).toMatch(/^2\./);
  expect(sdk.peerDependencies['@opentelemetry/api']).toContain('<1.10.0');
});

test('tool dependency spans retain the supplied real OpenTelemetry parent', async () => {
  const parent = provider.getTracer('parent-test').startSpan('parent', { kind: SpanKind.SERVER });
  const release = bindObservabilityConfiguration({ assertCurrent() {}, read: () => ({ enabled: false }), write() {} });
  try { recordToolCall('web:test', 'bash', 20, { parentSpan: parent }); }
  finally { parent.end(); release(); }
  await provider.forceFlush();
  const child = exporter.getFinishedSpans().find(span => span.name === 'tool.call');
  expect(child).toBeDefined();
  expect(child!.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
  expect(child!.spanContext().traceId).toBe(parent.spanContext().traceId);
});

test('configured-but-unstarted telemetry does not claim active tracing', async () => {
  const release = bindObservabilityConfiguration({ assertCurrent() {}, read: () => ({ enabled: true, appinsights_enabled: false, graphite_enabled: false, appinsights_live_metrics: false }), write() {} });
  try {
    await prepareObservabilityRuntime();
    const prompt = buildObservabilitySystemPrompt();
    expect(prompt).not.toContain('OTel tracing active');
    expect(prompt).toContain('inactive');
  } finally { release(); }
});

test('native SDK context preserves parents/links/propagation without exporting content', async () => {
  const {createOtelTelemetryContext}=await import('./native-telemetry.ts');
  const {metrics}=await import('@opentelemetry/api');
  const native=createOtelTelemetryContext(()=>provider.getTracer('native-test'),()=>metrics.getMeter('native-test'));
  const result=await native.startSpan({name:'pi.durable.submit',attributes:{'conversation.id':79,prompt:'PRIVATE PROMPT',signature:'OPAQUE SIGNATURE'}},async parent=>{
    const carrier=native.propagation!.inject(parent)!;
    await parent.startSpan({name:'pi.durable.phase',links:[{context:parent}],attributes:{'task.name':'pi.tool','task.id':4,content:'PRIVATE CONTENT'}},async child=>{
      child.addEvent('pi.ai.block',{type:'thinking',chars:30,thinking:'PRIVATE THOUGHT'});
      child.setAttributes({'tool.name':'read','usage.output':42});
      child.setStatus({status:'error',error:{name:'PRIVATE ERROR',message:'PRIVATE TOKEN'}});
    });
    await native.propagation!.extract(JSON.parse(JSON.stringify(carrier))).startSpan({name:'pi.durable.phase'},()=>{});
    return 'unchanged-result';
  });
  expect(result).toBe('unchanged-result');await provider.forceFlush();
  const spans=exporter.getFinishedSpans().filter(s=>s.name.startsWith('pi.durable.'));
  const parent=spans.find(s=>s.name==='pi.durable.submit')!,children=spans.filter(s=>s.name==='pi.durable.phase');
  expect(children).toHaveLength(2);
  for(const child of children){expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);expect(child.spanContext().traceId).toBe(parent.spanContext().traceId);}
  expect(children[0].links[0].context.spanId).toBe(parent.spanContext().spanId);
  const serialized=JSON.stringify(spans.map(span=>({name:span.name,attributes:span.attributes,events:span.events,status:span.status,links:span.links})));
  for(const value of ['PRIVATE PROMPT','OPAQUE SIGNATURE','PRIVATE CONTENT','PRIVATE THOUGHT','PRIVATE ERROR','PRIVATE TOKEN'])expect(serialized).not.toContain(value);
  expect(serialized).toContain('usage.output');
});

test('native exporter failures cannot fail/replay a callback or replace its error', async()=>{
  const {createOtelTelemetryContext}=await import('./native-telemetry.ts');
  const native=createOtelTelemetryContext(()=>{throw Error('exporter unavailable');},()=>{throw Error('meter unavailable');});
  let calls=0;expect(await native.startSpan({name:'pi.durable.phase'},span=>{calls++;span.addEvent('event');span.setAttributes({'task.id':1});return 42;})).toBe(42);expect(calls).toBe(1);
  const error=Error('original task failure');await expect(native.startSpan({name:'pi.durable.phase'},()=>{calls++;throw error;})).rejects.toBe(error);expect(calls).toBe(2);
  expect(()=>native.metrics!.counter('counter').add(1)).not.toThrow();
});

test('disabled native telemetry stays passive and instruments follow later activation',async()=>{
  const {createOtelTelemetryContext}=await import('./native-telemetry.ts');
  let enabled=false,records=0,tracers=0;
  const native=createOtelTelemetryContext(()=>{tracers++;return provider.getTracer('activation');},()=>({createCounter:()=>({add(){records++;}})}) as any,()=>enabled);
  const counter=native.metrics!.counter('pi.ai.tokens');counter.add(1);
  expect(records).toBe(0);expect(await native.startSpan({name:'disabled'},()=>42)).toBe(42);expect(tracers).toBe(0);
  enabled=true;counter.add(1);await native.startSpan({name:'enabled'},()=>{});expect(records).toBe(1);expect(tracers).toBe(1);
  enabled=false;counter.add(1);expect(records).toBe(1);
});

test('legacy span correlation cannot cross chats that reuse turn and tool-call IDs',async()=>{
 const globals=globalThis as any,previous=globals.__piclawRuntimeInterop;let sink:((r:any)=>void)|undefined;
 globals.__piclawRuntimeInterop={addLogSink:(s:any)=>{sink=s;},removeLogSink:()=>{}};
 const {createServer}=await import('node:net');const server=createServer(s=>s.on('error',()=>{}));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const native=await import(`./index.ts?correlation=${crypto.randomUUID()}`);
 const release=native.bindObservabilityConfiguration({assertCurrent(){},read:()=>({enabled:true,instance_name:'fixture',appinsights_enabled:false,graphite_enabled:true,graphite_host:'127.0.0.1',graphite_port:(server.address() as any).port}),write(){}});
 try{
  await native.prepareObservabilityRuntime();expect(sink).toBeFunction();
  const emit=(chatJid:string,operation:string)=>sink!({chatJid,operation,turnId:'same-turn',toolCallId:'call-1',toolName:'read',level:'info',module:'fixture',message:'fixture'});
  for(const chat of['chat-a','chat-b']){emit(chat,'run_agent.prompt');emit(chat,'tool.call.start');}
  for(const chat of['chat-a','chat-b']){emit(chat,'tool.call.end');emit(chat,'run_agent.complete');}
  await provider.forceFlush();
  const spans=exporter.getFinishedSpans();
  for(const chat of['chat-a','chat-b']){const parent=spans.find(s=>s.name==='agent.turn'&&s.attributes['piclaw.chat_jid']===chat);const child=spans.find(s=>s.name==='tool.call'&&s.attributes['piclaw.chat_jid']===chat);expect(parent).toBeDefined();expect(child).toBeDefined();expect(child!.parentSpanContext?.spanId).toBe(parent!.spanContext().spanId);}
 }finally{await native.shutdownObservabilityRuntime();release();server.close();globals.__piclawRuntimeInterop=previous;}
});

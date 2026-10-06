/** Shared, side-effect-free curated-training and inference contract. */
export const FEATURE_VERSION = 'interaction-v2';
export const LABELS = ['neutral', 'successful_execution', 'course_correction', 'misinterpretation', 'over_engineering', 'under_delivery', 'context_failure', 'good_proactive'] as const;
export type Label = typeof LABELS[number];
export const ATTENTION_LABELS = new Set<string>(['course_correction','misinterpretation','over_engineering','under_delivery','context_failure']);
export interface Message { content: string; sender?: string; sender_name?: string; speaker?: string; content_blocks?: string | unknown[]; markers?: unknown[] }
export interface Example { label: Label; message: Message; context: Message[] }
export interface Model { classes: string[]; classDocCounts: Record<string,number>; classTokenTotals: Record<string,number>; tokenCounts: Record<string,Record<string,number>>; vocab: string[]; alpha: number; totalDocs: number; logPriors: Record<string,number> }
export function isAgent(m: Message): boolean { return m.speaker === 'assistant' || m.sender === 'agent' || m.sender === 'web-agent' || m.sender_name === 'Smith'; }
export function provenance(m: Message): 'automation' | 'relay' | 'human' {
  let blocks: unknown[] = m.markers || [];
  try { if(m.content_blocks) blocks = typeof m.content_blocks === 'string' ? JSON.parse(m.content_blocks) : m.content_blocks; } catch { /* legacy malformed blocks supply no provenance */ }
  if(Array.isArray(blocks) && blocks.some((x:any)=>x && x.source === 'exit_process' && ['restart_handoff','self_continuation'].includes(x.type))) return 'automation';
  if(/^\s*🎯\s*(?:Continue goal|Goal updated)\s*:/iu.test(m.content)) return 'automation';
  if(/^From: [^\n]+\nReply-To: [^\n]+\nTo: [^\n]+\n/iu.test(m.content)) return 'relay';
  return 'human';
}
export function routineContinuation(m:Message): boolean {
  return /^(?:continue(?:,? according to plan)?|proceed|keep going|go ahead|report)[.!\s]*$/i.test(m.content.trim());
}
const STOP = new Set('the and for that with this from have your are was were will would can could should has had but all any our out into about then than them they their there when where which while also been after before some very much many how who does let lets its it to of in on at as by an a is be or if we i me my so up off get got ll ve re'.split(' '));
export function tokenize(text:string):string[] {
  return (text.toLowerCase().replace(/```[\s\S]*?```/g,' ').replace(/https?:\/\/\S+|data:\S+/g,' ').replace(/\/(?:workspace|home|usr|opt|tmp)\/[^\s]+/g,' ').replace(/\b[0-9a-f]{8,}\b|#\d+|\b\d+\b/g,' ').match(/[a-z]+(?:'[a-z]+)?/g)||[]).filter(t=>!STOP.has(t)&&t.length>1).slice(0,180);
}
export function features(m:Message,context:Message[]):string[] {
  context = context.slice(-5);
  const tokens=tokenize(m.content); const out=[...tokens];
  for(let i=1;i<tokens.length;i++)out.push(tokens[i-1]+'__'+tokens[i]);
  const p=provenance(m);out.push('__origin_'+p);
  if(routineContinuation(m))out.push('__routine');
  out.push('__length_'+(m.content.length<25?'tiny':m.content.length<100?'short':m.content.length<300?'medium':'long'));
  const prev=[...context].reverse().find(isAgent);
  if(prev){out.push('__has_agent');out.push(...tokenize(prev.content).slice(0,40).map(t=>'prev:'+t));if(/(?:timed out|tool.use budget|context limit|recovery exhausted)/i.test(prev.content))out.push('__recovery');if(/\?\s*$/.test(prev.content))out.push('__answering_question');}
  const counts=new Map<string,number>(); return out.filter(t=>{const n=(counts.get(t)||0)+1;counts.set(t,n);return n<=2;});
}
export function train(examples:Example[],alpha=1):Model {
  if(!Number.isFinite(alpha)||alpha<=0||!examples.length)throw Error('Positive alpha and nonempty examples required');
  const classes=[...LABELS];const classDocCounts:Record<string,number>={},classTokenTotals:Record<string,number>={},tokenCounts:Record<string,Record<string,number>>={},logPriors:Record<string,number>={};const vocab=new Set<string>();
  for(const c of classes){classDocCounts[c]=0;classTokenTotals[c]=0;tokenCounts[c]=Object.create(null);}
  for(const row of examples){if(!classes.includes(row.label))throw Error('Unknown training label');classDocCounts[row.label]++;for(const t of features(row.message,row.context)){vocab.add(t);classTokenTotals[row.label]++;tokenCounts[row.label][t]=(tokenCounts[row.label][t]||0)+1;}}
  for(const c of classes)logPriors[c]=classDocCounts[c]?Math.log((classDocCounts[c]+1)/(examples.length+classes.length)):-Infinity;
  // JSON cannot encode -Infinity. Absent classes are retained for coverage reporting, not prediction.
  for(const c of classes)if(!classDocCounts[c])logPriors[c]=-1e100;
  return {classes,classDocCounts,classTokenTotals,tokenCounts,vocab:[...vocab].sort(),alpha,totalDocs:examples.length,logPriors};
}
const vocabCache=new WeakMap<Model,Set<string>>();
export function predict(model:Model,tokens:string[]):{label:Label;confidence:number} {
  let vocabulary=vocabCache.get(model);if(!vocabulary){vocabulary=new Set(model.vocab);vocabCache.set(model,vocabulary);}
  const counts=new Map<string,number>();for(const t of tokens)if(vocabulary.has(t))counts.set(t,(counts.get(t)||0)+1);
  const scores=model.classes.map(c=>{let s=model.logPriors[c];const denom=model.classTokenTotals[c]+model.alpha*Math.max(1,model.vocab.length);for(const[t,n]of counts)s+=n*Math.log(((Object.hasOwn(model.tokenCounts[c],t) ? model.tokenCounts[c][t] : 0)+model.alpha)/denom);return [c,s] as const;}).sort((a,b)=>b[1]-a[1]);
  const[best,score]=scores[0];return {label:best as Label,confidence:1/scores.reduce((n,[,s])=>n+Math.exp(s-score),0)};
}
export function predictMessage(model:Model,m:Message,context:Message[]):{label:Label;confidence:number;rule?:string} {
  // Textual relay/goal prefixes are useful features, not trusted suppression authority.
  let blocks: any[] = m.markers || [];
  try { if(m.content_blocks) blocks = typeof m.content_blocks === 'string' ? JSON.parse(m.content_blocks) : m.content_blocks; } catch { blocks=[]; }
  if(Array.isArray(blocks) && blocks.some(x=>x?.source==='exit_process' && ['restart_handoff','self_continuation'].includes(x.type))) return {label:'neutral',confidence:1,rule:'structured_automation'};
  if(routineContinuation(m))return {label:'neutral',confidence:1,rule:'routine_continuation'};
  return predict(model,features(m,context));
}

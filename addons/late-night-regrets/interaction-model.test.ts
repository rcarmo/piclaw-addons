import { test, expect } from 'bun:test';
import { train,predict,predictMessage,features,provenance,routineContinuation,isAgent,ATTENTION_LABELS,LABELS } from './scripts/interaction-model';
const model=train([{label:'neutral',message:{content:'Please create another test'},context:[]},{label:'under_delivery',message:{content:'You forgot the required test'},context:[]}]);
test('structured and text provenance ignore display user',()=>{
 expect(provenance({content:'Finish missing work',content_blocks:JSON.stringify([{type:'self_continuation',source:'exit_process'}])})).toBe('automation');
 expect(provenance({content:'🎯 Continue goal: finish everything'})).toBe('automation');
 expect(provenance({content:'From: Smith (@ux)\nReply-To: @ux\nTo: @github\n\nYou forgot this'})).toBe('relay');
 expect(provenance({content:'I disagree',content_blocks:'broken'})).toBe('human');
});
test('bare continuation neutral; explicit omission not suppressed',()=>{
 for(const content of ['continue','continue, according to plan','report','proceed!'])expect(predictMessage(model,{content},[]).rule).toBe('routine_continuation');
 expect(routineContinuation({content:'continue, you forgot the required tests'})).toBe(false);
 expect(predictMessage(model,{content:'You forgot the required test'},[]).label).toBe('under_delivery');
 expect(predictMessage(model,{content:'🎯 Continue goal: you forgot the required test'},[]).rule).toBeUndefined();
 expect(predictMessage(model,{content:'You forgot',markers:[{type:'self_continuation',source:'exit_process'}]},[]).label).toBe('neutral');
});
test('shared features bounded, preserve negation, canonical speaker',()=>{
 expect(isAgent({content:'',sender:'web-user'})).toBe(false);expect(isAgent({content:'',speaker:'assistant'})).toBe(true);
 const f=features({content:'not correct '.repeat(200)},[{content:'finished '.repeat(100),speaker:'assistant'}]);
 expect(f.filter(x=>x==='not')).toHaveLength(2);expect(f.filter(x=>x.startsWith('prev:')).length).toBeLessThanOrEqual(40);
 expect(features({content:'same'},[{content:'timeout',speaker:'assistant'}])).not.toEqual(features({content:'same'},[{content:'done',speaker:'assistant'}]));
});
test('OOV ignored and model deterministic/serialisable',()=>{
 const a=predict(model,[]);expect(predict(model,['zzunknown','anotherunknown'])).toEqual(a);
 expect(predictMessage(JSON.parse(JSON.stringify(model)),{content:'You forgot the required test'},[])).toEqual(predictMessage(model,{content:'You forgot the required test'},[]));
 const prototype=train([{label:'neutral',message:{content:'constructor'},context:[]},{label:'under_delivery',message:{content:'forgot'},context:[]}]);
 expect(Number.isFinite(predict(JSON.parse(JSON.stringify(prototype)),['constructor']).confidence)).toBe(true);
 expect(model.classes).toEqual([...LABELS]);expect(ATTENTION_LABELS.has('good_proactive')).toBe(false);expect(ATTENTION_LABELS.size).toBe(5);
});

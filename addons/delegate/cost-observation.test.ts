import {expect,test} from 'bun:test';
import {parseDelegateJsonOutput} from './delegate.ts';
const event=(usage:unknown,id:string)=>JSON.stringify({type:'message_end',message:{role:'assistant',responseId:id,provider:'fixture',model:'fixture-model',timestamp:1,content:[{type:'text',text:'result'}],stopReason:'stop',...(usage===undefined?{}:{usage})}});
for(const [name,usage,expected]of [
 ['absent',undefined,{cost:null,costProvenance:'unavailable',providerCostTotal:null,catalogueCostTotal:null,unknownCostCount:1}],
 ['SDKplaceholder',{cost:{total:0}},{cost:null,costProvenance:'unavailable',providerCostTotal:null}],
 ['SDKplaceholderExplicitFalse',{cost:{total:0,totalFromProvider:false}},{cost:null,costProvenance:'unavailable',providerCostTotal:null}],
 ['documentedFreeEstimate',{cost:{total:0},documentedFree:true},{cost:0,costCurrency:'USD',costProvenance:'catalogue_estimate',catalogueCostTotal:0}],
 ['billedZero',{cost:{total:0,totalFromProvider:true}},{cost:0,costCurrency:'USD',costProvenance:'provider_reported',providerCostTotal:0}],
 ['billedPositive',{cost:{total:2,totalFromProvider:true}},{cost:2,costCurrency:'USD',costProvenance:'provider_reported',providerCostTotal:2}],
 ['estimate',{cost:{total:3}},{cost:3,costCurrency:'USD',costProvenance:'catalogue_estimate',catalogueCostTotal:3}],
]as const)test(`CLI Delegate cost presence/provenance ${name}`,()=>{expect(parseDelegateJsonOutput(event(usage,name)).usage).toMatchObject(expected);});
test('CLI Delegate keeps known actual/estimate subtotals while incomplete usage remains unknown; duplicate events do not double count',()=>{
 const zero=event({input:1,cost:{total:0,totalFromProvider:true}},'zero'),estimate=event({input:2,cost:{total:3}},'estimate'),missing=event(undefined,'unknown');
 const full=parseDelegateJsonOutput([zero,estimate,zero].join('\n'));expect(full.usage).toMatchObject({input:3,cost:3,costCurrency:'USD',costProvenance:'mixed',providerCostTotal:0,catalogueCostTotal:3,unknownCostCount:0});
 const partial=parseDelegateJsonOutput([zero,estimate,missing].join('\n'));expect(partial.usage).toMatchObject({input:3,cost:null,costProvenance:'unavailable',providerCostTotal:0,catalogueCostTotal:3,unknownCostCount:1});
});

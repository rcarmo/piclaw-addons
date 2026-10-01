#!/usr/bin/env bun
/** Train a candidate from reviewed JSONL. Never reads live SQLite or overwrites default weights. */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { train, FEATURE_VERSION, LABELS, type Example } from './interaction-model';
const { values:v }=parseArgs({args:Bun.argv.slice(2),options:{input:{type:'string'},output:{type:'string'},alpha:{type:'string',default:'1'}},strict:true});
if(!v.input||!v.output)throw Error('Required: --input reviewed.jsonl --output NEW-candidate.json');
const raw=readFileSync(v.input,'utf8');const rows=raw.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
const seen=new Set<string>();const data:Example[]=rows.map((r:any)=>{
 if(r.split!=='train'||!r.label_source||!LABELS.includes(r.label)||!r.state?.target||!Array.isArray(r.state.context)||r.id===undefined)throw Error('Each row needs unique id, split=train, label_source, valid label and state.target/context');
 if(seen.has(String(r.id)))throw Error('Duplicate id');seen.add(String(r.id));
 return {label:r.label,message:r.state.target,context:r.state.context};
});
const model=train(data,Number(v.alpha));const metadata={generated_at:new Date().toISOString(),feature_version:FEATURE_VERSION,label_source:'reviewed pi-decision dataset',dataset_sha256:new Bun.CryptoHasher('sha256').update(raw).digest('hex'),train_set:data.length,class_counts:model.classDocCounts,calibrated:false};
writeFileSync(v.output,JSON.stringify({metadata,model})+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(metadata));

import { test, expect } from 'bun:test';
import { mkdtempSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
const trainPath=join(import.meta.dir,'scripts/train-curated.ts'),classifyPath=join(import.meta.dir,'scripts/classify-recent.ts');
test('curated train + recent CLI share schema; rules and real complaint',()=>{
 const root=mkdtempSync(join(tmpdir(),'regrets-cli-'));try{
 const input=join(root,'input.jsonl'),weights=join(root,'candidate.json'),dbPath=join(root,'messages.db'),out=join(root,'out');
 writeFileSync(input,[['neutral','Please create another test'],['under_delivery','You forgot the required tests']].map(([label,content],id)=>JSON.stringify({id,split:'train',label_source:'test-fixture',label,state:{target:{content,speaker:'user'},context:[]}})).join('\n')+'\n');
 let p=Bun.spawnSync(['bun',trainPath,'--input',input,'--output',weights]);expect(p.exitCode).toBe(0);
 const content=readFileSync(weights,'utf8');
 const latest=join(root,'interaction-quality-weights-latest.json');writeFileSync(latest,content);
 const weak=Bun.spawnSync(['bun',join(import.meta.dir,'scripts/train-interaction-quality-bayes.ts'),'--db',join(root,'missing.db'),'--out-dir',root]);expect(weak.exitCode).toBe(0);expect(readFileSync(latest,'utf8')).toBe(content);
 p=Bun.spawnSync(['bun',trainPath,'--input',input,'--output',weights]);expect(p.exitCode).not.toBe(0);expect(readFileSync(weights,'utf8')).toBe(content);
 const db=new Database(dbPath);db.exec('CREATE TABLE messages(chat_jid TEXT,sender TEXT,sender_name TEXT,timestamp TEXT,content TEXT,content_blocks TEXT)');
 const add=db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)');
 for(const text of ['continue, according to plan','proceed','You forgot the required tests']){const t=new Date().toISOString();add.run('test','web-agent','Smith',t,'Done',null);add.run('test','web-user','User',t,text,null);}db.close();
 p=Bun.spawnSync(['bun',classifyPath,'--db',dbPath,'--weights',weights,'--out-dir',out]);expect(p.exitCode).toBe(0);
 const predictions=readFileSync(join(out,'interaction-quality-recent-latest.jsonl'),'utf8').trim().split('\n').map(JSON.parse);expect(predictions).toHaveLength(3);expect(predictions[0].predicted_label).toBe('neutral');expect(predictions[1].predicted_label).toBe('neutral');expect(predictions[2].predicted_label).toBe('under_delivery');
 const payload=JSON.parse(content);payload.metadata.feature_version='future-v99';writeFileSync(weights,JSON.stringify(payload));p=Bun.spawnSync(['bun',classifyPath,'--db',dbPath,'--weights',weights,'--out-dir',out]);expect(p.exitCode).not.toBe(0);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('curated trainer rejects holdout/uncertain labels',()=>{
 const root=mkdtempSync(join(tmpdir(),'regrets-train-'));try{for(const change of [{split:'holdout'},{label:'uncertain'}]){const row={id:1,split:'train',label:'neutral',label_source:'fixture',state:{target:{content:'ok'},context:[]},...change};const input=join(root,'in.jsonl');writeFileSync(input,JSON.stringify(row)+'\n');expect(Bun.spawnSync(['bun',trainPath,'--input',input,'--output',join(root,'out.json')]).exitCode).not.toBe(0);}}finally{rmSync(root,{recursive:true,force:true});}
});

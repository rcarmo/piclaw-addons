import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync,unlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ReviewService} from './dispatch.ts';
import {reviewAction} from './runtime.ts';
import {reviewAuthor} from './web/api.ts';
import type {ReviewIdentity,SourceCapture} from './contracts.ts';
const human:ReviewIdentity={ownerId:'o',actorId:'human',kind:'operator',workspaceId:'w'};
const target={chatId:'web:worker',incarnation:'b1',label:'Worker'};
const agent:ReviewIdentity={ownerId:'o',actorId:'b1',kind:'agent',workspaceId:'w',chatId:target.chatId,chatIncarnation:target.incarnation};
let seq=0;const m=(expectedVersion?:number)=>({requestId:'test-'+(++seq),expectedVersion});
function fixture(){const root=mkdtempSync(join(tmpdir(),'review-life-'));const s=new ReviewService(join(root,'review.db'));return{root,s,close(){s.close();rmSync(root,{recursive:true,force:true});}};}
function create(s:ReviewService){const input={title:'Review',focusPath:'file.ts',target};const capture:SourceCapture={mode:'source',workspaceId:'w',worktreeId:'tree',base:null,head:null,capturedAt:new Date().toISOString(),files:[{oldPath:null,newPath:'file.ts',change:'source',oldText:null,newText:'secret source\n'}]};const mutation=m();const r=s.createFromCapture(human,input,capture,mutation);return {r,input,capture,mutation};}
function thread(s:ReviewService,r:any){return s.createThread(human,r.reviewId,{fileId:r.files[0],side:'source',body:'secret comment'},m());}
function age(s:ReviewService,id:string){const old='2020-01-01T00:00:00.000Z';s.database.run('UPDATE reviews SET updated_at=? WHERE id=?',old,id);s.database.run('UPDATE events SET created_at=? WHERE review_id=?',old,id);s.database.run('UPDATE drafts SET updated_at=? WHERE review_id=?',old,id);}

test('delete by ID purges history without source access; replay cannot resurrect; scope and version enforced',()=>{
 const f=fixture();try{const x=create(f.s),y=create(f.s);const t=thread(f.s,x.r);f.s.saveDraft(human,x.r.reviewId,{threadId:t.threadId,body:'private draft'},m());
 writeFileSync(join(f.root,'file.ts'),'untouched');unlinkSync(join(f.root,'file.ts'));
 expect(()=>f.s.deleteReview(agent,{reviewId:x.r.reviewId,...m(1)})).toThrow();
 expect(()=>f.s.deleteReview({...human,workspaceId:'other'},{reviewId:x.r.reviewId,...m(1)})).toThrow();
 expect(()=>f.s.deleteReview(human,{reviewId:x.r.reviewId,...m(999)})).toThrow();
 const input={reviewId:x.r.reviewId,...m(f.s.getReview(human,x.r.reviewId).version)};
 expect(f.s.deleteReview(human,input).deleted).toBe(true);expect(f.s.deleteReview(human,input).deleted).toBe(true);
 for(const table of ['snapshots','snapshot_files','blobs','threads','messages','drafts','events','dispatches','dispatch_items'])expect(f.s.database.get<any>(`SELECT COUNT(*) n FROM ${table} WHERE review_id=?`,x.r.reviewId)!.n).toBe(0);
 expect(f.s.database.get<any>('SELECT COUNT(*) n FROM message_revisions')!.n).toBe(0);
 expect(()=>f.s.createFromCapture(human,x.input,x.capture,x.mutation)).toThrow();
 expect(f.s.getReview(human,y.r.reviewId).id).toBe(y.r.reviewId);expect(existsSync(join(f.root,'file.ts'))).toBe(false);
 }finally{f.close();}
});

test('retention defaults off; removes old inactive data, preserves active/recent drafts and outstanding work',async()=>{
 const f=fixture();try{const old=create(f.s),recent=create(f.s),draft=create(f.s),queued=create(f.s);age(f.s,old.r.reviewId);age(f.s,draft.r.reviewId);age(f.s,queued.r.reviewId);
 expect(f.s.cleanupOldReviews(human).deletedCount).toBe(0);
 for(const days of [0,-1,1.5,3651])expect(()=>f.s.saveSettings(human,days)).toThrow();
 f.s.saveSettings(human,30);
 f.s.saveDraft(human,draft.r.reviewId,{body:'recent draft',anchor:f.s.getThread(human,thread(f.s,draft.r).threadId).anchor},m());
 const t=thread(f.s,queued.r);const d=f.s.submit(human,queued.r.reviewId,{target,items:[{threadId:t.threadId,version:1}]},m());age(f.s,queued.r.reviewId);
 expect(f.s.cleanupOldReviews(human).deletedReviewIds).toEqual([old.r.reviewId]);
 expect(f.s.getReview(human,recent.r.reviewId)).toBeTruthy();expect(f.s.getReview(human,draft.r.reviewId)).toBeTruthy();expect(f.s.getReview(human,queued.r.reviewId)).toBeTruthy();
 await f.s.deliver(human,d.dispatchId,{enqueue:async()=>{throw Error('unknown');}});age(f.s,queued.r.reviewId);expect(f.s.cleanupOldReviews(human).deletedCount).toBe(0);
 f.s.saveSettings(human,null);expect(f.s.getSettings(human).retentionDays).toBeNull();
 }finally{f.close();}
});

test('operator resolves without a message; agent still requires an explanation',()=>{
 const f=fixture();try{const {r}=create(f.s);const t=thread(f.s,r);
 expect(()=>f.s.resolveThread(agent,t.threadId,{fileId:r.files[0],explanation:'',assignmentEpoch:1},m(1))).toThrow();
 const result=f.s.resolveThread(human,t.threadId,{fileId:r.files[0],explanation:''},m(1));expect(result.messageId).toBeNull();
 const data=f.s.getThread(human,t.threadId);expect(data.state).toBe('resolved');expect(data.messages).toHaveLength(1);
 }finally{f.close();}
});

test('unsent summary follows published versions, not manual selection; private drafts do not become sends',async()=>{
 const f=fixture();try{const {r}=create(f.s);const t=thread(f.s,r);
 expect(f.s.listThreads(human,r.reviewId)[0]!.summary).toMatchObject({unsent:true,outstanding:false,authorId:'human'});
 const d=f.s.submit(human,r.reviewId,{target,items:[{threadId:t.threadId,version:1}]},m());await f.s.deliver(human,d.dispatchId,{enqueue:async()=>({status:'accepted',rowId:1})});
 expect(f.s.listThreads(human,r.reviewId)[0]!.summary).toMatchObject({unsent:false,outstanding:true});
 f.s.reply(human,t.threadId,'new guidance',m(1));expect(f.s.listThreads(human,r.reviewId)[0]!.summary.unsent).toBe(true);
 }finally{f.close();}
});

test('author presentation uses trusted author ID, escapes via rendering, and handles absent/unsafe profiles',()=>{
 const profiles={user:{name:'Rui',avatar_url:'/user.png'},agents:[{name:'Smith',avatar_url:'/agent.png'}]};const targets=[{incarnation:'b1',agentName:'worker'}];
 expect(reviewAuthor('operator','human',profiles,targets)).toEqual({name:'Rui',avatar:'/user.png'});
 expect(reviewAuthor('agent','b1',profiles,targets)).toEqual({name:'Smith (@worker)',avatar:'/agent.png'});
 expect(reviewAuthor('agent','deleted-agent',profiles,targets)).toEqual({name:'Agent',avatar:null});
 expect(reviewAuthor(null,null,profiles,targets).name).toBe('Unknown author');
 expect(reviewAuthor('operator','human',{user:{name:'Rui',avatar_url:'javascript:alert(1)'}},[]).avatar).toBeNull();
});

test('deletion waits for an in-flight send; later agent writes cannot restore deleted review',async()=>{
 const f=fixture();let release:()=>void=()=>{};let delivering:Promise<unknown>|undefined;
 try{const {r}=create(f.s);const t=thread(f.s,r);const d=f.s.submit(human,r.reviewId,{target,items:[{threadId:t.threadId,version:1}]},m());
  let entered:()=>void=()=>{};const start=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
  delivering=f.s.deliver(human,d.dispatchId,{enqueue:async()=>{entered();await gate;return{status:'accepted',rowId:2};}});
  await start;const input={reviewId:r.reviewId,...m(f.s.getReview(human,r.reviewId).version)};
  expect(()=>f.s.deleteReview(human,input)).toThrow('send is in progress');release();await delivering;
  expect(f.s.deleteReview(human,input).deleted).toBe(true);
  expect(()=>f.s.reply(agent,t.threadId,'late answer',m(1),1)).toThrow('unavailable');
  expect(()=>f.s.inspectDispatch(human,d.dispatchId)).toThrow('unavailable');
 }finally{release();await delivering?.catch(()=>{});f.close();}
});

test('retention preference survives reopen and cleanup cannot cross workspace',()=>{
 const f=fixture();try{const x=create(f.s);age(f.s,x.r.reviewId);f.s.saveSettings(human,1);
  const other={...human,workspaceId:'different'};f.s.saveSettings(other,7);
  expect(f.s.cleanupConfiguredReviews('different')).toBe(0);
  const separate=new ReviewService(join(f.root,'review.db'));try{expect(separate.getSettings(human).retentionDays).toBe(1);expect(separate.cleanupConfiguredReviews('w')).toBe(1);}finally{separate.close();}
 }finally{f.close();}
});

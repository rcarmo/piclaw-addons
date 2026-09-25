import {test,expect} from 'bun:test';
import {chromium} from 'playwright';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {ReviewService} from './dispatch.ts';
import {reviewAction} from './runtime.ts';
import type {LocalContext} from './host.ts';

const settingsTest = process.env.PICLAW_E2E_DISPOSABLE === '1' && process.env.PICLAW_SETTINGS_CORE_SOURCE ? test : test.skip;
settingsTest('Settings opens/deletes reviews with missing sources; identities, filters, one-click resolve and retention work',async()=>{
 const root=mkdtempSync(join(tmpdir(),'review-settings-ui-')),workspace=join(root,'workspace');mkdirSync(workspace);
 writeFileSync(join(workspace,'validation.ts'),'export function validate(name: string) {\n  return name.trim();\n}\n');
 const service=new ReviewService(join(root,'review.db'));let server,browser;
 const target={chatJid:'web:worker',incarnation:'branch-worker',agentName:'worker',label:'Implementation',active:false};
 const ctx:LocalContext={version:1,accessMode:'single-user',ownerId:'owner',actorId:'operator',kind:'operator',workspaceRoot:workspace,workspaceId:'workspace',async listTargets(){return[target];},async resolveTarget(){return target;},async enqueue(){return{status:'accepted',rowId:1};}};
 try{
  const created:any=await reviewAction(ctx,'create',{title:'Input validation',path:'validation.ts',target,requestId:'create-fixture'},service);
  const thread:any=await reviewAction(ctx,'comment',{reviewId:created.reviewId,fileId:created.files[0],side:'source',range:{startLine:2,endLine:2},body:'Please reject an empty name before trimming.',requestId:'comment-fixture'},service);
  service.reply({ownerId:ctx.ownerId,actorId:target.incarnation,kind:'agent',workspaceId:ctx.workspaceId,chatId:target.chatJid,chatIncarnation:target.incarnation},thread.threadId,'I will add an explicit check and a regression test.',{requestId:'agent-reply',expectedVersion:1},1);
  const core=process.env.PICLAW_SETTINGS_CORE_SOURCE!;
  const preactPath=join(core,'node_modules/preact');
  const preactEntry=join(root,'preact.ts');writeFileSync(preactEntry,`import{h,render}from '${preactPath}/dist/preact.module.js';import{useRef,useEffect}from '${preactPath}/hooks/dist/hooks.module.js';import htm from '${join(core,'node_modules/htm/dist/htm.module.js')}';window.__piclawPreactHtm={h,render,useRef,useEffect,html:htm.bind(h)};`);
  const build=await Bun.build({entrypoints:[preactEntry],outdir:root,target:'browser',format:'esm',naming:'preact.js',plugins:[{name:'one-preact',setup(build){build.onResolve({filter:/^preact$/},()=>({path:join(preactPath,'dist/preact.module.js')}));}}]});expect(build.success).toBe(true);
  const transpile=new Bun.Transpiler({loader:'ts',target:'browser'});
  server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){const path=new URL(req.url).pathname;
   if(path==='/')return new Response(`<!doctype html><html><head><link rel="stylesheet" href="/static/classic/fixture.css"><style>:root{--bg-primary:#fff;--bg-secondary:#f6f6f6;--bg-hover:#eee;--border-color:#d0d0d0;--text-primary:#222;--text-secondary:#666;--accent-color:#176f83;--accent-contrast-text:#fff;--bg-code:#fafafa;--text-code:#222;--font-family:system-ui;--font-family-mono:monospace}*{box-sizing:border-box}body{margin:0;font:13px system-ui}nav{height:42px;padding:8px 12px;background:#f3f3f3;border-bottom:1px solid #ccc}#pane{height:calc(100vh - 42px)}#settings{padding:16px}</style></head><body><nav><button id="settings-button">Code Review Settings</button> <span>Review · validation.ts</span></nav><main id="pane"></main><main id="settings" hidden></main><script type="module">
    import '/preact.js';let pane,settings;
    window.__piclaw_web={workspaceActionsVersion:1,registerPane(p){pane=p;},registerWorkspaceAction(){},registerSettingsPane(s){settings=s;},openPane(c){window.instance?.dispose();document.getElementById('settings').hidden=true;document.getElementById('pane').hidden=false;window.instance=pane.mount(document.getElementById('pane'),c);return true;}};
    document.getElementById('settings-button').onclick=()=>{document.getElementById('pane').hidden=true;document.getElementById('settings').hidden=false;const{h,render}=window.__piclawPreactHtm;render(h(settings.component),document.getElementById('settings'));};
    await import('/web/index.ts');window.__piclaw_web.openPane({path:'piclaw://addon/code-review/${created.reviewId}'});
   </script></body></html>`,{headers:{'content-type':'text/html'}});
   if(path==='/preact.js')return new Response(Bun.file(join(root,'preact.js')),{headers:{'content-type':'text/javascript'}});
   if(path.startsWith('/web/')&&['index.ts','api.ts','pane.ts','styles.ts'].includes(path.split('/').at(-1)!))return new Response(transpile.transformSync(await Bun.file(join(import.meta.dir,path.slice(1))).text()),{headers:{'content-type':'text/javascript'}});
   if(path==='/agent/roster')return Response.json({user:{name:'Alex Morgan',avatar_url:'/avatar-user.png'},agents:[{name:'Smith',avatar_url:'/avatar-agent.png'}]});
   if(path.startsWith('/avatar-'))return new Response(`<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" rx="24" fill="${path.includes('user')?'#365f79':'#52643b'}"/><text x="24" y="31" text-anchor="middle" font-family="sans-serif" font-size="24" fill="white">${path.includes('user')?'A':'S'}</text></svg>`,{headers:{'content-type':'image/svg+xml'}});
   if(path==='/agent/addons/api/code-review/action'){try{const body=await req.json();return Response.json({ok:true,result:await reviewAction(ctx,body.action,body,service)});}catch(error){return Response.json({ok:false,error:{message:(error as Error).message}},{status:400});}}
   return new Response('',{headers:{'content-type':'text/css'}});
  }});
  const env:Record<string,string>={};for(const key of ['PATH','HOME','TMPDIR','XDG_CACHE_HOME'])if(process.env[key])env[key]=process.env[key]!;
  browser=await chromium.launch({headless:true,executablePath:process.env.PICLAW_REVIEW_TEST_BROWSER,args:['--no-sandbox'],env});const page=await browser.newPage({viewport:{width:1280,height:800}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));let dialogs=0;page.on('dialog',async d=>{dialogs++;await d.accept();});
  await page.goto(server.url.href);await page.waitForSelector('.cr-author-name');
  expect(await page.locator('.cr-messages .cr-author-name').allTextContents()).toEqual(['Alex Morgan','Smith (@worker)']);expect(await page.locator('.cr-messages .cr-avatar img').count()).toBe(2);
  expect(await page.locator('[data-pick]').count()).toBe(0);expect(await page.locator('[data-action=receipts],.cr-receipts').count()).toBe(0);
  await page.locator('.cr-toolbar [data-action=threads]').click();expect(await page.locator('#cr-thread-filter option').allTextContents()).toEqual(['All','Open','Resolved','Outdated','Unsent']);
  expect(await page.locator('.cr-drawer-item .cr-author-name').innerText()).toBe('Alex Morgan');await page.locator('button[data-action=close-drawer]').click();
  if(process.env.PICLAW_REVIEW_SCREENSHOTS){const dest=process.env.PICLAW_REVIEW_SCREENSHOTS;mkdirSync(dest,{recursive:true});await page.screenshot({path:join(dest,'code-review-discussion.png')});}
  const before=dialogs;await page.locator('.cr-thread [data-action=resolve]').click();await page.waitForSelector('.cr-thread [data-action=reopen]');expect(dialogs).toBe(before);
  expect(service.getThread({ownerId:ctx.ownerId,actorId:ctx.actorId,kind:'operator',workspaceId:ctx.workspaceId},thread.threadId).messages).toHaveLength(2);
  unlinkSync(join(workspace,'validation.ts'));
  await page.click('#settings-button');await page.waitForSelector('.cr-review-list article');expect(await page.locator('#cr-retention-enabled').isChecked()).toBe(false);
  await page.locator('[data-settings-action=open]').click();await page.waitForSelector('.cr-line');expect(await page.locator('.cr-source').innerText()).toContain('validate');
  await page.click('#settings-button');await page.locator('#cr-retention-enabled').check();await page.locator('#cr-retention-days').fill('30');await page.locator('[data-settings-action=save]').click();await page.waitForFunction(()=>document.querySelector('.cr-reviews-settings [role=status]')?.textContent==='Settings saved.');
  expect(service.getSettings({ownerId:ctx.ownerId,actorId:ctx.actorId,kind:'operator',workspaceId:ctx.workspaceId}).retentionDays).toBe(30);
  await page.locator('[data-settings-action=delete]').click();await page.waitForFunction(()=>document.querySelector('.cr-review-list')?.textContent?.includes('No saved reviews.'));
  expect(service.listReviews({ownerId:ctx.ownerId,actorId:ctx.actorId,kind:'operator',workspaceId:ctx.workspaceId})).toHaveLength(0);expect(errors).toEqual([]);
 }finally{await browser?.close();server?.stop(true);service.close();rmSync(root,{recursive:true,force:true});}
},45000);

import { afterAll, expect, test } from 'bun:test';
import { readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { settingsBrowserEnabled, settingsPaneFixture } from './scripts/lib/settings-pane-browser.js';

export const panes = ['cheapskate','delegate','goal','imap','linkr','observability','portainer','proxmox','remote-peer','sample-addon','telegram','vent','whatsapp'];
const textControls='input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]):not([type="file"]):not([type="range"]):not([type="color"]),textarea,select';
const browserTest=settingsBrowserEnabled?test:test.skip;
const fixtures=new Map<string,Awaited<ReturnType<typeof settingsPaneFixture>>>();
afterAll(async()=>{for(const fixture of fixtures.values())await fixture.close();},30000);

test('every registered first-party Settings pane is in the input audit',()=>{
 const discovered=readdirSync(join(import.meta.dir,'addons')).filter(slug=>{
  const p=join(import.meta.dir,'addons',slug,'web/index.ts');return existsSync(p)&&readFileSync(p,'utf8').includes('registerSettingsPane');
 }).sort();
 expect(discovered).toEqual([...panes].sort());
});

test('new package-local styling imports use exact browser asset filenames',()=>{
 for(const slug of panes){
  const p=join(import.meta.dir,'addons',slug,'web');
  const source=readFileSync(join(p,'index.ts'),'utf8');
  for(const match of source.matchAll(/from ["'](\.\/[^"']+)["']/g))expect(existsSync(join(p,match[1]))).toBe(true);
 }
});

browserTest('Linkr is reachable from General via a visible named Classic phone navigation button',async()=>{
 const f=await open('linkr','classic',390);try{
  await f.page.evaluate(()=>window.dispatchEvent(new CustomEvent('piclaw:open-settings',{detail:{section:'general'}})));
  await f.page.locator('.settings-content input[type=text]').first().waitFor();
  const nav=f.page.locator('.settings-nav').getByRole('button',{name:/Linkr/});
  await nav.scrollIntoViewIfNeeded();expect(await nav.isVisible()).toBe(true);
  expect(await nav.locator('svg[aria-label="Linkr"]').isVisible()).toBe(true);
  await nav.click();await f.page.getByLabel('HTTP(S) origin',{exact:true}).waitFor();
  expect(f.requests).toEqual([]);expect(f.errors).toEqual([]);
 }finally{await f.page.close();}
},15000);

function dataFor(slug:string):any {
 switch(slug){
 case 'cheapskate':return {ok:true,config:{enabled:false,providers:{},models:{},priority:[]},candidates:[{ref:'fixture/free-model',provider:'fixture',provider_name:'Fixture',name:'Free fixture',model_enabled:false,configured:true,in_scope:true,state:'eligible',health:{state:'healthy'},inputs:['text']}],excluded_costs:{positive:0,unknown_or_malformed:0,recursive:0}};
 case 'delegate':return {config:{searchable_providers:[],excluded_providers:['fixture'],excluded_models:[]},providers:[{provider:'fixture',modelCount:1}],candidates:[]};
 case 'goal':return {goal:{objective:'Fixture',tokenBudget:1000,status:'paused',tokensUsed:0},remainingTokens:1000};
 case 'imap':return {accounts:[],defaultAccount:''};
 case 'linkr':return {profiles:[{id:'device',label:'Fixture device',origin:'https://device.invalid',targetIdentity:'Fixture computer',tokenKeychain:'linkr/test-key',inputEnabled:false}]};
 case 'remote-peer':return {config:{enabled:false,instanceName:'Fixture',relays:[],relayMode:'disabled'},identity:{clientId:'PCL1-fixture'},transport:{active:false},discovery:{active:false},candidates:[],peers:[],advertised:[],messages:[],work:[],localAgents:[]};
 case 'sample-addon':return {enabled:false,greeting:'Fixture greeting',secret_keychain:'sample-addon/api-key'};
 case 'observability':return {enabled:false,instance_name:'Fixture',connection_string_keychain:'azure/appinsights-connection-string',sample_rate:1,graphite_host:'graphite.invalid',graphite_port:2003,graphite_interval_seconds:60,graphite_instance:'fixture'};
 case 'portainer':return {host:'portainer.invalid',api_token_keychain:'portainer/test',allow_insecure_tls:false};
 case 'proxmox':return {host:'proxmox.invalid',username:'root@pam',api_token_keychain:'proxmox/test',allow_insecure_tls:false};
 case 'telegram':return {enabled:false,botTokenConfigured:false,pollingTimeout:30};
 case 'whatsapp':return {enabled:false,phoneNumber:'123456789'};
 case 'vent':return {output_path:'VENT.md'};
 }
}
async function open(slug:string,skin:string,width:number,theme:'light'|'dark'='light'){
 if(!fixtures.has(slug)){
  for(const f of fixtures.values())await f.close();fixtures.clear();
  fixtures.set(slug,await settingsPaneFixture(join(import.meta.dir,`addons/${slug}/web/index.ts`),{realHost:true}));
 }
 const f=await fixtures.get(slug)!.page(skin,width,theme);const requests:any[]=[];let data=dataFor(slug);
 await f.page.route('**/agent/**',async(route:any)=>{
  const url=new URL(route.request().url()),post=route.request().method()==='POST';const body=post?route.request().postDataJSON():null;
  if(url.pathname==='/agent/client-perf')return route.fulfill({json:{ok:true}});
  if(post)requests.push({path:url.pathname,body});
  if(url.pathname==='/agent/keychain')return route.fulfill({json:{ok:true,entries:[]}});
  if(url.pathname==='/agent/settings-data')return route.fulfill({json:{}});
  if(!url.pathname.startsWith(`/agent/addons/api/${slug}/`))throw Error('Unexpected fixture API '+url.pathname);
  if(slug==='sample-addon') {if(post)data={...data,...body};return route.fulfill({json:{ok:true,config:data}});}
  if(slug==='delegate')return route.fulfill({json:data});
  if(slug==='goal'){if(post)data={...data,goal:{...data.goal,...body}};return route.fulfill({json:data});}
  if(post)data={...data,...body};
  return route.fulfill({json:post?{ok:true,config:data}:data});
 });
 await f.page.goto(f.url);
 const content=f.page.locator(skin==='legacy'?'#app':'.settings-addon-pane');
 await content.locator(textControls).first().waitFor();
 if(slug==='remote-peer')await content.getByText('Optional endpoint ticket',{exact:true}).click();
 return {...f,content,requests};
}
for(const slug of panes)for(const skin of ['classic','visual','legacy'])for(const width of [1366,820,520,390])for(const theme of ['light','dark'] as const){
 browserTest(`${slug} ${skin}/${width}/${theme}: all text controls match core shape and remain labelled/bounded`,async()=>{
  const f=await open(slug,skin,width,theme);try{
   const measurements=await f.content.locator(textControls).evaluateAll((nodes:HTMLElement[])=>nodes.filter(el=>el.getBoundingClientRect().height>0).map(el=>{
    const s=getComputedStyle(el),r=el.getBoundingClientRect();const root=el.closest('.settings-addon-pane')||document.getElementById('app')!;const rr=root.getBoundingClientRect();
    const input=el as HTMLInputElement;
    return {tag:el.tagName,type:input.type,classes:el.className,name:el.getAttribute('aria-label')||(input.labels?Array.from(input.labels).map(l=>l.textContent).join('').trim():''),padding:s.padding,radius:s.borderRadius,border:s.borderTopWidth,fontSize:s.fontSize,box:s.boxSizing,background:s.backgroundColor,color:s.color,within:r.right<=rr.right+1&&r.left>=rr.left-1};
   }));
   expect(measurements.length).toBeGreaterThan(0);
   for(const m of measurements){
    expect(m.classes,JSON.stringify(m)).toContain('settings-addon-control');
    expect(m.name,JSON.stringify(m)).toBeTruthy();
    expect(m.radius,JSON.stringify(m)).toBe(skin==='visual'?'3px':skin==='legacy'&&slug==='sample-addon'?'4px':'6px');
    expect(m.padding,JSON.stringify(m)).toBe(skin==='visual'?'5px 10px':skin==='legacy'&&slug==='sample-addon'?'4px 8px':'6px 10px');
    expect(m.border).toBe('1px');expect(m.box).toBe('border-box');expect(m.within,JSON.stringify(m)).toBe(true);
   }
   expect(await f.content.evaluate((el:HTMLElement)=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
   const out=process.env.PICLAW_SETTINGS_AUDIT_SCREENSHOTS;
   if(out&&slug==='proxmox'&&skin!=='legacy'&&theme==='light'&&width===390){
    if(!isAbsolute(out))throw Error('Explicit absolute screenshot directory required');mkdirSync(out,{recursive:true});
    await f.content.screenshot({path:join(out,`${slug}-${skin}-${width}.png`)});
   }
   if(skin!=='legacy'){
    // Compare against an unmodified core General input in this actual Settings host.
    await f.page.evaluate(()=>window.dispatchEvent(new CustomEvent('piclaw:open-settings',{detail:{section:'general'}})));
    const ref=f.page.locator(skin==='classic'?'.settings-content input[type=text]':'.settings-panel__content input[type=text]').first();
    await ref.waitFor();
    const reference=await ref.evaluate((el:HTMLElement)=>{const s=getComputedStyle(el);return {padding:s.padding,radius:s.borderRadius,border:s.borderTopWidth,fontSize:s.fontSize,background:s.backgroundColor,color:s.color};});
    for(const m of measurements){expect(m.padding).toBe(reference.padding);expect(m.radius).toBe(reference.radius);expect(m.border).toBe(reference.border);expect(m.fontSize,JSON.stringify(m)).toBe(reference.fontSize);expect(m.background).toBe(reference.background);expect(m.color).toBe(reference.color);}
   }
   expect(f.requests).toEqual([]); // Rendering/field inspection must not save or enable anything.
   expect(f.errors).toEqual([]);
  }finally{await f.page.close();}
 },15000);
}

for(const slug of ['portainer','proxmox','observability','vent'])browserTest(`${slug} blur-save still sends only the configured non-secret field`,async()=>{
 const f=await open(slug,'classic',820);try{
  const label=slug==='vent'?'Output file':slug==='observability'?'Instance name':'Host / IP';
  const key=slug==='vent'?'output_path':slug==='observability'?'instance_name':'host';
  const value=slug==='vent'?'fixture.md':'fixture-new';
  const field=f.content.getByLabel(label,{exact:true});await field.fill(value);await field.press('Enter');
  await f.page.waitForTimeout(150);
  expect(f.requests).toEqual([{path:`/agent/addons/api/${slug}/config`,body:{[key]:value}}]);
  expect(f.errors).toEqual([]);
 }finally{await f.page.close();}
});

for(const slug of ['telegram','whatsapp','linkr','goal','imap'])browserTest(`${slug} explicit save and confirmation boundaries stay unchanged`,async()=>{
 const f=await open(slug,'classic',820);try{
  if(slug==='telegram'){
   await f.content.getByLabel('Bot Token',{exact:true}).fill('fixture-token');
   await f.content.getByLabel('Poll Timeout',{exact:true}).fill('40');
   await f.content.getByRole('button',{name:'Save',exact:true}).click();
   await f.page.waitForTimeout(150);
   expect(f.requests.map(r=>r.path)).toEqual(['/agent/keychain','/agent/addons/api/telegram/config']);
   expect(f.requests[1].body).toEqual({enabled:false,pollingTimeout:40});
   expect(await f.content.getByLabel('Bot Token',{exact:true}).inputValue()).toBe('');
  }else if(slug==='whatsapp'){
   await f.content.getByLabel('Phone',{exact:true}).fill('987654321');
   await f.content.getByRole('button',{name:'Save',exact:true}).click();await f.page.waitForTimeout(150);
   expect(f.requests).toEqual([{path:'/agent/addons/api/whatsapp/config',body:{phone:'987654321',enabled:false}}]);
  }else if(slug==='linkr'){
   await f.content.getByLabel('Label',{exact:true}).fill('Changed fixture');
   f.page.once('dialog',(dialog:any)=>dialog.dismiss());
   await f.content.getByRole('button',{name:'Save',exact:true}).click();expect(f.requests).toEqual([]);
   f.page.once('dialog',(dialog:any)=>dialog.accept());
   await f.content.getByRole('button',{name:'Save',exact:true}).click();await f.page.waitForTimeout(150);
   expect(f.requests[0].body.profiles[0]).toEqual({...dataFor('linkr').profiles[0],label:'Changed fixture'});
  }else if(slug==='goal'){
   await f.content.getByLabel('Objective',{exact:true}).fill('Fixture only');await f.content.getByLabel('Token budget',{exact:true}).fill('2000');
   await f.content.getByRole('button',{name:'Save / Replace + Run'}).click();await f.page.waitForTimeout(150);
   expect(f.requests[0]).toEqual({path:'/agent/addons/api/goal/goal',body:{objective:'Fixture only',token_budget:2000,chat_jid:'web:default'}});
  }else if(slug==='imap'){
   await f.content.getByLabel('Name',{exact:true}).fill('test');await f.content.getByLabel('Host',{exact:true}).fill('imap.invalid');await f.content.getByLabel('Username',{exact:true}).fill('fixture');
   await f.content.getByLabel('Password',{exact:true}).fill('fixture-imap-secret');await f.content.getByRole('button',{name:'Save account'}).click();await f.page.waitForTimeout(150);
   expect(f.requests[0].path).toBe('/agent/keychain');expect(f.requests[0].body.secret).toBe('fixture-imap-secret');
   const config=f.requests.find(r=>r.path.endsWith('/accounts'));expect(config).toBeTruthy();expect(JSON.stringify(config.body)).not.toContain('fixture-imap-secret');
  }
  expect(f.errors).toEqual([]);
 }finally{await f.page.close();}
});
for(const slug of ['portainer','proxmox','observability'])browserTest(`${slug} password still saves via keychain only and clears`,async()=>{
 const f=await open(slug,'classic',820);try{
  const password=f.content.locator('input[type=password]');await password.fill('fixture-only-secret');await password.press('Enter');
  await f.page.waitForTimeout(150);
  const key=f.requests.find(r=>r.path==='/agent/keychain');expect(key?.body.secret).toBe('fixture-only-secret');
  for(const r of f.requests.filter(r=>r.path!=='/agent/keychain'))expect(JSON.stringify(r.body)).not.toContain('fixture-only-secret');
  expect(await password.inputValue()).toBe('');expect(f.errors).toEqual([]);
 }finally{await f.page.close();}
});

for(const slug of panes)for(const skin of ['classic','visual'])browserTest(`${slug} ${skin}: text focus/disabled/readonly/invalid states follow host without writes`,async()=>{
 const f=await open(slug,skin,820);try{
  const field=f.content.locator('input.settings-addon-control:not([type=checkbox]):not([type=radio]),textarea.settings-addon-control').first();
  await field.waitFor();
  await field.focus();
  expect(await field.evaluate((el:HTMLElement)=>{const s=getComputedStyle(el);return s.outlineStyle!=='none'&&parseFloat(s.outlineWidth)>0;})).toBe(true);
  const value=await field.inputValue();
  await field.evaluate((el:HTMLInputElement)=>{el.readOnly=true;});
  expect(await field.evaluate((el:HTMLInputElement)=>el.readOnly)).toBe(true);
  expect(await field.inputValue()).toBe(value);
  await field.evaluate((el:HTMLInputElement)=>{el.disabled=true;});
  expect(await field.isDisabled()).toBe(true);
  expect(await field.evaluate((el:HTMLElement)=>Number(getComputedStyle(el).opacity))).toBe(.5);
  await field.evaluate((el:HTMLInputElement)=>{el.disabled=false;el.readOnly=false;el.setAttribute('aria-invalid','true');});
  expect(await field.evaluate((el:HTMLElement)=>{const probe=document.createElement('i');probe.style.color='var(--danger-color)';el.parentElement!.append(probe);const expected=getComputedStyle(probe).color;probe.remove();return getComputedStyle(el).borderTopColor===expected;})).toBe(true);
  expect(f.requests).toEqual([]);expect(f.errors).toEqual([]);
 }finally{await f.page.close();}
});

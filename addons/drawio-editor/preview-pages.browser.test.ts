import { afterAll, beforeAll, expect, test } from 'bun:test';
import { deflateRawSync } from 'node:zlib';
import { mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { handleRoute } from './index';
import { buildReadonlyAttachmentUrl } from './web/index';

const enabled=process.env.PICLAW_E2E_DISPOSABLE==='1'&&!!process.env.PICLAW_DRAWIO_CORE_SOURCE;
const browserTest=enabled?test:test.skip;
let browser:any,server:ReturnType<typeof Bun.serve>;
let writes=0;
const names=['Overview','Second <script> & detail','Third page'];
function model(label:string){return `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="node" value="${label}" vertex="1" parent="1" style="rounded=1;whiteSpace=wrap;html=1;"><mxGeometry x="40" y="40" width="180" height="80" as="geometry"/></mxCell></root></mxGraphModel>`;}
const labels=['FIRST-PAGE','SECOND-PAGE','THIRD-PAGE'];
function mxfile(compressed=false,single=false){return `<mxfile host="app.diagrams.net">${names.slice(0,single?1:3).map((name,i)=>`<diagram id="p${i}" name="${name.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')}">${compressed?deflateRawSync(Buffer.from(encodeURIComponent(model(labels[i])))).toString('base64'):model(labels[i])}</diagram>`).join('')}</mxfile>`;}
function embeddedSvg(){const content=mxfile().replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" content="${content}"><rect width="200" height="100" fill="white"/></svg>`;}
function crc32(bytes:Buffer){let c=0xffffffff;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function embeddedPng(){const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6zX8AAAAASUVORK5CYII=','base64');const data=Buffer.from('mxfile\0'+encodeURIComponent(mxfile(true)));const type=Buffer.from('tEXt');const length=Buffer.alloc(4);length.writeUInt32BE(data.length);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([type,data])));return Buffer.concat([png.subarray(0,33),length,type,data,crc,png.subarray(33)]);}
beforeAll(async()=>{
 if(!enabled)return;const core=process.env.PICLAW_DRAWIO_CORE_SOURCE!;if(!core.startsWith('/'))throw Error('Explicit absolute companion core required');
 const {chromium}=await import(join(core,'node_modules/playwright/index.mjs'));browser=await chromium.launch({headless:true});
 server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
  const u=new URL(req.url);
  if(u.pathname==='/drawio/save'){writes++;return Response.json({ok:true});}
  if(u.pathname==='/media/1')return new Response(mxfile());
  if(u.pathname==='/media/2')return new Response(mxfile(true));
  if(u.pathname==='/media/3')return new Response(embeddedSvg(),{headers:{'Content-Type':'image/svg+xml'}});
  if(u.pathname==='/media/4')return new Response(embeddedPng(),{headers:{'Content-Type':'image/png'}});
  if(u.pathname==='/media/5')return new Response(mxfile(false,true));
  if(u.pathname==='/workspace/raw')return new Response(mxfile());
  return await handleRoute(req,u.pathname)||new Response('not found',{status:404});
 }});
},30000);
afterAll(async()=>{await browser?.close();server?.stop(true);});
async function open(id:number,name:string,width=1100,readonly=true){
 const page=await browser.newPage({viewport:{width,height:800}});page.setDefaultTimeout(12000);
 await page.route('**/*',(route:any)=>new URL(route.request().url()).origin===server.url.origin?route.continue():route.abort());
 await page.goto(new URL(readonly?buildReadonlyAttachmentUrl(id,name):'/drawio/edit.html?path=fixture.drawio',server.url).href);
 await page.locator('#loading.hidden').waitFor({state:'attached'});
 const graph=page.frameLocator('#editor-frame').locator('.geDiagramContainer');await graph.getByText(labels[0],{exact:true}).waitFor();
 return {page,graph};
}
for(const [id,name] of [[1,'multi.drawio'],[2,'compressed.drawio'],[3,'embedded.drawio.svg'],[4,'embedded.drawio.png']] as const)for(const width of [1100,390]){
 browserTest(`read-only ${name} navigates every page at ${width}px without writes`,async()=>{
  writes=0;const{page,graph}=await open(id,name,width);try{
   const tabs=page.getByRole('tab');expect(await tabs.count()).toBe(3);
   expect(await tabs.nth(1).textContent()).toBe(names[1]);expect(await page.locator('#preview-pages script').count()).toBe(0);
   await tabs.nth(1).click();await graph.getByText(labels[1],{exact:true}).waitFor();expect(await tabs.nth(1).getAttribute('aria-selected')).toBe('true');
   await tabs.nth(1).focus();await page.keyboard.press('End');await graph.getByText(labels[2],{exact:true}).waitFor();
   await page.keyboard.press('Home');await graph.getByText(labels[0],{exact:true}).waitFor();
   await page.keyboard.press('ArrowRight');await graph.getByText(labels[1],{exact:true}).waitFor();
   await page.keyboard.press('Home');await graph.getByText(labels[0],{exact:true}).waitFor();
   await page.keyboard.press('ArrowLeft');await graph.getByText(labels[2],{exact:true}).waitFor();
   expect(await page.locator('#readonly-lock').evaluate((e:HTMLElement)=>getComputedStyle(e).display)).toBe('block');
   // Even direct calls through the wrapper cannot save in read-only mode.
   expect(await page.evaluate(async()=>{try{await (window as any).saveWorkspace({xml:'changed'},true);return false;}catch{return true;}})).toBe(true);
   const inner=await(await page.locator('#editor-frame').elementHandle()).contentFrame();
   await inner.evaluate(()=>{for(const event of ['save','autosave','export','workspace-export'])parent.postMessage(JSON.stringify({event,xml:'tampered',data:'tampered'}),location.origin);});
   await page.waitForTimeout(80);expect(writes).toBe(0);
   expect(await page.locator('#preview-pages').evaluate((el:HTMLElement)=>el.getBoundingClientRect().right<=innerWidth+1)).toBe(true);
   const evidence=process.env.PICLAW_DRAWIO_SCREENSHOT_DIR;
   if(evidence&&id===1){if(!isAbsolute(evidence))throw Error('Explicit absolute screenshot directory required');mkdirSync(evidence,{recursive:true});await page.screenshot({path:join(evidence,`drawio-preview-pages-${width}.png`)});}
  }finally{await page.close();}
 },30000);
}
browserTest('single-page preview hides unnecessary navigation',async()=>{writes=0;const{page}=await open(5,'single.drawio');try{expect(await page.locator('#preview-pages').isVisible()).toBe(false);expect(writes).toBe(0);}finally{await page.close();}},30000);
browserTest('editable workspace editor remains interactive and persists normal save messages',async()=>{writes=0;const{page}=await open(1,'fixture.drawio',1100,false);try{
 expect(await page.locator('#preview-pages').isVisible()).toBe(false);expect(await page.locator('#readonly-lock').isVisible()).toBe(false);
 const inner=await(await page.locator('#editor-frame').elementHandle()).contentFrame();
 await inner.evaluate(()=>parent.postMessage(JSON.stringify({event:'save',xml:'<mxfile/>'}),location.origin));
 await page.waitForTimeout(150);expect(writes).toBe(1);
}finally{await page.close();}},30000);

// design_render: the Claude Design loop inside Nimbus. The model writes a visual
// (HTML, CSS and inline SVG), Nimbus renders it in an offline headless Chromium,
// and the PNG comes back to the model as an image so it can check and revise it.
// A second mode draws markup (circles, boxes, arrows, labels) over a local photo
// in the photo's own pixel coordinates, for service-manual style annotation.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {inspectImage} from './workbench.js';

const MAX_HTML=2*1024*1024, MAX_SIDE=4096;
let browserPromise=null;
async function browser(){
  if(!browserPromise)browserPromise=chromium.launch({headless:true}).catch(e=>{browserPromise=null;throw new Error('Design renderer could not start Chromium: '+e.message+'. Run npm run browser:install.');});
  return browserPromise;
}
export async function closeDesignBrowser(){const b=browserPromise;browserPromise=null;if(b)await (await b).close().catch(()=>{});}

const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const num=(v,d=0)=>Number.isFinite(Number(v))?Number(v):d;
const COLORS=/^(#[0-9a-f]{3,8}|[a-z]{3,20}|rgba?\([\d\s.,%]+\))$/i;
const color=c=>COLORS.test(String(c||''))?String(c):'#0a66ff';

// Markup over a photo. Coordinates are in the photo's pixels; the page is sized to the photo.
export function annotationHtml(imageUrl,width,height,marks){
  const shapes=[];
  for(const m of marks||[]){
    const c=color(m.color),sw=Math.max(1,num(m.strokeWidth,Math.max(3,Math.round(Math.min(width,height)/150))));
    if(m.type==='circle')shapes.push(`<ellipse cx="${num(m.x)}" cy="${num(m.y)}" rx="${num(m.rx??m.r,40)}" ry="${num(m.ry??m.r,40)}" fill="none" stroke="${c}" stroke-width="${sw}"/>`);
    else if(m.type==='box')shapes.push(`<rect x="${num(m.x)}" y="${num(m.y)}" width="${num(m.w,80)}" height="${num(m.h,60)}" rx="${num(m.radius,6)}" fill="none" stroke="${c}" stroke-width="${sw}"/>`);
    else if(m.type==='arrow')shapes.push(`<line x1="${num(m.x)}" y1="${num(m.y)}" x2="${num(m.x2)}" y2="${num(m.y2)}" stroke="${c}" stroke-width="${sw}" marker-end="url(#head-${shapes.length})"/><defs><marker id="head-${shapes.length}" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="${c}"/></marker></defs>`);
    else if(m.type==='label'){
      const size=num(m.fontSize,Math.max(16,Math.round(Math.min(width,height)/28)));
      shapes.push(`<text x="${num(m.x)}" y="${num(m.y)}" font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="${size}" fill="${c}" stroke="#fff" stroke-width="${Math.max(2,size/6)}" paint-order="stroke">${esc(m.text)}</text>`);
    }else throw new Error('Unknown mark type '+m.type+'; use circle, box, arrow or label');
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff}.wrap{position:relative;width:${width}px;height:${height}px}img,svg{position:absolute;left:0;top:0;width:${width}px;height:${height}px}</style></head><body><div class="wrap"><img src="${esc(imageUrl)}"><svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${shapes.join('')}</svg></div></body></html>`;
}

function imageSize(file){
  const b=fs.readFileSync(file);
  if(b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {width:b.readUInt32BE(16),height:b.readUInt32BE(20)};
  if(b[0]===0xff&&b[1]===0xd8){let i=2;while(i<b.length){if(b[i]!==0xff){i++;continue;}const m=b[i+1];if(m>=0xc0&&m<=0xcf&&![0xc4,0xc8,0xcc].includes(m))return {height:b.readUInt16BE(i+5),width:b.readUInt16BE(i+7)};i+=2+b.readUInt16BE(i+2);}}
  throw new Error('Base image must be PNG or JPEG');
}

/** Render a design. resolve(p) maps a worker path to an absolute path; outDir is where results go. */
export async function designRender(args,{resolve,outDir,signal}){
  const format=['png','jpeg','pdf'].includes(args.format)?args.format:'png';
  let html=args.html,existing=null,width=Math.round(num(args.width,1200)),height=Math.round(num(args.height,0)),fullPage=args.fullPage!==false;
  if(args.file){
    existing=resolve(args.file);
    if(!/.(html?|svg)$/i.test(existing)||!fs.existsSync(existing))throw new Error('file must be an existing .html, .htm or .svg file');
    html=null;
  }else if(args.baseImage){
    const img=resolve(args.baseImage);if(!fs.existsSync(img))throw new Error('Base image not found: '+args.baseImage);
    const size=imageSize(img);width=size.width;height=size.height;fullPage=false;
    if(!Array.isArray(args.marks)||!args.marks.length)throw new Error('baseImage needs at least one mark');
    html=annotationHtml(pathToFileURL(img).href,width,height,args.marks);
  }else if(typeof args.svg==='string'&&args.svg.trim()&&!html){
    html=`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:${args.background?esc(args.background):'#fff'}}svg{display:block}</style></head><body>${args.svg}</body></html>`;
  }
  if(!existing&&(typeof html!=='string'||!html.trim()))throw new Error('Give html, svg, or baseImage with marks');
  if(html&&Buffer.byteLength(html)>MAX_HTML)throw new Error('Design source exceeds 2 MiB');
  if(width<16||width>MAX_SIDE||height<0||height>MAX_SIDE)throw new Error('width and height must be between 16 and 4096 pixels');
  const scale=Math.min(3,Math.max(1,num(args.scale,args.baseImage?1:2)));
  fs.mkdirSync(outDir,{recursive:true});
  const base=(String(args.name||'design').replace(/[^\w.-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60)||'design')+'-'+randomUUID().slice(0,8);
  const source=existing||path.join(outDir,base+'.html');if(!existing)fs.writeFileSync(source,html);
  const context=await (await browser()).newContext({viewport:{width,height:height||800},deviceScaleFactor:format==='pdf'?1:scale,javaScriptEnabled:args.javascript===true,offline:true});
  const blocked=[],consoleErrors=[];
  try{
    // Offline: local files and inline data only. Nothing leaves the machine.
    await context.route('**/*',route=>{const u=route.request().url();if(/^(file|data|blob|about):/i.test(u))return route.continue();blocked.push(u.slice(0,200));return route.abort();});
    const page=await context.newPage();
    page.on('console',m=>{if(m.type()==='error'&&consoleErrors.length<20)consoleErrors.push(m.text().slice(0,300));});
    page.on('pageerror',e=>{if(consoleErrors.length<20)consoleErrors.push(String(e.message).slice(0,300));});
    signal?.addEventListener('abort',()=>context.close().catch(()=>{}),{once:true});
    await page.goto(pathToFileURL(source).href,{waitUntil:'load',timeout:30000});
    await page.evaluate(()=>document.fonts?.ready).catch(()=>{});
    const out=path.join(outDir,base+'.'+(format==='jpeg'?'jpg':format));
    if(format==='pdf'){
      await page.pdf({path:out,printBackground:true,...(args.pageSize?{format:String(args.pageSize)}:{width:width+'px',...(height?{height:height+'px'}:{})})});
      const preview=path.join(outDir,base+'-preview.png');
      await page.screenshot({path:preview,fullPage:true});
      const seen=inspectImage(preview);
      return {path:out,format,source,preview,blockedRequests:blocked,consoleErrors,...seen,note:'PDF written; the image is a preview of the page so you can check it.'};
    }
    await page.screenshot({path:out,type:format,fullPage:fullPage&&!height,...(format==='jpeg'?{quality:Math.min(100,Math.max(40,num(args.quality,90)))}:{})});
    const seen=inspectImage(out);
    return {path:out,format,source,width,height:height||undefined,scale,blockedRequests:blocked,consoleErrors,...seen,note:'Look at the returned image. Revise the source and render again until it is right.'};
  }finally{await context.close().catch(()=>{});}
}

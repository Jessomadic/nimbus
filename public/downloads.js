// Adapted from upstream 0e30d7d. No Android bridge.
export function downloadFilename(header,fallback='download'){
  const match=/filename\*=UTF-8''([^;]+)/i.exec(header||'');
  try{return match?decodeURIComponent(match[1]):fallback;}catch{return fallback;}
}
export async function download(url,fallback,{fetch:request=globalThis.fetch,document:doc=globalThis.document,URL:urls=globalThis.URL,location:loc=globalThis.location,report=()=>{},later=globalThis.setTimeout}={}){
  try{
    const target=new urls(url,loc.href);
    if(target.origin!==loc.origin)throw new Error('Only same-origin downloads are supported');
    const res=await request(target.href,{credentials:'same-origin',redirect:'error'});
    if(res.status===401){loc.href='/login';return;}
    if(!res.ok)throw new Error((await res.json().catch(()=>({}))).error||'Download failed ('+res.status+')');
    const name=downloadFilename(res.headers.get('content-disposition'),fallback||'download'),objectURL=urls.createObjectURL(await res.blob());
    const a=Object.assign(doc.createElement('a'),{href:objectURL,download:name});
    try{doc.body.append(a);a.click();}finally{a.remove();later(()=>urls.revokeObjectURL(objectURL),60000);}
  }catch(error){report(error.message);}
}
export function installDownloads({document:doc=globalThis.document,report}={}){
  doc.addEventListener('click',event=>{
    const a=event.target.closest?.('a[download]');
    if(!a||a.href.startsWith('blob:'))return;
    event.preventDefault();event.stopImmediatePropagation();
    void download(a.href,a.getAttribute('download')||undefined,{report});
  });
}

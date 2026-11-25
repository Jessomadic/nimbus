import {redact} from '../redact.js';

const parse=value=>{try{return JSON.parse(value);}catch{return null;}};
// Read results are host journal observations, already redacted before storage.
// Raw-byte metadata must agree before a redacted value or page can count. This
// does not replace successful checks, immutable bindings or output captures.
export function inspectCurrentReadback({rows,lastCheck,output,content,sha256,bytes}){
 const status=(covered,complete=content.length>0&&covered===content.length)=>({
  complete,
  coveredCharacters:covered,totalCharacters:content.length,
  nextRead:covered<content.length?{path:output,offset:covered,limit:4000,expectedSha256:sha256}:null
 });
 const ranges=[];
 for(let index=lastCheck+1;index<rows.length;index++){
  const row=rows[index],args=parse(row.args),result=parse(row.result);
  if(row.name!=='read_file'||row.state!=='done'||args?.path!==output||!result||result.error||result.truncated||typeof result.content!=='string')continue;
  const paged=Object.hasOwn(args,'offset')||Object.hasOwn(args,'limit');
  if(!paged){
   if(Object.hasOwn(result,'offset')||Object.hasOwn(result,'totalCharacters')||result.hasMore||result.nextOffset!=null)continue;
   // Retain exact-content evidence from legacy journals without invented hashes.
   if(result.sha256===undefined&&result.bytes===undefined){if(result.content===content)return status(content.length,true);continue;}
   if(result.sha256===sha256&&result.bytes===bytes&&result.content===redact(content)&&
      (args.expectedSha256===undefined||String(args.expectedSha256).toLowerCase()===sha256))return status(content.length,true);
   continue;
  }
  if(result.sha256!==sha256||result.bytes!==bytes||result.totalCharacters!==content.length||
     (args.expectedSha256!==undefined&&String(args.expectedSha256).toLowerCase()!==sha256))continue;
  const start=args.offset??0,limit=args.limit??4000,end=result.nextOffset===null?content.length:result.nextOffset;
  if(!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(limit)||limit<2||limit>4000||
     result.offset!==start||!Number.isSafeInteger(end)||end<=start||end>content.length||end-start>limit||
     result.hasMore!==(end<content.length)||result.content!==redact(content.slice(start,end)))continue;
  ranges.push([start,end]);
 }
 // A page alone is not a read of the entire output. Every character of the
 // same current version must be covered after all required checks succeeded.
 ranges.sort((a,b)=>a[0]-b[0]);let covered=0;
 for(const [start,end] of ranges){if(start>covered)break;covered=Math.max(covered,end);}
 return status(covered);
}

// Preserve the existing boolean API and all evidence-validation requirements.
export function hasCurrentReadback(input){return inspectCurrentReadback(input).complete;}

// Reject malformed or oversized findings atomically; receipt data never grants authority.
export function implementationFindings(value) {
 if(!Array.isArray(value)||!value.length||value.length>20)return null;
 const findings=value.map(item=>{
  if(typeof item==='string')return item.trim();
  if(!item||typeof item!=='object'||Array.isArray(item))return '';
  if('code' in item){
   if(Object.keys(item).length!==2||!Object.hasOwn(item,'detail')||
      typeof item.code!=='string'||!/^[A-Z][A-Z0-9_]{0,79}$/.test(item.code)||
      typeof item.detail!=='string'||!item.detail.trim()||item.detail.length>4000)return '';
   return `${item.code}: ${item.detail.trim()}`;
  }
  if('severity' in item||'description' in item){
   const keys=Object.keys(item);
   if(keys.length!==2||keys.some(k=>!['severity','description'].includes(k))||item.severity!=='blocking'||
      typeof item.description!=='string'||!item.description.trim()||item.description.length>4000)return '';
   // Severity classifies the defect; its text shares the string-finding loop fingerprint.
   return item.description.trim();
  }
  if(!('detail' in item)){
   const keys=['title','steps','expected','actual'];
   if(Object.keys(item).some(k=>!keys.includes(k))||!keys.every(k=>typeof item[k]==='string'&&item[k].trim()&&item[k].length<=4000))return '';
   return `${item.title.trim()}:\nSteps: ${item.steps.trim()}\nExpected: ${item.expected.trim()}\nActual: ${item.actual.trim()}`;
  }
  if(typeof item.detail!=='string'||!item.detail.trim())return '';
  const label=typeof item.file==='string'&&item.file.trim()?item.file.trim():typeof item.title==='string'?item.title.trim():'';
  return label?`${label}: ${item.detail.trim()}`:'';
 });
 return findings.every(s=>s&&s.length<=4000)?findings:null;
}

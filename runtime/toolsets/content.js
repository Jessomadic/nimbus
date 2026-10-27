import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { inspectImage } from '../workbench.js';
import { config } from '../config.js';

const text = { type: 'string' }, integer = { type: 'integer' }, bool = { type: 'boolean' };
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const spec = (name, description, properties, required = []) => ({ type: 'function', function: { name, description, parameters: schema(properties, required) } });
const strings = { type: 'array', items: text };
const types = { type: 'object', additionalProperties: { type: 'string', enum: ['string', 'number', 'integer', 'boolean', 'date'] } };
const sourceProps = { path: text, format: { type: 'string', enum: ['csv', 'tsv', 'json', 'jsonl'] }, types };
const outputProps = { output: text, overwrite: bool };
const rowsSpec = { type: 'array', maxItems: 1000, items: { type: 'object', additionalProperties: true } };
export const tools = [
  spec('dataset_profile', 'Profile a local CSV/TSV/JSON/JSONL dataset: grain, columns, missing values, duplicates, observed types and bounded numeric summaries. CSV values stay strings unless types explicitly declares conversion. Malformed rows and invalid conversions are reported, not silently dropped. Maximum 8 MiB / 100,000 rows.', sourceProps, ['path']),
  spec('dataset_query', 'Query a local dataset without executable code. Filter, select, group and aggregate declared numeric columns, sort and limit output. CSV numeric comparisons require types. Returns source hash, matched count and bounded rows.', { ...sourceProps, limit:{...integer,minimum:1,maximum:1000}, select: strings, filters: { type: 'array', maxItems: 20, items: schema({ column: text, op: { type: 'string', enum: ['eq','ne','gt','gte','lt','lte','contains','is_missing','not_missing'] }, value: {} }, ['column','op']) }, groupBy: strings, aggregates: { type: 'array', maxItems: 20, items: schema({ name: text, column: text, op: { type: 'string', enum: ['count','sum','mean','min','max'] } }, ['name','op']) }, sort: { type: 'array', maxItems: 10, items: schema({ column: text, descending: bool }, ['column']) } }, ['path']),
  spec('dataset_validate', 'Validate required columns, nonempty cells, unique compound keys, declared types, allowed values and numeric bounds. Reports counts and row-numbered failures with capped samples; never edits the source.', { ...sourceProps, requiredColumns: strings, notNull: strings, uniqueBy: strings, rules: { type: 'array', maxItems: 30, items: schema({ column: text, allowed: { type:'array', maxItems:100, items:{} }, minimum:{type:'number'}, maximum:{type:'number'} }, ['column']) } }, ['path']),
  spec('dataset_compare', 'Compare two datasets by explicit compound keys and report added/removed/changed records and column drift. Duplicate or empty keys are rejected. CSV numeric equivalence requires the same explicit types. Source files are unchanged.', { path: text, otherPath: text, format: sourceProps.format, otherFormat: sourceProps.format, types, keys: strings, sampleLimit: { ...integer, minimum:1, maximum:100 } }, ['path','otherPath','keys']),
  spec('table_export', 'Create a real CSV/TSV/Markdown/HTML/JSON table artifact from structured rows. HTML is escaped. CSV/TSV spreadsheet formula prefixes are neutralized by default and the changed-cell count is reported. Writes within your workspace and refuses overwriting unless requested.', { ...outputProps, rows: rowsSpec, columns: strings, format: { type:'string', enum:['csv','tsv','markdown','html','json'] }, title:text, neutralizeFormulas:bool }, ['output','rows','format']),
  spec('document_structure', 'Inspect a local UTF-8 Markdown/plain-text document: heading hierarchy and anchors, links, code fences, word/paragraph counts and estimated reading time. This does not extract binary PDF/DOCX files or claim visual layout inspection.', { path:text }, ['path']),
  spec('document_check', 'Check Markdown/text document structure for skipped heading levels, duplicate anchors, broken relative file/heading links, unfinished markers, missing image alt text and very long paragraphs. External URLs are inventoried, not claimed verified.', { path:text, maxParagraphWords:{...integer,minimum:30,maximum:1000} }, ['path']),
  spec('report_compose', 'Compose a structured Markdown or self-contained HTML report with sections, bullets, tables and source links. HTML content is escaped and source links accept HTTP(S) only. Writes within your workspace; this does not publish or send the report.', { ...outputProps, format:{type:'string',enum:['markdown','html']}, title:text, sections:{type:'array',maxItems:40,items:schema({heading:text,text,bullets:strings,rows:rowsSpec,columns:strings},['heading'])}, sources:{type:'array',maxItems:100,items:schema({title:text,url:text,note:text},['title','url'])} }, ['output','format','title','sections']),
  spec('office_checklist', 'Maintain your private structured checklist: list, add, update or summarize items with stable IDs, status, priority and optional ISO due date. Changes are stored in artifacts/checklist.json in your own workspace; this does not schedule jobs or send messages.', { action:{type:'string',enum:['list','add','update','summary']}, id:text, title:text, notes:text, status:{type:'string',enum:['pending','in_progress','done','cancelled']}, priority:{type:'string',enum:['low','normal','high']}, dueDate:text }, ['action']),
  spec('browser_inspect', 'Inspect an owned browser tab for actual headings, links, form controls and basic accessibility warning evidence. Password/control values are omitted. These heuristics are not a full accessibility certification. Start with the browser tool to obtain your tabId.', { tabId:text, limit:{...integer,minimum:1,maximum:200} }, ['tabId']),
  spec('browser_table', 'Extract an actual HTML table from your owned browser tab into structured rows and headers. tableIndex is zero-based. Cell spans are reported; merged cells are not guessed or silently expanded. Source page is unchanged.', { tabId:text, tableIndex:{...integer,minimum:0}, limit:{...integer,minimum:1,maximum:1000} }, ['tabId']),
  spec('responsive_audit', 'Measure an owned browser tab at explicit viewport widths, collect horizontal-overflow evidence and save real screenshots. Restores the original viewport. It does not claim you visually reviewed the resulting files; actual pixels of the last screenshot are returned.', { tabId:text, widths:{type:'array',minItems:1,maxItems:5,items:{type:'integer',minimum:240,maximum:2560}}, height:{...integer,minimum:320,maximum:1600} }, ['tabId','widths']),
];
export const roleTools = {
  'data-analyst':['dataset_profile','dataset_query','dataset_validate','dataset_compare','table_export'],
  'technical-writer':['document_structure','document_check','report_compose','table_export'],
  'frontend-designer':['browser_inspect','responsive_audit','browser_table'],
  'browser-operator':['browser_inspect','browser_table','responsive_audit'],
  'office-assistant':['office_checklist','report_compose','table_export','document_check'],
};
const MAX_BYTES=8*1024*1024, MAX_ROWS=100000;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const resolveFile=(ctx,file)=>path.resolve(ctx.workspace,String(file));
const missing=value=>value===null||value===undefined||value==='';
const own=(object,key)=>Object.hasOwn(object,key);
const checkSignal=ctx=>ctx.signal?.throwIfAborted();
function boundedInteger(value,fallback,min,max,label){if(value===undefined)return fallback;if(!Number.isInteger(value)||value<min||value>max)throw new Error(`Invalid ${label}`);return value;}
function readText(ctx,file){checkSignal(ctx);const absolute=resolveFile(ctx,file);const stat=fs.statSync(absolute);if(!stat.isFile()||stat.size>MAX_BYTES)throw new Error('Input must be a regular file at most 8 MiB');const bytes=fs.readFileSync(absolute);if(bytes.includes(0))throw new Error('Binary input is not supported by this text tool');return {path:absolute,sha256:hash(bytes),text:bytes.toString('utf8').replace(/^\uFEFF/,'')};}

export function parseDelimited(source,delimiter=','){
  const rows=[];let row=[],field='',quoted=false,closed=false,started=false;
  const finishField=()=>{row.push(field);field='';closed=false;started=false;};
  const finishRow=()=>{finishField();rows.push(row);row=[];if(rows.length>MAX_ROWS+1)throw new Error('Dataset exceeds 100,000 rows');};
  for(let i=0;i<source.length;i++){
    const char=source[i];
    if(quoted){if(char==='"'){if(source[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}else field+=char;continue;}
    if(closed&&char!==delimiter&&char!=='\r'&&char!=='\n')throw new Error('Unexpected characters after closing CSV quote');
    if(char==='"'){if(started||field.length)throw new Error('CSV quote must start a field');quoted=true;started=true;}
    else if(char===delimiter)finishField();
    else if(char==='\r'||char==='\n'){if(char==='\r'&&source[i+1]==='\n')i++;finishRow();}
    else{field+=char;started=true;}
  }
  if(quoted)throw new Error('Unclosed CSV quoted field');
  if(field.length||row.length||started||closed)finishRow();
  if(!rows.length)throw new Error('Dataset is empty');
  const headers=rows.shift();
  if(headers.some(h=>!h.trim())||new Set(headers).size!==headers.length)throw new Error('CSV headers must be nonempty and unique');
  const records=rows.map((cells,index)=>{if(cells.length!==headers.length)throw new Error(`Row ${index+2} has ${cells.length} cells; expected ${headers.length}`);return Object.fromEntries(headers.map((name,i)=>[name,cells[i]]));});
  Object.defineProperty(records,'columns',{value:headers});return records;
}
function realDate(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const date=new Date(value+'T00:00:00Z');return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;}
function conversion(value,type){
  if(missing(value))return value;
  if(type==='string')return typeof value==='object'?JSON.stringify(value):String(value);
  if(type==='number'||type==='integer'){
    if(typeof value!=='number'&&(typeof value!=='string'||!value.trim()||!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(value.trim())))throw new Error('not numeric');
    const n=Number(value);if(!Number.isFinite(n)||type==='integer'&&!Number.isSafeInteger(n))throw new Error('not a finite '+(type==='integer'?'safe integer':type));return n;
  }
  if(type==='boolean'){if(value===true||value===false)return value;if(value==='true')return true;if(value==='false')return false;throw new Error('not true/false');}
  if(type==='date'){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)||!realDate(value.slice(0,10))||!Number.isFinite(Date.parse(value)))throw new Error('not an ISO date');return value;}
  throw new Error('Unsupported declared type');
}
function loadDataset(args,ctx){
  const source=readText(ctx,args.path),format=args.format||({'.csv':'csv','.tsv':'tsv','.json':'json','.jsonl':'jsonl','.ndjson':'jsonl'}[path.extname(source.path).toLowerCase()]);
  if(!format)throw new Error('Specify csv, tsv, json or jsonl format');
  let rows;
  if(format==='csv'||format==='tsv')rows=parseDelimited(source.text,format==='tsv'?'\t':',');
  else if(format==='json')rows=JSON.parse(source.text);
  else if(format==='jsonl')rows=source.text.split(/\r?\n/).filter(line=>line.trim()).map((line,i)=>{try{return JSON.parse(line);}catch{throw new Error(`Invalid JSONL record ${i+1}`);}});
  else throw new Error('Unsupported dataset format');
  if(!Array.isArray(rows)||rows.length>MAX_ROWS||rows.some(row=>!row||typeof row!=='object'||Array.isArray(row)))throw new Error('Dataset must be an array of objects with at most 100,000 rows');
  const columns=rows.columns||[...new Set(rows.flatMap(row=>Object.keys(row)))],invalid=[];
  if(columns.length>500||columns.some(c=>c.length>500))throw new Error('Dataset exceeds the 500-column / 500-character column-name limit');
  const declared=args.types||{};
  for(const [column,type]of Object.entries(declared)){if(!columns.includes(column))throw new Error(`Unknown typed column: ${column}`);if(!['string','number','integer','boolean','date'].includes(type))throw new Error('Unsupported declared type');}
  rows=rows.map((row,index)=>{if(index%1000===0)checkSignal(ctx);const copy=Object.assign(Object.create(null),row);for(const [column,type]of Object.entries(declared)){try{Object.defineProperty(copy,column,{value:conversion(copy[column],type),writable:true,enumerable:true,configurable:true});}catch(error){invalid.push({row:index+1,column,type,reason:error.message});}}return copy;});
  return {path:source.path,sha256:source.sha256,format,columns,rows,invalid,declared};
}
function meta(data){return {path:data.path,sha256:data.sha256,format:data.format,rowCount:data.rows.length,columns:data.columns,declaredTypes:data.declared,rowNumbers:'1-based data records, excluding CSV/TSV headers',numberRepresentation:'IEEE 754; declare integer to reject unsafe integer conversions'};}
function requireColumns(data,columns){if(!Array.isArray(columns)||columns.some(c=>typeof c!=='string'||!data.columns.includes(c)))throw new Error('A column is missing or invalid');}
function profile(data){
  const duplicates=new Map();for(const row of data.rows){const key=JSON.stringify(data.columns.map(c=>own(row,c)?{value:row[c]}:{missing:true}));duplicates.set(key,(duplicates.get(key)||0)+1);}
  return {...meta(data),duplicateRows:[...duplicates.values()].reduce((sum,n)=>sum+Math.max(0,n-1),0),invalidConversionCount:data.invalid.length,invalidConversions:data.invalid.slice(0,100),profile:data.columns.map(column=>{
    const values=data.rows.map(row=>row[column]),present=values.filter(v=>!missing(v)),observedTypes={};for(const v of present){const t=Array.isArray(v)?'array':typeof v;observedTypes[t]=(observedTypes[t]||0)+1;}
    const result={column,missing:values.length-present.length,nonempty:present.length,distinct:new Set(present.map(v=>JSON.stringify(v))).size,observedTypes,samples:present.slice(0,5).map(v=>typeof v==='string'?v.slice(0,500):typeof v==='object'?{preview:JSON.stringify(v).slice(0,500)}:v)};
    if(present.length&&present.every(v=>typeof v==='number'&&Number.isFinite(v))){let min=Infinity,max=-Infinity,sum=0,mean=0;for(const v of present){min=Math.min(min,v);max=Math.max(max,v);sum+=v;mean+=v/present.length;}result.numeric={min,max,sum:Number.isFinite(sum)?sum:null,sumOverflow:!Number.isFinite(sum),mean:Number.isFinite(mean)?mean:null};}
    return result;
  })};
}
function query(data,args){
  if(data.invalid.length)throw new Error('Declared type conversions failed; inspect dataset_profile first');
  let rows=data.rows;const filters=args.filters||[];requireColumns(data,filters.map(f=>f.column));
  rows=rows.filter(row=>filters.every(f=>{
    const v=row[f.column];if(f.op==='is_missing')return missing(v);if(f.op==='not_missing')return !missing(v);
    if(f.op==='eq')return JSON.stringify(v)===JSON.stringify(f.value);if(f.op==='ne')return JSON.stringify(v)!==JSON.stringify(f.value);
    if(f.op==='contains'){if(typeof v!=='string'||typeof f.value!=='string')throw new Error('contains requires strings');return v.includes(f.value);}
    if(!['gt','gte','lt','lte'].includes(f.op))throw new Error('Invalid filter operator');if(missing(v))return false;
    if(typeof v!==typeof f.value||!['string','number'].includes(typeof v))throw new Error('Ordered comparison needs matching numeric or string types; declare CSV numeric types');
    return f.op==='gt'?v>f.value:f.op==='gte'?v>=f.value:f.op==='lt'?v<f.value:v<=f.value;
  }));
  const matchedRows=rows.length;
  if(args.aggregates?.length){
    const groups=args.groupBy||[];requireColumns(data,groups);requireColumns(data,args.aggregates.filter(a=>a.column!==undefined||a.op!=='count').map(a=>a.column));
    if(args.aggregates.some(a=>!['count','sum','mean','min','max'].includes(a.op)))throw new Error('Invalid aggregate operator');
    const names=args.aggregates.map(a=>a.name);if(names.some(n=>typeof n!=='string'||!n)||new Set([...groups,...names]).size!==groups.length+names.length)throw new Error('Aggregate names must be nonempty, unique and different from group columns');
    const partitions=new Map();for(const row of rows){const key=JSON.stringify(groups.map(c=>row[c]??null));if(!partitions.has(key))partitions.set(key,[]);partitions.get(key).push(row);}if(!groups.length&&!partitions.size)partitions.set('[]',[]);
    rows=[...partitions.values()].map(records=>{const result=Object.assign(Object.create(null),Object.fromEntries(groups.map(c=>[c,records[0][c]??null])));for(const a of args.aggregates){if(a.op==='count'){result[a.name]=a.column?records.filter(r=>!missing(r[a.column])).length:records.length;continue;}const values=records.map(r=>r[a.column]).filter(v=>!missing(v));if(values.some(v=>typeof v!=='number'||!Number.isFinite(v)))throw new Error('Numeric aggregates require numeric columns; declare CSV types');let value=null;if(values.length){if(a.op==='sum'||a.op==='mean')value=values.reduce((sum,n)=>sum+n/(a.op==='mean'?values.length:1),0);else if(a.op==='min')value=values.reduce((a,b)=>Math.min(a,b));else if(a.op==='max')value=values.reduce((a,b)=>Math.max(a,b));else throw new Error('Invalid aggregate operator');if(!Number.isFinite(value))throw new Error('Numeric aggregate overflow; use scaled values or higher-precision analysis');}else if(a.op==='sum')value=0;result[a.name]=value;}return result;});
  }else if(args.groupBy?.length)throw new Error('groupBy requires aggregates');
  let columns=args.aggregates?.length?[...(args.groupBy||[]),...args.aggregates.map(a=>a.name)]:data.columns;
  if(args.select){if(args.select.some(c=>!columns.includes(c)))throw new Error('Unknown selected output column');columns=args.select;rows=rows.map(row=>Object.fromEntries(columns.map(c=>[c,row[c]??null])));}
  for(const sort of args.sort||[])if(!columns.includes(sort.column))throw new Error('Unknown sort column');
  for(const sort of args.sort||[]){const observed=new Set(rows.map(row=>row[sort.column]).filter(v=>!missing(v)).map(v=>typeof v));if(observed.size>1||[...observed].some(type=>!['number','string','boolean'].includes(type)))throw new Error('Sort columns need one scalar type; declare consistent types first');}
  rows=[...rows].sort((a,b)=>{for(const sort of args.sort||[]){const x=a[sort.column],y=b[sort.column];const order=missing(x)?missing(y)?0:1:missing(y)?-1:x<y?-1:x>y?1:0;if(order)return sort.descending?-order:order;}return 0;});
  const limit=boundedInteger(args.limit,100,1,1000,'row limit');
  const returned=[];let outputBytes=0;for(const row of rows.slice(0,limit)){const size=Buffer.byteLength(JSON.stringify(row));if(outputBytes+size>180000)break;returned.push(Object.fromEntries(Object.entries(row)));outputBytes+=size;}
  return {...meta(data),matchedRows,outputRows:rows.length,returnedRows:returned.length,truncated:rows.length>returned.length,resultColumns:columns,rows:returned,outputBudgetBytes:180000};
}
function validate(data,args){
  const errors=[],counts={};const add=(kind,details)=>{counts[kind]=(counts[kind]||0)+1;if(errors.length<200)errors.push({kind,...details});};
  for(const column of args.requiredColumns||[])if(!data.columns.includes(column))add('missing_column',{column});
  for(const item of data.invalid)add('invalid_type',item);
  requireColumns(data,[...(args.notNull||[]),...(args.uniqueBy||[]),...(args.rules||[]).map(r=>r.column)]);
  const seen=new Map();data.rows.forEach((row,index)=>{
    for(const column of args.notNull||[])if(missing(row[column]))add('missing_value',{row:index+1,column});
    if(args.uniqueBy?.length){const key=JSON.stringify(args.uniqueBy.map(c=>row[c]??null));if(seen.has(key))add('duplicate_key',{row:index+1,firstRow:seen.get(key),columns:args.uniqueBy});else seen.set(key,index+1);}
    for(const rule of args.rules||[]){const v=row[rule.column];if(missing(v))continue;if(rule.allowed&&!rule.allowed.some(a=>JSON.stringify(a)===JSON.stringify(v)))add('not_allowed',{row:index+1,column:rule.column});if(rule.minimum!==undefined||rule.maximum!==undefined){if(typeof v!=='number')add('not_numeric',{row:index+1,column:rule.column});else if(rule.minimum!==undefined&&v<rule.minimum||rule.maximum!==undefined&&v>rule.maximum)add('out_of_range',{row:index+1,column:rule.column});}}
  });const failureCount=Object.values(counts).reduce((a,b)=>a+b,0);return {...meta(data),valid:failureCount===0,failureCount,counts,failures:errors,samplesTruncated:failureCount>errors.length};
}
function compare(left,right,args){
  if(!Array.isArray(args.keys)||!args.keys.length)throw new Error('Provide at least one comparison key');requireColumns(left,args.keys);requireColumns(right,args.keys);if(left.invalid.length||right.invalid.length)throw new Error('Invalid declared type conversions prevent comparison');
  const index=data=>{const map=new Map();for(const [i,row]of data.rows.entries()){if(args.keys.some(c=>missing(row[c])))throw new Error(`Empty comparison key in ${data.path} at row ${i+1}`);const key=JSON.stringify(args.keys.map(c=>row[c]));if(map.has(key))throw new Error(`Duplicate comparison key in ${data.path} at row ${i+1}`);map.set(key,row);}return map;};
  const a=index(left),b=index(right),added=[],removed=[],changed=[];const columns=[...new Set([...left.columns,...right.columns])];
  for(const [key,row]of a){if(!b.has(key))removed.push({key:JSON.parse(key),row});else{const other=b.get(key),differences=columns.filter(c=>JSON.stringify(row[c])!==JSON.stringify(other[c])).map(column=>({column,before:row[column]??null,after:other[column]??null}));if(differences.length)changed.push({key:JSON.parse(key),differences});}}
  for(const [key,row]of b)if(!a.has(key))added.push({key:JSON.parse(key),row});const limit=boundedInteger(args.sampleLimit,20,1,100,'sample limit');
  return {left:meta(left),right:meta(right),keys:args.keys,addedColumns:right.columns.filter(c=>!left.columns.includes(c)),removedColumns:left.columns.filter(c=>!right.columns.includes(c)),counts:{added:added.length,removed:removed.length,changed:changed.length,unchanged:a.size-removed.length-changed.length},samples:{added:added.slice(0,limit),removed:removed.slice(0,limit),changed:changed.slice(0,limit)},sampleLimit:limit};
}

const html=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cell=value=>value===null||value===undefined?'':typeof value==='object'?JSON.stringify(value):String(value);
const mdCell=value=>cell(value).replaceAll('\\','\\\\').replaceAll('|','\\|').replace(/\r?\n/g,'<br>');
function tableRows(rows,columns){if(!Array.isArray(rows)||rows.length>1000||rows.some(row=>!row||typeof row!=='object'||Array.isArray(row)))throw new Error('Provide up to 1000 row objects');columns=columns||[...new Set(rows.flatMap(row=>Object.keys(row)))];if(!Array.isArray(columns)||columns.some(c=>typeof c!=='string')||new Set(columns).size!==columns.length)throw new Error('Invalid table columns');return {rows:rows.map(row=>Object.assign(Object.create(null),row)),columns};}
function renderTable(rows,columns,format,neutralize=true){
  let neutralizedCells=0;const values=[columns,...rows.map(row=>columns.map(c=>row[c]))];
  if(format==='json')return {content:JSON.stringify(rows,null,2)+'\n',neutralizedCells};
  if(format==='html')return {content:'<table><thead><tr>'+columns.map(c=>'<th scope="col">'+html(c)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>'<tr>'+columns.map(c=>'<td>'+html(cell(row[c]))+'</td>').join('')+'</tr>').join('')+'</tbody></table>',neutralizedCells};
  if(format==='markdown')return {content:'| '+columns.map(mdCell).join(' | ')+' |\n| '+columns.map(()=>'---').join(' | ')+' |\n'+rows.map(row=>'| '+columns.map(c=>mdCell(row[c])).join(' | ')+' |').join('\n')+'\n',neutralizedCells};
  if(!['csv','tsv'].includes(format))throw new Error('Unsupported table output format');const delimiter=format==='tsv'?'\t':',';
  return {content:values.map(row=>row.map(value=>{let s=cell(value);if(neutralize&&typeof value!=='number'&&/^[\s]*[=+\-@]/.test(s)){s="'"+s;neutralizedCells++;}return s.includes(delimiter)||/["\r\n]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;}).join(delimiter)).join('\r\n')+'\r\n',neutralizedCells};
}
function saveArtifact(ctx,output,content,overwrite=false){
  checkSignal(ctx);if(typeof output!=='string'||!output.trim())throw new Error('Artifact output path is required');
  const root=path.resolve(ctx.workspace),target=path.resolve(root,output),relative=path.relative(root,target);
  if(!relative||relative.startsWith('..'+path.sep)||relative==='..'||path.isAbsolute(relative))throw new Error('Artifact path must stay inside your workspace');
  for(let p=path.dirname(target);p!==path.dirname(root);p=path.dirname(p)){if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw new Error('Artifact path cannot traverse symlinks');if(p===root)break;}
  if(Buffer.byteLength(content)>MAX_BYTES)throw new Error('Artifact exceeds 8 MiB');if(fs.existsSync(target)&&!overwrite)throw new Error('Output already exists; set overwrite explicitly to replace it');
  if(fs.existsSync(target)&&!fs.lstatSync(target).isFile())throw new Error('Artifact target must be a regular file');
  fs.mkdirSync(path.dirname(target),{recursive:true});const temporary=target+'.'+randomUUID()+'.part';fs.writeFileSync(temporary,content,{flag:'wx'});
  try{if(fs.existsSync(target)&&!overwrite)throw new Error('Output was created during rendering');fs.renameSync(temporary,target);}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  return {path:target,bytes:Buffer.byteLength(content),sha256:hash(content)};
}
function tableExport(args,ctx){const {rows,columns}=tableRows(args.rows,args.columns),rendered=renderTable(rows,columns,args.format,args.neutralizeFormulas!==false);let content=rendered.content;if(args.format==='html')content=htmlPage(args.title||'Table',content);return {...saveArtifact(ctx,args.output,content,args.overwrite),format:args.format,rows:rows.length,columns,neutralizedCells:rendered.neutralizedCells};}
function htmlPage(title,body){return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>'+html(title)+'</title><style>body{font:16px/1.55 system-ui,sans-serif;max-width:960px;margin:40px auto;padding:0 24px;color:#17212e}h1,h2{line-height:1.2}table{border-collapse:collapse;width:100%;margin:20px 0}th,td{text-align:left;vertical-align:top;padding:10px 12px;border:1px solid #ccd5df}th{background:#eef3f8}a{color:#1259a7}p{white-space:pre-wrap}</style><body><h1>'+html(title)+'</h1>'+body+'</body></html>\n';}
function report(args,ctx){
  if(!['markdown','html'].includes(args.format)||typeof args.title!=='string'||!Array.isArray(args.sections)||args.sections.length>40)throw new Error('Invalid report');
  const isHtml=args.format==='html',sections=[];
  for(const section of args.sections){if(typeof section.heading!=='string')throw new Error('Each report section needs a heading');let body=isHtml?'<h2>'+html(section.heading)+'</h2>':'## '+section.heading+'\n\n';if(section.text)body+=isHtml?'<p>'+html(section.text)+'</p>':section.text+'\n\n';if(section.bullets?.length)body+=isHtml?'<ul>'+section.bullets.map(s=>'<li>'+html(s)+'</li>').join('')+'</ul>':section.bullets.map(s=>'- '+String(s).replace(/\r?\n/g,' ')).join('\n')+'\n\n';if(section.rows){const {rows,columns}=tableRows(section.rows,section.columns);body+=renderTable(rows,columns,isHtml?'html':'markdown').content+'\n';}sections.push(body);}
  if(args.sources?.length){let body=isHtml?'<h2>Sources</h2><ul>':'## Sources\n\n';for(const source of args.sources){let url;try{url=new URL(source.url);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error();}catch{throw new Error('Report source links require HTTP(S) URLs without credentials');}body+=isHtml?'<li><a href="'+html(url.href)+'">'+html(source.title)+'</a>'+ (source.note?' — '+html(source.note):'')+'</li>':'- ['+String(source.title).replace(/[\[\]\r\n]/g,'')+']('+url.href.replace(/[()]/g,c=>encodeURIComponent(c))+')'+(source.note?' — '+String(source.note).replace(/\r?\n/g,' '):'')+'\n';}if(isHtml)body+='</ul>';sections.push(body);}
  const content=isHtml?htmlPage(args.title,sections.join('\n')):'# '+args.title+'\n\n'+sections.join('\n');return {...saveArtifact(ctx,args.output,content,args.overwrite),format:args.format,sections:args.sections.length};
}
function documentStructure(args,ctx){
  const source=readText(ctx,args.path),lines=source.text.split(/\r?\n/),headings=[],links=[],fences=[];let fence=null;const anchors=new Map();
  for(let i=0;i<lines.length;i++){
    const f=lines[i].match(/^\s{0,3}(`{3,}|~{3,})/);if(f){if(!fence){fence={marker:f[1][0],length:f[1].length,line:i+1};fences.push({...fence,closed:false});}else if(f[1][0]===fence.marker&&f[1].length>=fence.length){fences.at(-1).closed=true;fence=null;}continue;}if(fence)continue;
    const h=lines[i].match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);if(h){const label=h[2],base=label.toLowerCase().replace(/<[^>]+>/g,'').replace(/[^\p{L}\p{N}\s_-]/gu,'').trim().replace(/\s/g,'-');const ordinal=anchors.get(base)||0;anchors.set(base,ordinal+1);headings.push({line:i+1,level:h[1].length,text:label,anchor:ordinal?base+'-'+ordinal:base,duplicateBase:ordinal>0});}
    for(const match of lines[i].matchAll(/(!?)\[([^\]]*)\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)/g))links.push({line:i+1,image:match[1]==='!',text:match[2],target:match[3]});
  }
  const contentWithoutCode=source.text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g,' '),words=(contentWithoutCode.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)||[]).length,paragraphs=contentWithoutCode.split(/\n\s*\n/).filter(p=>p.trim());
  return {path:source.path,sha256:source.sha256,words,paragraphs:paragraphs.length,estimatedReadingMinutes:Math.round(words/200*10)/10,readingRateWordsPerMinute:200,headings:headings.slice(0,500),links:links.slice(0,1000),fences: fences.slice(0,500),truncated:headings.length>500||links.length>1000||fences.length>500,sourceText:source.text};
}
function documentCheck(args,ctx){
  const doc=documentStructure(args,ctx),issues=[];let prior=0;
  for(const h of doc.headings){if(h.level>prior+1)issues.push({kind:'skipped_heading_level',line:h.line,level:h.level,previousLevel:prior});if(h.duplicateBase)issues.push({kind:'duplicate_heading_anchor_base',line:h.line,text:h.text,actualAnchor:h.anchor});prior=h.level;}
  for(const fence of doc.fences)if(!fence.closed)issues.push({kind:'unclosed_code_fence',line:fence.line});
  const anchors=new Set(doc.headings.map(h=>h.anchor));
  for(const link of doc.links){if(link.image&&!link.text.trim())issues.push({kind:'missing_image_alt',line:link.line,target:link.target});if(/^https?:\/\//i.test(link.target))continue;if(link.target.startsWith('#')){let target;try{target=decodeURIComponent(link.target.slice(1));}catch{target='';}if(!anchors.has(target))issues.push({kind:'missing_heading_target',line:link.line,target:link.target});}else if(!/^[a-z][a-z0-9+.-]*:/i.test(link.target)){let name=link.target.split('#')[0];try{name=decodeURIComponent(name);}catch{}if(name&&!fs.existsSync(path.resolve(path.dirname(doc.path),name)))issues.push({kind:'missing_relative_file',line:link.line,target:link.target});}}
  const lines=doc.sourceText.split(/\r?\n/);for(let i=0;i<lines.length;i++)if(/\b(?:TODO|FIXME|TBD)\b/.test(lines[i]))issues.push({kind:'unfinished_marker',line:i+1,excerpt:lines[i].slice(0,160)});
  const max=boundedInteger(args.maxParagraphWords,180,30,1000,'paragraph word limit');for(const p of doc.sourceText.split(/\n\s*\n/)){const words=(p.match(/\S+/g)||[]).length;if(words>max)issues.push({kind:'long_paragraph',words,excerpt:p.slice(0,120)});}
  const {sourceText,...summary}=doc;return {...summary,issueCount:issues.length,issues:issues.slice(0,300),issuesTruncated:issues.length>300,externalLinksVerified:false,limitations:['Markdown link parsing covers inline links; reference-style links and complex nested link syntax are not fully parsed.','Accessibility, visual layout and grammar are not certified by this structure check.']};
}
function checklist(args,ctx){
  const file=path.join(ctx.workspace,'artifacts','checklist.json');let items=fs.existsSync(file)?JSON.parse(readText(ctx,file).text):[];if(!Array.isArray(items))throw new Error('Checklist file is invalid');
  if(args.action==='list')return {path:file,items};
  if(args.action==='summary'){const byStatus={},byPriority={};for(const item of items){byStatus[item.status]=(byStatus[item.status]||0)+1;byPriority[item.priority]=(byPriority[item.priority]||0)+1;}const today=new Date().toISOString().slice(0,10);return {path:file,total:items.length,byStatus,byPriority,overdue:items.filter(item=>item.dueDate&&item.dueDate<today&&!['done','cancelled'].includes(item.status)).map(item=>({id:item.id,title:item.title,dueDate:item.dueDate})),dateBasis:'UTC calendar date',asOf:today};}
  if(args.dueDate!==undefined&&!realDate(args.dueDate))throw new Error('dueDate must be a real ISO YYYY-MM-DD date');
  if(args.status!==undefined&&!['pending','in_progress','done','cancelled'].includes(args.status))throw new Error('Invalid checklist status');if(args.priority!==undefined&&!['low','normal','high'].includes(args.priority))throw new Error('Invalid checklist priority');
  let item;if(args.action==='add'){if(typeof args.title!=='string'||!args.title.trim())throw new Error('Checklist title is required');if(items.length>=1000)throw new Error('Checklist has reached 1000 items');item={id:randomUUID(),title:args.title,notes:args.notes||'',status:args.status||'pending',priority:args.priority||'normal',createdAt:new Date().toISOString()};if(args.dueDate)item.dueDate=args.dueDate;items.push(item);}else if(args.action==='update'){item=items.find(item=>item.id===args.id);if(!item)throw new Error('Checklist item not found');for(const key of ['title','notes','status','priority','dueDate'])if(own(args,key)){if(key==='title'&&!args[key].trim())throw new Error('Checklist title cannot be empty');item[key]=args[key];}item.updatedAt=new Date().toISOString();}else throw new Error('Unknown checklist action');
  return {...saveArtifact(ctx,'artifacts/checklist.json',JSON.stringify(items,null,2)+'\n',true),item,total:items.length};
}
async function ownedPage(ctx,tabId,fn){
  checkSignal(ctx);if(!config().browser.enabled)throw new Error('Browser access is disabled');if(!ctx.browsers)throw new Error('Browser manager is unavailable');const group=await ctx.browsers.group(ctx.botId??ctx.bot?.id);const page=group.tabs.get(tabId);if(!page||page.isClosed())throw new Error('That tab does not belong to this worker browser group');
  return group.slots.use(ctx.signal,async()=>{checkSignal(ctx);return fn(page,group);});
}
async function browserInspect(args,ctx){
  const limit=boundedInteger(args.limit,100,1,200,'browser result limit');
  return ownedPage(ctx,args.tabId,async(page,group)=>({group:group.id,tabId:args.tabId,url:page.url(),title:await page.title(),...await page.evaluate(limit=>{
    const visible=el=>!!(el.getClientRects().length)&&getComputedStyle(el).visibility!=='hidden';const label=el=>el.getAttribute('aria-label')||el.getAttribute('aria-labelledby')?.split(/\s+/).map(id=>document.getElementById(id)?.textContent||'').join(' ').trim()||[...(el.labels||[])].map(l=>l.textContent.trim()).join(' ')||el.textContent?.trim()||el.getAttribute('title')||'';
    const headings=[...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(visible).map(el=>({level:Number(el.tagName[1]),text:el.textContent.trim().slice(0,500)}));
    const links=[...document.querySelectorAll('a[href]')].filter(visible).map(el=>({text:label(el).slice(0,500),url:el.href}));
    const controls=[...document.querySelectorAll('input,textarea,select,button,[role="button"]')].filter(visible).map(el=>({tag:el.tagName.toLowerCase(),type:el.getAttribute('type')||'',name:el.getAttribute('name')||'',label:label(el).slice(0,500),required:!!el.required,disabled:!!el.disabled}));
    const warnings=[];for(const image of document.querySelectorAll('img'))if(visible(image)&&!image.hasAttribute('alt'))warnings.push({kind:'image_without_alt',src:image.getAttribute('src')?.slice(0,300)});for(const control of controls)if(!control.label&&!['hidden','submit','reset'].includes(control.type))warnings.push({kind:'control_without_observed_label',tag:control.tag,name:control.name});if(!document.documentElement.lang)warnings.push({kind:'missing_document_language'});if(!document.title.trim())warnings.push({kind:'missing_page_title'});
    return {counts:{headings:headings.length,links:links.length,controls:controls.length,warnings:warnings.length},headings:headings.slice(0,limit),links:links.slice(0,limit),controls:controls.slice(0,limit),warnings:warnings.slice(0,limit),inputValuesIncluded:false,accessibilityScope:'Basic DOM heuristics; not a complete accessibility audit'};
  },limit)}));
}
async function browserTable(args,ctx){
  const index=boundedInteger(args.tableIndex,0,0,1000,'table index'),limit=boundedInteger(args.limit,100,1,1000,'table row limit');
  return ownedPage(ctx,args.tabId,async(page,group)=>{const tables=page.locator('table'),count=await tables.count();if(index>=count)throw new Error(`Table ${index} does not exist; observed ${count} tables`);const table=await tables.nth(index).evaluate((element,limit)=>{
    const all=[...element.rows];const records=all.map(row=>[...row.cells].map(cell=>({text:cell.textContent.trim(),header:cell.tagName==='TH',rowSpan:cell.rowSpan,colSpan:cell.colSpan})));const first=records[0]||[],headerCount=all[0]?.parentElement?.tagName==='THEAD'||first.length&&first.every(c=>c.header)?1:0;const columns=headerCount?first.map(c=>c.text):first.map((_,i)=>'column_'+(i+1));const data=records.slice(headerCount);return {columns,rows:data.slice(0,limit).map(row=>row.map(c=>c.text)),rowCount:data.length,returnedRows:Math.min(limit,data.length),truncated:data.length>limit,spans:records.flatMap((row,rowIndex)=>row.flatMap((c,columnIndex)=>c.rowSpan!==1||c.colSpan!==1?[{row:rowIndex+1,column:columnIndex+1,rowSpan:c.rowSpan,colSpan:c.colSpan}]:[])).slice(0,100),mergedCellsExpanded:false};
  },limit);return {group:group.id,tabId:args.tabId,url:page.url(),tableIndex:index,tableCount:count,...table};});
}
async function responsiveAudit(args,ctx){
  if(!Array.isArray(args.widths)||!args.widths.length||args.widths.length>5||args.widths.some(w=>!Number.isInteger(w)||w<240||w>2560))throw new Error('Provide 1 to 5 viewport widths between 240 and 2560');const height=boundedInteger(args.height,900,320,1600,'viewport height');
  return ownedPage(ctx,args.tabId,async(page,group)=>{const original=page.viewportSize(),checks=[];try{for(const width of args.widths){checkSignal(ctx);await page.setViewportSize({width,height});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));const measured=await page.evaluate(()=>({viewport:{width:innerWidth,height:innerHeight},documentWidth:Math.max(document.documentElement.scrollWidth,document.body?.scrollWidth||0),horizontalOverflow:Math.max(document.documentElement.scrollWidth,document.body?.scrollWidth||0)>innerWidth+1,overflowElements:[...document.querySelectorAll('body *')].filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&(r.right>innerWidth+1||r.left< -1)&&getComputedStyle(el).position!=='fixed';}).slice(0,30).map(el=>({tag:el.tagName.toLowerCase(),id:el.id||'',className:typeof el.className==='string'?el.className.slice(0,120):'',width:Math.round(el.getBoundingClientRect().width)}))}));const output='artifacts/responsive-'+randomUUID()+'-'+width+'.png';const file=resolveFile(ctx,output);fs.mkdirSync(path.dirname(file),{recursive:true});await page.screenshot({path:file,fullPage:false,timeout:15000});checks.push({...measured,screenshot:file});}}finally{if(original&&!page.isClosed())await page.setViewportSize(original);}
    const last=checks.at(-1);return {group:group.id,tabId:args.tabId,url:page.url(),checks,viewportRestored:!!original,visualReviewClaimed:false,...inspectImage(last.screenshot)};});
}
export async function execute(name,args,ctx){
  checkSignal(ctx);if(!ctx.workspace)throw new Error('Worker workspace is required');
  if(name==='dataset_profile')return profile(loadDataset(args,ctx));
  if(name==='dataset_query')return query(loadDataset(args,ctx),args);
  if(name==='dataset_validate')return validate(loadDataset(args,ctx),args);
  if(name==='dataset_compare')return compare(loadDataset(args,ctx),loadDataset({...args,path:args.otherPath,format:args.otherFormat||args.format},ctx),args);
  if(name==='table_export')return tableExport(args,ctx);
  if(name==='document_structure'){const {sourceText,...result}=documentStructure(args,ctx);return result;}
  if(name==='document_check')return documentCheck(args,ctx);
  if(name==='report_compose')return report(args,ctx);
  if(name==='office_checklist')return checklist(args,ctx);
  if(name==='browser_inspect')return browserInspect(args,ctx);
  if(name==='browser_table')return browserTable(args,ctx);
  if(name==='responsive_audit')return responsiveAudit(args,ctx);
  throw new Error('Unknown content tool: '+name);
}

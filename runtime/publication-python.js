// Operator-provided trusted paths only. Not wired to HTTP configuration until deployment review.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
function local(p){
 if(typeof p!=='string'||!path.isAbsolute(p)||/^[/\\\\]{2}/.test(p)||p.split(/[/\\\\]/).includes('..'))throw Error('Absolute local trusted path required');
 for(let x=p;;x=path.dirname(x)){
  if(fs.existsSync(x)&&fs.lstatSync(x).isSymbolicLink())throw Error('Link/junction forbidden');
  if(path.dirname(x)===x)break;
 }
 return path.resolve(p);
}
function immutable(file,bytes){
 try{const fd=fs.openSync(file,'wx');try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
 catch(e){if(e.code!=='EEXIST'||!fs.readFileSync(file).equals(Buffer.from(bytes)))throw e;}
}
export function createPythonPublicationAdapter({python,cwd,db,inputRoot,archiveRoot}){
 for(const p of [python,cwd,db,inputRoot,archiveRoot])local(p);
 if(!fs.statSync(python).isFile()||!fs.statSync(cwd).isDirectory()||!fs.statSync(inputRoot).isDirectory()||!fs.statSync(archiveRoot).isDirectory())throw Error('Reviewed installed adapter paths required');
 const base=['-m','kb.publication_cli','--db',db,'--input-root',inputRoot,'--archive-root',archiveRoot];
 function invoke(args){
  return new Promise((resolve,reject)=>{
   const child=spawn(python,[...base,...args],{cwd,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
   let output='',size=0,done=false;
   const timer=setTimeout(()=>{finish(Error('Adapter timeout; process may still be active; reconcile required'));},120000);
   function finish(e,r){if(done)return;done=true;clearTimeout(timer);e?reject(e):resolve(r);}
   child.stdout.on('data',b=>{size+=b.length;if(size>1000000){finish(Error('Adapter output overflow; process may still be active; reconcile required'));}else output+=b;});
   child.stderr.resume();
   child.on('error',e=>finish(e));
   child.on('close',code=>{try{if(code!==0)throw Error('Adapter failed; reconcile required');finish(null,JSON.parse(output));}catch(e){finish(e);}});
  });
 }
 return {
  async publish(p){
   if(!/^[a-f0-9-]{36}$/.test(p.requestId))throw Error('Invalid captured request');
   const markdown=local(path.join(inputRoot,p.requestId+'.md')),manifest=local(path.join(inputRoot,p.requestId+'.json'));
   const m={request_id:p.requestId,source_namespace:'nimbus:'+p.installation,source_document_id:p.documentId,source_revision:p.rev,expected_published_revision:p.previousPublishedRev,sha256:p.sha256,markdown_path:markdown,title:p.snapshot.title,source_uri:'nimbus://'+p.installation+'/'+p.documentId+'?rev='+p.rev,author_label:p.owner,published_by:p.owner,published_at:p.createdAt,citations:p.input.citations};
   // Capture both files before process effects; never overwrite on retry.
   immutable(markdown,p.markdown);immutable(manifest,JSON.stringify(m));
   return invoke(['publish-nimbus','--request',manifest]);
  },
  status(requestId){if(!/^[a-f0-9-]{36}$/.test(requestId))throw Error('Invalid request');return invoke(['publication-status','--request-id',requestId]);}
 };
}

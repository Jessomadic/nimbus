import fs from 'node:fs';
import path from 'node:path';
export function workspaceDownload(root,requested){
  try{
    if(typeof requested!=='string'||!requested||path.isAbsolute(requested)||requested.split(/[\\/]/).includes('..')||/[:\x00-\x1f]/.test(requested))return null;
    const realRoot=fs.realpathSync(root),file=fs.realpathSync(path.resolve(root,String(requested))),relative=path.relative(realRoot,file);
    if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||!fs.statSync(file).isFile())return null;
    return file;
  }catch{return null;}
}

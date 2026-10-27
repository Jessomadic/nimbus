export function hierarchyRows(items){
  const known=new Set(items.map(i=>i.key)),children=new Map(),roots=[],seen=new Set(),result=[];
  for(const item of items){if(item.parent&&known.has(item.parent)){if(!children.has(item.parent))children.set(item.parent,[]);children.get(item.parent).push(item);}else roots.push(item);}
  const visit=(item,depth)=>{if(seen.has(item.key))return;seen.add(item.key);result.push({...item,depth});for(const child of children.get(item.key)||[])visit(child,depth+1);};
  for(const root of roots)visit(root,0);for(const item of items)visit(item,0);return result;
}

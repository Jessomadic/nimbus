// Organizational ownership is separate from parent_run, which records the
// actual delegation chain and enforces task-cycle/depth limits at execution.
export function validateParentLink(id,parentId,bots){
  if(parentId==null)return;
  if(!Number.isSafeInteger(parentId)||parentId<=0)throw new Error('Invalid parent worker');
  const byId=new Map(bots.map(b=>[Number(b.id),b]));
  const seen=new Set(id==null?[]:[Number(id)]);
  for(let current=parentId;current!=null;){
    if(seen.has(current))throw new Error('A worker hierarchy cannot contain a cycle');
    seen.add(current);const bot=byId.get(current);if(!bot)throw new Error('Parent worker not found');
    current=bot.parent_bot_id==null?null:Number(bot.parent_bot_id);
  }
}

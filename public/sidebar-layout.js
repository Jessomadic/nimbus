import {DISPLAY_GROUPS} from './agent-groups.js';

export const SIDEBAR_GROUPS=Object.freeze([...DISPLAY_GROUPS,Object.freeze({id:'rooms',label:'Group chats'})]);
const ids=new Set(SIDEBAR_GROUPS.map(group=>group.id));
const validId=value=>typeof value==='string'&&ids.has(value);
export function normalizeSidebarLayout(value){
  if(value==null)return{version:1,groups:SIDEBAR_GROUPS.map(({id})=>({id,parent:null}))};
  if(value.version!==1||!Array.isArray(value.groups)||value.groups.length>SIDEBAR_GROUPS.length)throw new Error('Invalid sidebar layout');
  const seen=new Set(),groups=value.groups.map(group=>{
    if(!group||!validId(group.id)||seen.has(group.id)||group.parent!==null&&!validId(group.parent))throw new Error('Invalid sidebar group');
    seen.add(group.id);return{id:group.id,parent:group.parent};
  });
  for(const {id}of SIDEBAR_GROUPS)if(!seen.has(id))groups.push({id,parent:null});
  const parents=new Map(groups.map(group=>[group.id,group.parent]));
  for(const group of groups){const visited=new Set([group.id]);let parent=group.parent;while(parent!==null){if(visited.has(parent))throw new Error('A group cannot contain itself or one of its ancestors');visited.add(parent);parent=parents.get(parent);}}
  return{version:1,groups};
}
export function sidebarGroupAncestors(layout,id){
  const groups=normalizeSidebarLayout(layout).groups,parents=new Map(groups.map(group=>[group.id,group.parent])),ancestors=[];
  let parent=parents.get(id);while(parent!==undefined&&parent!==null){ancestors.push(parent);parent=parents.get(parent);}return ancestors;
}
export function moveSidebarGroup(layout,{id,parent=null,before=null}){
  const current=normalizeSidebarLayout(layout);
  if(!validId(id)||parent!==null&&!validId(parent)||before!==null&&!validId(before))throw new Error('Choose a known sidebar group');
  if(id===parent||parent!==null&&sidebarGroupAncestors(current,parent).includes(id))throw new Error('A group cannot contain itself or one of its descendants');
  if(before===id)throw new Error('Choose another group as the insertion point');
  if(before!==null&&current.groups.find(group=>group.id===before).parent!==parent)throw new Error('The insertion point belongs to another group');
  const children=new Map([[null,[]]]);
  for(const group of current.groups){if(!children.has(group.parent))children.set(group.parent,[]);if(group.id!==id)children.get(group.parent).push(group.id);}
  if(!children.has(parent))children.set(parent,[]);
  const siblings=children.get(parent),index=before===null?siblings.length:siblings.indexOf(before);siblings.splice(index,0,id);
  const groups=[],visit=(key,owner)=>{groups.push({id:key,parent:owner});for(const child of children.get(key)||[])visit(child,key);};
  for(const root of children.get(null))visit(root,null);
  return normalizeSidebarLayout({version:1,groups});
}
export function normalizeSidebarOrder(order){return Array.isArray(order)?[...new Set(order.filter(key=>typeof key==='string'&&/^(bot|room):[1-9]\d*$/.test(key)))].slice(0,500):[];}
export function moveSidebarKeys(order,moving,before=null){
  const keys=[...new Set(order)],selected=[...new Set(moving)],set=new Set(selected);
  if(before!==null&&(!keys.includes(before)||set.has(before)))throw new Error('The insertion point is no longer available');
  const remaining=keys.filter(key=>!set.has(key)),index=before===null?remaining.length:remaining.indexOf(before);
  remaining.splice(index,0,...selected);return remaining;
}

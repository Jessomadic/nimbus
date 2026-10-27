import {SIDEBAR_GROUPS,normalizeSidebarLayout,moveSidebarGroup,moveSidebarKeys} from './sidebar-layout.js';

// Display moves only. Organizational parent links and room membership are never edited.
export function installSidebarDrag(options){
  let drag=null,busy=false,suppressClickUntil=0;
  const groupName=id=>SIDEBAR_GROUPS.find(group=>group.id===id)?.label||'group';
  const layout=()=>normalizeSidebarLayout(options.state()?.sidebarLayout);
  const rows=list=>[...list.children].filter(row=>row.classList.contains('side-item'));
  const subtree=item=>{const block=[item],depth=Number(item.dataset.depth)||0;for(let next=item.nextElementSibling;next?.classList.contains('side-item')&&Number(next.dataset.depth)>depth;next=next.nextElementSibling)block.push(next);return block;};
  const announce=text=>{const status=document.querySelector('#sidebar-move-status');if(status)status.textContent=text;};
  function stopHover(){if(drag){clearTimeout(drag.hoverTimer);drag.hoverSection=null;}}
  function clearTarget(){if(!drag)return;drag.marker?.classList.remove('side-drop-before','side-drop-after','side-drop-inside','side-drop-invalid');drag.marker=null;drag.target=null;}
  function mark(element,kind,target,text){clearTarget();drag.marker=element;drag.target=target;element?.classList.add('side-drop-'+kind);announce(text);}
  function begin(element,x,y,touch){
    if(busy||options.filtered()||element.classList.contains('fixed-root'))return;
    const heading=element.classList.contains('side-group-heading'),section=element.closest('.side-display-group'),list=heading?null:element.closest('.side-group-members'),scroller=element.closest('.side-list');
    if(!section||!scroller||!heading&&(!list||list.hidden))return;
    drag={element,section,list,scroller,kind:heading?'group':'items',source:section.dataset.displaySection,startX:x,startY:y,x,y,touch,started:false};
    if(touch)drag.timer=setTimeout(()=>start(),320);
  }
  function start(){
    if(!drag)return;drag.started=true;
    const rect=drag.element.getBoundingClientRect();drag.grabX=drag.startX-rect.left;drag.grabY=drag.startY-rect.top;
    drag.block=drag.kind==='group'?[drag.section]:subtree(drag.element);
    drag.ghost=drag.element.cloneNode(true);drag.ghost.removeAttribute('id');drag.ghost.removeAttribute('aria-controls');drag.ghost.setAttribute('aria-hidden','true');drag.ghost.classList.add('sidebar-drag-ghost');
    Object.assign(drag.ghost.style,{width:rect.width+'px',left:rect.left+'px',top:rect.top+'px'});document.body.append(drag.ghost);
    for(const item of drag.block)item.classList.add('side-drag-source');
    document.body.classList.add('reordering',drag.kind==='group'?'reordering-group':'reordering-agents');options.buzz?.(12);
    drag.frame=requestAnimationFrame(tick);update();
  }
  function tick(){
    if(!drag?.started)return;
    const rect=drag.scroller.getBoundingClientRect(),before=drag.scroller.scrollTop;
    if(drag.y<rect.top+40)drag.scroller.scrollTop-=8;else if(drag.y>rect.bottom-40)drag.scroller.scrollTop+=8;
    if(before!==drag.scroller.scrollTop)update();drag.frame=requestAnimationFrame(tick);
  }
  function openOnHover(section){
    const heading=section.querySelector(':scope > .side-group-heading'),body=section.querySelector(':scope > .side-group-members');
    if(!body?.hidden){clearTimeout(drag.hoverTimer);drag.hoverSection=null;return;}
    if(drag.hoverSection===section)return;
    clearTimeout(drag.hoverTimer);drag.hoverSection=section;
    drag.hoverTimer=setTimeout(()=>{if(!drag?.started||drag.hoverSection!==section)return;body.hidden=false;heading?.setAttribute('aria-expanded','true');options.reveal(section.dataset.displaySection);update();},500);
  }
  function update(){
    if(!drag?.started)return;
    const {x,y}=drag;drag.ghost.style.left=x-drag.grabX+'px';drag.ghost.style.top=y-drag.grabY+'px';
    const bounds=drag.scroller.getBoundingClientRect();if(x<bounds.left||x>bounds.right||y<bounds.top||y>bounds.bottom){stopHover();clearTarget();return;}
    const hit=document.elementsFromPoint(x,y).find(element=>element.closest?.('#side .side-list'));
    if(!hit){stopHover();clearTarget();return;}
    if(drag.kind==='group'&&hit.closest('[data-sidebar-root-drop]')){
      const before=layout().groups.find(group=>group.parent===null&&group.id!==drag.source)?.id??null;
      stopHover();mark(hit.closest('[data-sidebar-root-drop]'),'inside',{kind:'group',id:drag.source,parent:null,before},'Move '+groupName(drag.source)+' to the top level');return;
    }
    const section=hit.closest('.side-display-group');if(!section){stopHover();clearTarget();return;}
    const id=section.dataset.displaySection,heading=section.querySelector(':scope > .side-group-heading');
    if(drag.kind==='group'){
      if(id===drag.source){stopHover();clearTarget();return;}
      const current=layout(),rect=heading.getBoundingClientRect(),target=current.groups.find(group=>group.id===id),inside=x>rect.left+20&&y>rect.top+rect.height*.22&&y<rect.bottom-rect.height*.22;
      let parent,before,kind,text;
      if(inside){parent=id;before=null;kind='inside';text='Nest '+groupName(drag.source)+' inside '+groupName(id);}
      else{parent=target.parent;const siblings=current.groups.filter(group=>group.parent===parent&&group.id!==drag.source),index=siblings.findIndex(group=>group.id===id),after=y>=rect.top+rect.height/2;before=after?siblings[index+1]?.id??null:id;kind=after?'after':'before';text='Move '+groupName(drag.source)+(after?' after ':' before ')+groupName(id);}
      const move={kind:'group',id:drag.source,parent,before};
      try{moveSidebarGroup(current,move);}catch(error){stopHover();mark(heading,'invalid',null,error.message);return;}
      mark(heading,kind,move,text);if(inside)openOnHover(section);else stopHover();return;
    }
    const moving=drag.block.map(item=>item.dataset.key),room=moving[0].startsWith('room:');
    if(room&&id!=='rooms'||!room&&id==='rooms'){stopHover();mark(heading,'invalid',null,room?'Group chats stay in Group chats':'Agents cannot be placed in Group chats');return;}
    openOnHover(section);
    const targetList=section.querySelector(':scope > .side-group-members'),all=options.items(),item=all.find(item=>item.key===moving[0]),parent=item?.parent&&all.some(other=>other.key===item.parent&&other.group===id)?item.parent:'';
    const peers=targetList.hidden?[]:rows(targetList).filter(row=>!moving.includes(row.dataset.key)&&(row.dataset.orderParent||'')===parent),anchor=peers.find(row=>y<row.getBoundingClientRect().top+row.getBoundingClientRect().height/2),before=anchor?.dataset.key??null;
    const marker=anchor||peers.at(-1)||heading,kind=anchor?'before':marker===heading?'inside':'after';
    mark(marker,kind,{kind:room?'rooms':'agents',ids:moving.map(key=>Number(key.split(':')[1])),group:id,before,moving},'Move '+drag.element.querySelector('.name')?.textContent+' to '+groupName(id));
  }
  function move(x,y){
    if(!drag)return;drag.x=x;drag.y=y;
    if(!drag.started){if(Math.hypot(x-drag.startX,y-drag.startY)<6)return;if(drag.touch){clearTimeout(drag.timer);drag=null;return;}start();}
    update();
  }
  function cleanup(){
    const previous=drag;if(!previous)return null;clearTimeout(previous.timer);clearTimeout(previous.hoverTimer);cancelAnimationFrame(previous.frame);clearTarget();
    previous.ghost?.remove();for(const item of previous.block||[])item.classList.remove('side-drag-source');
    document.body.classList.remove('reordering','reordering-group','reordering-agents');drag=null;return previous;
  }
  async function persist(target,source){
    if(busy||!target)return;busy=true;document.querySelector('#side')?.setAttribute('aria-busy','true');
    try{
      const order=[...new Set([...options.items().map(item=>item.key),...(options.state().sideOrder||[])])];
      if(target.kind==='group'){
        const expectedParent=layout().groups.find(group=>group.id===target.id).parent;
        await options.api('/api/sidebar/move',{method:'POST',body:{...target,expectedParent}});
      }else if(target.kind==='rooms'){
        await options.api('/api/side-order',{method:'PUT',body:{order:moveSidebarKeys(order,target.moving,target.before)}});
      }else{
        await options.api('/api/sidebar/move',{method:'POST',body:{kind:'agents',ids:target.ids,group:target.group,before:target.before,expectedGroup:source,order}});
      }
      await options.refresh();
      const reveal=target.kind==='group'?target.parent:target.group;if(reveal!==null)options.reveal(reveal);
      options.render();
      if(target.kind==='group')[...document.querySelectorAll('#side [data-display-group]')].find(element=>element.dataset.displayGroup===target.id)?.focus({preventScroll:true});
      announce('Sidebar move saved');
    }catch(error){options.toast(error.message);await options.refresh().catch(()=>{});}finally{busy=false;document.querySelector('#side')?.removeAttribute('aria-busy');}
  }
  function end(cancel=false){
    const target=drag?.target,source=drag?.source,previous=cleanup();if(!previous?.started)return;
    suppressClickUntil=Date.now()+400;options.render();if(!cancel&&target)return persist(target,source);
  }
  document.addEventListener('click',event=>{if(Date.now()<suppressClickUntil){event.stopPropagation();event.preventDefault();}},true);
  document.addEventListener('pointerdown',event=>{if(event.pointerType!=='mouse'||event.button!==0)return;suppressClickUntil=0;const item=event.target.closest('#side .side-list .side-item, #side .side-list .side-group-heading');if(item)begin(item,event.clientX,event.clientY,false);});
  document.addEventListener('pointermove',event=>{if(event.pointerType==='mouse'&&drag){move(event.clientX,event.clientY);if(drag?.started)event.preventDefault();}});
  document.addEventListener('pointerup',event=>{if(event.pointerType==='mouse')end();});
  document.addEventListener('touchstart',event=>{suppressClickUntil=0;const item=event.target.closest('#side .side-list .side-item, #side .side-list .side-group-heading');if(item&&event.touches.length===1)begin(item,event.touches[0].clientX,event.touches[0].clientY,true);},{passive:true});
  document.addEventListener('touchmove',event=>{if(!drag)return;if(event.touches.length!==1){end(true);return;}move(event.touches[0].clientX,event.touches[0].clientY);if(drag?.started)event.preventDefault();},{passive:false});
  document.addEventListener('touchend',()=>end());document.addEventListener('touchcancel',()=>end(true));
  document.addEventListener('contextmenu',event=>{if(drag?.touch)event.preventDefault();});window.addEventListener('blur',()=>end(true));
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&drag){event.preventDefault();end(true);return;}
    const heading=event.target.closest('#side [data-display-group]');if(!heading||!event.altKey||options.filtered()||busy||!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key))return;
    event.preventDefault();const current=layout(),id=heading.dataset.displayGroup,group=current.groups.find(group=>group.id===id),siblings=current.groups.filter(item=>item.parent===group.parent),index=siblings.findIndex(item=>item.id===id);
    let parent=group.parent,before=null;
    if(event.key==='ArrowUp'){if(index===0)return;before=siblings[index-1].id;}
    if(event.key==='ArrowDown'){if(index===siblings.length-1)return;before=siblings[index+2]?.id??null;}
    if(event.key==='ArrowRight'){if(index===0)return;parent=siblings[index-1].id;}
    if(event.key==='ArrowLeft'){if(parent===null)return;const owner=current.groups.find(item=>item.id===parent);parent=owner.parent;const peers=current.groups.filter(item=>item.parent===parent);before=peers[peers.findIndex(item=>item.id===owner.id)+1]?.id??null;}
    persist({kind:'group',id,parent,before});
  });
  return{get active(){return!!drag;}};
}

// Phone-only viewport policy; no click suppression or business actions.
export function canScroll(el, axis, delta) {
 const style=getComputedStyle(el);
 if(!/auto|scroll/.test(axis==='y'?style.overflowY:style.overflowX))return false;
 const pos=axis==='y'?el.scrollTop:el.scrollLeft;
 const max=axis==='y'?el.scrollHeight-el.clientHeight:el.scrollWidth-el.clientWidth;
 return max>1 && (delta>0?pos>0:pos<max-1);
}
export function installMobileInteractions(narrow) {
 let previous=null;
 const cancel=e=>{if(e.cancelable)e.preventDefault();};
 // Safari can ignore viewport metadata. CSS excludes double-tap zoom without
 // eating clicks; proprietary gesture cancellation supplements multi-touch.
 for(const type of ['gesturestart','gesturechange'])
  document.addEventListener(type,e=>{if(narrow.matches)cancel(e);},{passive:false,capture:true});
 document.addEventListener('touchstart',e=>{
  previous=e.touches.length===1?{x:e.touches[0].clientX,y:e.touches[0].clientY}:null;
 },{passive:true,capture:true});
 document.addEventListener('touchmove',e=>{
  if(!narrow.matches)return;
  if(e.touches.length!==1){previous=null;cancel(e);return;}
  const t=e.touches[0],old=previous;
  previous={x:t.clientX,y:t.clientY};
  if(!old || getSelection()?.toString())return;
  const dx=t.clientX-old.x,dy=t.clientY-old.y;
  if(!dx && !dy)return;
  const axis=Math.abs(dx)>Math.abs(dy)?'x':'y',delta=axis==='x'?dx:dy;
  if(e.target.closest('select,input[type=range],[role=slider]'))return;
  for(let el=e.target;el && el!==document.body;el=el.parentElement) {
   if(canScroll(el,axis,delta))return;
   const style=getComputedStyle(el);
   if(/auto|scroll/.test(axis==='y'?style.overflowY:style.overflowX) &&
      /contain|none/.test(axis==='y'?style.overscrollBehaviorY:style.overscrollBehaviorX))break;
  }
  cancel(e);
 },{passive:false,capture:true});
 for(const type of ['touchend','touchcancel'])
  document.addEventListener(type,()=>{previous=null;},{passive:true,capture:true});
 narrow.addEventListener('change',()=>{previous=null;});
}

// Full-height coordinate zones, without overlays or ancestor touch-action changes.
export function installPanelGestures({narrow,closeNavigation}) {
 let active=null,contact=false,released=null,pending=null,initial=null;
 const pointers=new Set();
 const zoomed=()=>Math.abs((window.visualViewport?.scale||1)-1)>.01;
 const reset=()=>{active=null;released=null;pending=null;initial=null;};
 const eligible=a=>{
  if(!narrow.matches || zoomed() || !a.host.isConnected || location.hash!==a.route || a.host.closest('[inert],.closing'))return false;
  const overlay=document.querySelector('#modal-root .scrim:not(.closing) .modal,body>.popover');
  if(a.kind==='sheet')return a.host.closest('.modal')===overlay && overlay.matches('[data-swipe-dismissible]:not(.sticky)') && !!overlay.querySelector('[data-close]:not(:disabled)');
  if(overlay)return false;
  if(a.kind==='left'||a.kind==='right')return document.querySelector(a.kind==='left'?'#side':'#aside')===a.host && a.host.classList.contains('open');
  return document.querySelector('#main')===a.host && !document.querySelector('#side.open,#aside.open');
 };
 function begin(target,x,y) {
  reset();
  const standalone=matchMedia('(display-mode: standalone)').matches || navigator.standalone===true;
  const edge=x<=56 || x>=innerWidth-56;
  if(!narrow.matches || zoomed() || getSelection()?.toString() || x<(standalone?0:24) || x>innerWidth-(standalone?0:24) || y>innerHeight-32 || target.closest('[inert],.closing'))return;
  for(let el=target;el && el!==document.body;el=el.parentElement) {
   if(el.matches('select,input[type=range],[role=slider],pre,table,[draggable=true]'))return;
   if(el.matches('input,textarea,[contenteditable]:not([contenteditable="false"])') && (!edge || el===document.activeElement || el.contains(document.activeElement)))return;
   if(el.scrollWidth>el.clientWidth+2 && /auto|scroll/.test(getComputedStyle(el).overflowX))return;
  }
  const overlay=document.querySelector('#modal-root .scrim:not(.closing) .modal,body>.popover');
  let kind,host;
  if(overlay) {
   host=target.closest('.modal[data-swipe-dismissible]:not(.sticky) > .modal-head');
   if(!host || host.closest('.modal')!==overlay || !overlay.querySelector('[data-close]:not(:disabled)'))return;
   kind='sheet';
  } else if((host=target.closest('#side.open')))kind='left';
  else if((host=target.closest('#aside.open')))kind='right';
  else if(!document.querySelector('#side.open,#aside.open')) {
   host=document.querySelector('#main');
   if(x<=56)kind='openLeft';else if(x>=innerWidth-56)kind='openRight';
  }
  if(kind)active={target,host,kind,x,y,route:location.hash,locked:false,start:performance.now()};
 }
 const measure=(a,x,y)=>{
  const dx=x-a.x,dy=y-a.y;
  return {along:a.kind==='sheet'?dy:['left','openRight'].includes(a.kind)?-dx:dx,across:a.kind==='sheet'?Math.abs(dx):Math.abs(dy)};
 };
 function move(x,y,e) {
  const a=active;if(!a)return;
  const m=measure(a,x,y);
  if(!eligible(a) || getSelection()?.toString() || performance.now()-a.start>650){active=null;return;}
  if(Math.max(Math.abs(x-a.x),Math.abs(y-a.y))<10)return;
  if(m.along<=0 || m.across>m.along/1.8){active=null;return;}
  if(!a.locked && a.pointerId!==undefined)try{a.host.setPointerCapture(a.pointerId);}catch{}
  a.locked=true;
  if(e?.cancelable)e.preventDefault();
 }
 function end(x,y,e) {
  const a=active;active=null;if(!a)return;
  const m=measure(a,x,y);
  if(!a.locked || m.along<48 || m.across>m.along/1.8 || zoomed() || performance.now()-a.start>650 || getSelection()?.toString() || !eligible(a))return;
  released=a.target;pending=a;
  if(e?.cancelable)e.preventDefault();
  requestAnimationFrame(()=>{
   if(pending!==a || !eligible(a))return;
   pending=null;
   if(a.kind==='openLeft')document.querySelector('#main [data-act="menu"]')?.click();
   else if(a.kind==='openRight')document.querySelector('[data-phone="activity"]')?.click();
   else if(a.kind==='sheet')a.host.closest('.modal')?.querySelector('[data-close]:not(:disabled)')?.click();
   else closeNavigation();
  });
 }
 document.addEventListener('touchstart',e=>{
  contact=true;
  if(e.touches.length!==1){reset();return;}
  const t=e.touches[0];
  if(initial && initial.target===e.target && initial.x===t.clientX && initial.y===t.clientY){initial=null;return;}
  begin(e.target,t.clientX,t.clientY);
 },{passive:true,capture:true});
 document.addEventListener('touchmove',e=>{
  if(e.touches.length!==1){reset();return;}
  const t=e.touches[0];move(t.clientX,t.clientY,e);
 },{passive:false,capture:true});
 document.addEventListener('touchend',e=>{
  contact=false;
  if(e.touches.length){reset();return;}
  const t=e.changedTouches[0];if(t)end(t.clientX,t.clientY,e);
  if(released && e.cancelable)e.preventDefault();
 },{passive:false,capture:true});
 document.addEventListener('pointerdown',e=>{
  pending=null;released=null;if(e.pointerType!=='touch'){active=null;return;}
  pointers.add(e.pointerId);
  if(pointers.size!==1){reset();return;}
  if(!contact){begin(e.target,e.clientX,e.clientY);initial={target:e.target,x:e.clientX,y:e.clientY};if(active)active.pointerId=e.pointerId;}
 },true);
 document.addEventListener('pointermove',e=>{if(e.pointerType==='touch')move(e.clientX,e.clientY);},{passive:true,capture:true});
 // Pointer completion is independent of touchend ordering, including Safari.
 document.addEventListener('pointerup',e=>{pointers.delete(e.pointerId);if(e.pointerType==='touch')end(e.clientX,e.clientY,e);},true);
 document.addEventListener('pointercancel',e=>{pointers.delete(e.pointerId);active=null;pending=null;},true);
 document.addEventListener('touchcancel',()=>{reset();contact=false;pointers.clear();},true);
 // Recognized contact only; any new pointer/touch contact clears suppression.
 document.addEventListener('click',e=>{
  if(released && e.isTrusted && e.detail>0 && (e.target===released || released.contains(e.target))) {
   released=null;e.preventDefault();e.stopImmediatePropagation();
  }
 },true);
 window.addEventListener('resize',reset);
 window.addEventListener('orientationchange',reset);
 window.visualViewport?.addEventListener('resize',reset);
}

// Cache only public branding, an offline notice and its reconnect helper. Authenticated pages, API
// state, uploads, instructions and connector data never enter the offline cache.
const CACHE='nimbus-public-v2';
const ASSETS=['/offline.html','/pwa.js','/icon.svg','/icon-192.png','/icon-512.png','/apple-touch-icon.png'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('nimbus-public-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==self.location.origin)return;
  if(request.mode==='navigate'){event.respondWith(fetch(request).catch(()=>caches.match('/offline.html')));return;}
  if(ASSETS.includes(url.pathname))event.respondWith(fetch(request).catch(()=>caches.match(url.pathname)));
});

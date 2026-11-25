// Login and offline pages use this public helper without an authenticated app
// shell. A protected shell import would redirect to HTML and prevent this
// module from registering the service worker or reconnect button at all.
if(document.getElementById('side')){
  import('./mobile-shell.js').then(({installMobileShell})=>installMobileShell())
    .catch(error=>console.warn('Nimbus mobile controls could not be loaded:',error.message));
}

if('serviceWorker' in navigator&&window.isSecureContext){
  navigator.serviceWorker.register('/sw.js').catch(error=>console.warn('Nimbus offline notice could not be registered:',error.message));
}
document.querySelector('[data-reconnect]')?.addEventListener('click',()=>location.reload());

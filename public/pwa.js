import { installMobileShell } from './mobile-shell.js';
installMobileShell();

if('serviceWorker' in navigator&&window.isSecureContext){
  navigator.serviceWorker.register('/sw.js').catch(error=>console.warn('Nimbus offline notice could not be registered:',error.message));
}
document.querySelector('[data-reconnect]')?.addEventListener('click',()=>location.reload());

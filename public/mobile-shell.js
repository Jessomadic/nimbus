import { installPanelGestures } from './panel-gestures.js';
import { installMobileInteractions } from './mobile-interactions.js';
// UI only: no auth, network or offline command queue.
export function installMobileShell() {
  const viewport = window.visualViewport;
  const size = () => {
    if (!viewport) return;
    // Convert the visible viewport back to layout CSS pixels. Pinch zoom must
    // not masquerade as a keyboard or freeze a previous keyboard-sized shell.
    const scale = viewport.scale || 1;
    const layoutHeight = Math.min(window.innerHeight, viewport.height * scale);
    document.documentElement.classList.toggle('phone-keyboard', window.innerHeight - layoutHeight > 100);
    document.documentElement.style.setProperty('--app-height', layoutHeight + 'px');
    // At pinch scale, let the browser pan the layout instead of chasing its
    // visual offset (which otherwise moves controls away from the user).
    document.documentElement.style.setProperty('--app-top', (Math.abs(scale - 1) < 0.02 ? viewport.offsetTop : 0) + 'px');
  };
  size();
  viewport?.addEventListener('resize', size);
  viewport?.addEventListener('scroll', size);
  window.addEventListener('resize', size);
  const side = document.getElementById('side');
  if (!side) return;
  const narrow = window.matchMedia('(max-width: 760px), (max-width: 960px) and (max-height: 500px) and (orientation: landscape)');
  const backdrop = document.createElement('button');
  backdrop.className = 'mobile-backdrop';
  backdrop.type = 'button';
  backdrop.setAttribute('aria-label', 'Close navigation');
  backdrop.tabIndex = -1;
  backdrop.hidden = true;
  side.before(backdrop);
  const aside = document.getElementById('aside');
  const main = document.getElementById('main');
  let activePanel = null, returnFocus = null;
  const controls = root => [...root.querySelectorAll('button, input, select, textarea, a[href], summary, [tabindex="0"]')]
    .filter(el => !el.disabled && el.getClientRects().length && !el.closest('[hidden], [inert]'));
  const sync = () => {
    const panel = narrow.matches ? (side.classList.contains('open') ? side : aside?.classList.contains('open') ? aside : null) : null;
    const menu = document.querySelector('[data-act="menu"]');
    menu?.setAttribute('aria-controls','side');
    menu?.setAttribute('aria-expanded',String(panel === side));
    side.inert = narrow.matches && panel !== side;
    if (aside) aside.inert = narrow.matches && panel !== aside;
    main.inert = !!panel || !!document.querySelector('#modal-root .scrim:not(.closing) .modal, body > .popover');
    backdrop.hidden = !panel;
    if (panel !== activePanel) {
      if (panel) { returnFocus = document.activeElement; controls(panel).find(el => !el.matches('input,textarea,select'))?.focus({preventScroll:true}); }
      else if (activePanel) returnFocus?.focus();
      activePanel = panel;
    }
    document.querySelectorAll('[data-phone]').forEach(button => {
      const expanded = (button.dataset.phone === 'activity' && panel === aside);
      button.removeAttribute('aria-current');
      if (button.dataset.phone === 'activity') { button.setAttribute('aria-expanded',String(expanded)); button.setAttribute('aria-controls','aside'); }
    });
  };
  const close = () => { side.classList.remove('open'); aside?.classList.remove('open'); sync(); };
  backdrop.addEventListener('click',close);
  document.addEventListener('keydown',event => {
    if (!activePanel) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key === 'Tab') {
      const list = controls(activePanel), first = list[0], last = list.at(-1);
      if (!first) return event.preventDefault();
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  for (const panel of [side,aside].filter(Boolean)) new MutationObserver(sync).observe(panel,{attributes:true,attributeFilter:['class']});
  new MutationObserver(sync).observe(main,{childList:true});
  narrow.addEventListener('change',() => { if (!narrow.matches) close(); sync(); });
  sync();
  // A persistent phone destination bar uses the existing application actions.
  const dock = document.createElement('nav');
  dock.className = 'phone-dock';
  dock.setAttribute('aria-label', 'Phone navigation');
  dock.innerHTML = '<button type="button" data-phone="team"><svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 6h18M3 12h18M3 18h18"/></svg>Team</button><button type="button" data-phone="activity"><svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>Activity</button><button type="button" data-phone="settings"><svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 7h16M4 17h16M9 4v6m6 4v6"/></svg>Settings</button>';
  // Unique mobile selectors are forwarded by the shared application dispatcher.
  const mount = () => {
    const composer = document.querySelector('.composer');
    const host = composer || document.getElementById('main');
    if (dock.parentElement !== host) host.append(dock);
    const actions = document.querySelector('.head .actions');
    if (actions && !actions.querySelector('.phone-context')) {
      const details = document.createElement('details');
      details.className = 'phone-context';
      details.open = !narrow.matches;
      details.innerHTML = '<summary aria-label="Conversation actions"><svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/></svg></summary><div class="phone-context-items"></div>';
      [...actions.querySelectorAll(':scope > .icon-btn')].forEach(button => details.lastElementChild.append(button));
      actions.append(details);
      details.lastElementChild.addEventListener('click', () => { details.open = false; });
    }
    sync();
  };
  new MutationObserver(mount).observe(document.getElementById('main'), {childList:true});
  for (const panel of [side, document.getElementById('aside')]) new MutationObserver(mount).observe(panel, {attributes:true, attributeFilter:['class']});
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') document.querySelectorAll('.phone-context[open]').forEach(el => { el.open = false; el.querySelector('summary').focus(); });
  });
  dock.addEventListener('click', event => {
    const button = event.target.closest('[data-phone]');
    if (!button) return;
    close();
    document.getElementById('aside')?.classList.remove('open');
    mount();
  });
  narrow.addEventListener('change', () => { const details = document.querySelector('.phone-context'); if (details) details.open = !narrow.matches; mount(); });
  mount();
  installPanelGestures({ narrow, closeNavigation: close });
  installMobileInteractions(narrow);
  // Own transient phone overlays as well as drawers. Business actions remain in app.js.
  let overlay = null, overlayTrigger = null, lastTrigger = null;
  document.addEventListener('click', event => {
    const trigger = event.target.closest('button, summary');
    if (trigger && !trigger.closest('.modal, .popover')) lastTrigger = trigger.closest('.phone-context-items')?.parentElement.querySelector('summary') || trigger;
  }, true);
  const syncOverlay = () => {
    const next = document.querySelector('#modal-root .scrim:not(.closing) .modal, body > .popover');
    sync();
    if (next === overlay) return;
    if (next) {
      if (!overlay) overlayTrigger = lastTrigger || document.activeElement;
      overlay = next;
      main.inert = true; side.inert = true; if (aside) aside.inert = true;
      if (next.classList.contains('popover')) { next.setAttribute('role','dialog'); next.setAttribute('aria-label','Account settings'); }
      if (!next.contains(document.activeElement)) controls(next).find(el => !el.matches('input,textarea,select'))?.focus({preventScroll:true});
    } else {
      overlay = null; sync();
      if (overlayTrigger?.isConnected && overlayTrigger.getClientRects().length && !overlayTrigger.closest('[inert]')) overlayTrigger.focus();
      overlayTrigger = null;
    }
  };
  new MutationObserver(syncOverlay).observe(document.body,{childList:true,subtree:true});
  new MutationObserver(syncOverlay).observe(document.getElementById('modal-root'),{attributes:true,subtree:true,attributeFilter:['class']});
  document.addEventListener('keydown',event => {
    if (!overlay || !narrow.matches) return;
    if (event.key === 'Escape') {
      const closeButton = overlay.querySelector('[data-close]');
      if (closeButton) closeButton.click();
      else overlay.remove();
      event.preventDefault();
    }
    if (event.key === 'Tab') {
      const list = controls(overlay), first = list[0], last = list.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
}

// UI only: no auth, network or offline command queue.
export function installMobileShell() {
  const viewport = window.visualViewport;
  const size = () => {
    if (viewport && viewport.scale === 1) {
      document.documentElement.style.setProperty('--app-height', viewport.height + 'px');
      document.documentElement.style.setProperty('--app-top', viewport.offsetTop + 'px');
    }
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
  let wasOpen = false;
  const sync = () => {
    const open = narrow.matches && side.classList.contains('open');
    const menu = document.querySelector('[data-act="menu"]');
    menu?.setAttribute('aria-controls', 'side');
    menu?.setAttribute('aria-expanded', String(open));
    side.inert = narrow.matches && !open;
    backdrop.hidden = !open;
    document.getElementById('main').inert = open;
    const aside = document.getElementById('aside');
    if (aside) aside.inert = open;
    if (open && !wasOpen) side.querySelector('input, button, a[href]')?.focus();
    else if (!open && wasOpen && side.contains(document.activeElement)) menu?.focus();
    wasOpen = open;
  };
  const close = () => { side.classList.remove('open'); sync(); };
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', event => {
    if (!wasOpen) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key === 'Tab') {
      const controls = [...side.querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"]')]
        .filter(el => !el.disabled && el.getClientRects().length && !el.closest('[hidden], [inert]'));
      const first = controls[0], last = controls.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  new MutationObserver(sync).observe(side, { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(sync).observe(document.getElementById('main'), { childList: true });
  narrow.addEventListener('change', () => { if (!narrow.matches) side.classList.remove('open'); sync(); });
  sync();
}

let browserLibrary;

export async function passkeyRequest(url, { method = 'POST', body } = {}) {
  const response = await fetch(url, {
    method, credentials: 'same-origin', cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.error || 'The passkey request could not be completed.');
    error.status = response.status;
    error.restart = Boolean(data?.restart);
    throw error;
  }
  if (!data || typeof data !== 'object') throw new Error('Nimbus returned an incomplete response. Try again.');
  return data;
}

export function canonicalPasskeyOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.origin : null;
  } catch { return null; }
}

export function requirePasskeyOrigin(value) {
  const origin = canonicalPasskeyOrigin(value);
  if (!origin) throw new Error('The passkey sign-in address is unavailable. Contact the Nimbus owner.');
  if (location.origin !== origin) {
    const error = new Error('Open Nimbus at its passkey sign-in address to continue.');
    error.origin = origin;
    throw error;
  }
  if (!globalThis.isSecureContext || !globalThis.PublicKeyCredential || !navigator.credentials) {
    throw new Error('This browser cannot use passkeys here. Open the Nimbus sign-in address in a browser that supports passkeys.');
  }
  return origin;
}

function loadBrowserLibrary() {
  if (globalThis.SimpleWebAuthnBrowser) return Promise.resolve(globalThis.SimpleWebAuthnBrowser);
  if (!browserLibrary) {
    browserLibrary = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/vendor/simplewebauthn-browser.js';
      script.onload = () => {
        if (globalThis.SimpleWebAuthnBrowser) resolve(globalThis.SimpleWebAuthnBrowser);
        else { script.remove(); reject(new Error('The local passkey library did not load. Try again.')); }
      };
      script.onerror = () => { script.remove(); reject(new Error('The local passkey library could not be loaded. Try again.')); };
      document.head.append(script);
    }).catch(error => { browserLibrary = null; throw error; });
  }
  return browserLibrary;
}

// Called only after the user submits their credentials or retries a ceremony.
// Loading this module alone never opens a passkey prompt.
export async function performPasskey({ ticket, registration = false, label = '', origin }) {
  requirePasskeyOrigin(origin);
  if (typeof ticket !== 'string' || !ticket) throw new Error('Sign-in expired. Restart sign-in.');
  const browser = await loadBrowserLibrary();
  const ceremony = registration ? 'registration' : 'authentication';
  const options = await passkeyRequest(`/api/passkeys/${ceremony}/options`, { body: { ticket } });
  const optionsJSON = options.optionsJSON || options;
  const response = registration
    ? await browser.startRegistration({ optionsJSON })
    : await browser.startAuthentication({ optionsJSON });
  return passkeyRequest(`/api/passkeys/${ceremony}/verify`, {
    body: { ticket, response, ...(registration && label ? { label } : {}) },
  });
}

export function passkeyError(error, { signIn = true } = {}) {
  if (error?.name === 'NotAllowedError' || error?.name === 'AbortError' || error?.code === 'ERROR_CEREMONY_ABORTED') {
    return signIn ? 'The passkey prompt was cancelled or timed out. Sign-in is incomplete. Try again or restart sign-in.' : 'The passkey prompt was cancelled or timed out. No passkey was added. Try again when you are ready.';
  }
  if (error?.name === 'InvalidStateError' || error?.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') {
    return 'That passkey is already registered. Choose another passkey or device.';
  }
  if (error?.name === 'SecurityError') return 'The passkey could not be used at this address. Open the Nimbus passkey sign-in address and try again.';
  return error?.message || 'The passkey request could not be completed. Try again.';
}

function initializeLogin(form) {
  // Keep the owner enrollment secret in this closure only. Remove it from the
  // address bar before any asynchronous configuration or ceremony request.
  const address = new URL(location.href);
  const enrollmentToken = address.searchParams.get('enroll') || undefined;
  if (address.searchParams.has('enroll')) {
    address.searchParams.delete('enroll');
    history.replaceState(history.state, '', address.pathname + address.search + address.hash);
  }
  const $ = id => document.getElementById(id);
  const errorBox = $('err');
  if (address.searchParams.get('error')) errorBox.textContent = address.searchParams.get('error');
  let methods = null, mode = 'signin', mfaTicket = null, passkeyTicket = null, enrolling = false, busy = false, restartRequired = false;

  function passwordView() {
    const wrongOrigin = methods?.passkeyRequired && canonicalPasskeyOrigin(methods.passkeyOrigin) !== location.origin;
    if (wrongOrigin) { for (const id of ['userbox', 'acct', 'pwbox']) $(id).hidden = true; return; }
    $('userbox').hidden = !methods?.username;
    $('acct').hidden = Boolean(methods?.username) || !methods?.accounts;
    $('pwbox').hidden = Boolean(methods?.username || methods?.accounts) || !methods?.password;
  }
  function busyState(value) {
    busy = value;
    for (const button of form.querySelectorAll('button')) button.disabled = value;
    $('passkey-go').disabled = value || restartRequired;
    form.setAttribute('aria-busy', String(value));
  }
  function setMode(value) {
    mode = value;
    form.querySelectorAll('[data-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === value)));
    $('confirm-wrap').hidden = value !== 'signup';
    $('acct-go').textContent = value === 'signup' ? 'Create account' : 'Sign in';
    $('apw').autocomplete = value === 'signup' ? 'new-password' : 'current-password';
    errorBox.textContent = '';
  }
  function originNotice(value) {
    const origin = canonicalPasskeyOrigin(value);
    const wrong = !origin || location.origin !== origin;
    $('origin-notice').hidden = !wrong;
    $('origin-link').hidden = !origin;
    if (origin) { $('origin-link').href = origin; $('origin-link').textContent = origin; }
    return wrong;
  }
  function restart() {
    mfaTicket = null; passkeyTicket = null; restartRequired = false;
    $('mfabox').hidden = true; $('passkeybox').hidden = true;
    $('code').value = '';
    for (const field of form.querySelectorAll('input[type="password"]')) field.value = '';
    passwordView();
    errorBox.textContent = '';
    busyState(false);
    (methods?.username ? $('username') : methods?.accounts ? $('email') : $('pw')).focus();
  }
  function showMfa(ticket) {
    if (typeof ticket !== 'string' || !ticket) throw new Error('Sign-in could not continue. Restart sign-in.');
    mfaTicket = ticket; passkeyTicket = null;
    for (const id of ['userbox', 'acct', 'pwbox', 'passkeybox']) $(id).hidden = true;
    $('mfabox').hidden = false; $('code').value = ''; $('code').focus();
  }
  function showPasskey(data) {
    if (typeof data.ticket !== 'string' || !data.ticket) throw new Error('Sign-in could not continue. Restart sign-in.');
    passkeyTicket = data.ticket; mfaTicket = null; enrolling = Boolean(data.enrollmentRequired); restartRequired = false;
    for (const id of ['userbox', 'acct', 'pwbox', 'mfabox']) $(id).hidden = true;
    for (const field of form.querySelectorAll('input[type="password"]')) field.value = '';
    $('passkey-title').textContent = enrolling ? 'Create your Nimbus passkey' : 'Verify your Nimbus passkey';
    $('passkey-help').textContent = enrolling
      ? 'Your password was accepted. Create a passkey on your device or security key to finish signing in. Future sign-ins require your password and a passkey.'
      : 'Your password was accepted. Use your device or security key to finish signing in.';
    $('passkey-go').textContent = enrolling ? 'Create passkey' : 'Verify passkey';
    $('passkey-label-wrap').hidden = !enrolling;
    $('passkeybox').hidden = false;
    if (originNotice(methods?.passkeyOrigin)) {
      restartRequired = true;
      errorBox.textContent = 'Use the Nimbus passkey sign-in address to continue.';
    }
  }
  async function completePasskey() {
    await performPasskey({ ticket: passkeyTicket, registration: enrolling, label: $('passkey-label').value.trim(), origin: methods.passkeyOrigin });
    location.assign('/');
  }
  function showPasskeyError(error) {
    restartRequired = Boolean(error.restart || [400, 401, 410].includes(error.status));
    errorBox.textContent = passkeyError(error) + (restartRequired ? ' Restart sign-in to continue.' : '');
  }
  async function advance(data) {
    if (data.passkeyRequired) {
      showPasskey(data);
      // Password submission is the user's request to sign in. Start the native
      // device ceremony directly, retaining the button for cancel/gesture retry.
      if (!restartRequired) await completePasskey();
      return;
    }
    if (data.mfa) return showMfa(data.ticket);
    if (methods?.passkeyRequired) throw new Error('Passkey verification is required. Restart sign-in.');
    location.assign('/');
  }

  form.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode)));
  $('mfa-back').addEventListener('click', restart);
  $('passkey-restart').addEventListener('click', restart);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !methods || passkeyTicket) return;
    errorBox.textContent = '';
    let url = '/api/login', payload;
    if (mfaTicket) { payload = { ticket: mfaTicket, code: $('code').value }; url = '/api/login/mfa'; }
    else if (methods.username) payload = { username: $('username').value.trim(), password: $('upw').value, ...(enrollmentToken ? { enrollmentToken } : {}) };
    else if (methods.accounts) {
      payload = { email: $('email').value, password: $('apw').value };
      if (mode === 'signup') {
        if ($('apw').value !== $('apw2').value) { errorBox.textContent = 'Passwords don’t match'; return; }
        url = '/api/signup';
      }
    } else payload = { password: $('pw').value };
    busyState(true);
    try { await advance(await passkeyRequest(url, { body: payload })); }
    catch (error) {
      if (passkeyTicket) showPasskeyError(error);
      else {
        if (error.restart) restart();
        errorBox.textContent = error.message;
      }
    } finally { busyState(false); }
  });
  $('passkey-go').addEventListener('click', async () => {
    if (busy || !passkeyTicket || restartRequired) return;
    busyState(true); errorBox.textContent = '';
    try {
      await completePasskey();
    } catch (error) {
      showPasskeyError(error);
    } finally { busyState(false); }
  });
  busyState(true);
  passkeyRequest('/api/auth-methods', { method: 'GET' }).then(data => {
    methods = data;
    form.querySelector('[data-mode="signup"]').hidden = !data.signup;
    $('signin-help').textContent = data.passkeyRequired ? 'Sign in with your username and password, then verify your passkey.' : 'Sign in to your Nimbus team.';
    passwordView();
    if (data.passkeyRequired && originNotice(data.passkeyOrigin)) {
      for (const id of ['userbox', 'acct', 'pwbox']) $(id).hidden = true;
    }
  }).catch(error => { errorBox.textContent = error.message; }).finally(() => busyState(false));
}

const loginForm = document.querySelector('[data-nimbus-login]');
if (loginForm) initializeLogin(loginForm);

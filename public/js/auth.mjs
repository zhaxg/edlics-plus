// auth.mjs — Login gate: shows password overlay until /api/login succeeds

import { api } from './api.mjs';

let onAuthenticated = null;
let overlay = null;

export function showLogin() {
  if (!overlay) return;
  overlay.classList.remove('hidden');
  setTimeout(() => {
    const input = document.getElementById('loginPassword');
    if (input) { input.value = ''; input.focus(); }
  }, 50);
}

export function hideLogin() {
  if (overlay) overlay.classList.add('hidden');
}

function login(password) {
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  return api('POST', '/api/login', { password }).then(data => {
    if (data.error) { errEl.textContent = data.error; return false; }
    hideLogin();
    if (onAuthenticated) onAuthenticated();
    return true;
  }).catch(e => { errEl.textContent = e.message || 'Login failed'; return false; });
}

// Resolves true if a session already exists, otherwise shows the login overlay.
export function initAuth(then) {
  onAuthenticated = then;
  overlay = document.getElementById('loginOverlay');
  const input = document.getElementById('loginPassword');
  const btn = document.getElementById('loginBtn');

  btn.onclick = () => login(input.value);
  input.onkeydown = e => { if (e.key === 'Enter') login(input.value); };

  return api('GET', '/api/session').then(data => {
    if (data && data.authenticated) { if (then) then(); return true; }
    showLogin();
    return false;
  }).catch(() => { showLogin(); return false; });
}

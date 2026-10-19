// auth.mjs — Login gate: shows password overlay until /api/login succeeds

import { api } from './api.mjs';

let onAuthenticated = null;
let overlay = null;
let totpRequired = false;

export function showLogin() {
  if (!overlay) return;
  overlay.classList.remove('hidden');
  document.body.classList.add('logged-out');   // hide the app → login is its own page
  const wrap = document.getElementById('loginTotp');
  if (wrap) wrap.style.display = totpRequired ? 'block' : 'none';
  setTimeout(() => {
    const input = document.getElementById('loginPassword');
    if (input) { input.value = ''; input.focus(); }
    const t = document.getElementById('loginTotp');
    if (t) t.value = '';
  }, 50);
}

export function hideLogin() {
  if (overlay) overlay.classList.add('hidden');
  document.body.classList.remove('logged-out');
}

/** Sign out and return to the login page. */
export async function logout() {
  try { await fetch('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
  location.reload();
}

function login(password, code) {
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  const body = { password };
  if (code) body.totp = code;
  return api('POST', '/api/login', body).then(data => {
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
  const totpInput = document.getElementById('loginTotp');
  const btn = document.getElementById('loginBtn');

  const submit = () => login(input.value, totpInput ? totpInput.value.trim() : '');
  btn.onclick = submit;
  input.onkeydown = e => { if (e.key === 'Enter') submit(); };
  if (totpInput) totpInput.onkeydown = e => { if (e.key === 'Enter') submit(); };

  return api('GET', '/api/session').then(data => {
    if (data && data.totp) totpRequired = true;
    if (data && data.authenticated) { hideLogin(); if (then) then(); return true; }
    showLogin();
    return false;
  }).catch(() => { showLogin(); return false; });
}

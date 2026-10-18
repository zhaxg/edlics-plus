// totp.js — RFC 6238 TOTP, hand-rolled on node:crypto (no dependency).
//
// Used as the second factor at login when a secret is enrolled. This is the
// single most effective anti-brute-force control for a root-grade panel:
// guessing a password is useless without the 30-second code.
const crypto = require('crypto');

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30;   // seconds
const DIGITS = 6;

/** RFC 4648 base32 (no padding) → Buffer. */
function base32Decode(input) {
  const s = String(input || '').replace(/=+$/g, '').toUpperCase().replace(/\s+/g, '');
  let bits = 0, val = 0;
  const out = [];
  for (const ch of s) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) continue;
    val = (val << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

/** RFC 4648 base32 encode (no padding). */
function base32Encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) {
    val = (val << 8) | b;
    bits += 8;
    while (bits >= 5) { out += BASE32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += BASE32[(val << (5 - bits)) & 31];
  return out;
}

/** Random base32 secret (default 20 bytes = 160 bits, as recommended). */
function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

/** HMAC-based one-time password for a given counter. */
function hotp(keyBuffer, counter, digits = DIGITS) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', keyBuffer).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(code % 10 ** digits).padStart(digits, '0');
}

/** TOTP code for a secret at time `nowMs`. */
function totp(secret, nowMs = Date.now(), digits = DIGITS) {
  return hotp(base32Decode(secret), Math.floor(nowMs / 1000 / STEP), digits);
}

/** Constant-time string compare. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Verify a submitted code within ±`window` steps (clock skew tolerance).
 * @param {string} secret
 * @param {string} code
 * @param {number} [window]
 * @param {number} [nowMs]
 */
function verify(secret, code, window = 1, nowMs = Date.now()) {
  if (!secret || !/^\d{6,8}$/.test(String(code || '').trim())) return false;
  const counter = Math.floor(nowMs / 1000 / STEP);
  const given = String(code).trim();
  for (let i = -window; i <= window; i++) {
    if (safeEqual(hotp(base32Decode(secret), counter + i), given)) return true;
  }
  return false;
}

/** otpauth:// URI for authenticator apps (manual entry / QR encoders). */
function otpauthUrl(secret, account = 'admin', issuer = 'Edlics') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;
}

module.exports = { generateSecret, base32Decode, base32Encode, hotp, totp, verify, otpauthUrl, STEP, DIGITS };

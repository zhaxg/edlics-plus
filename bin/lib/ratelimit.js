// ratelimit.js — small sliding-window limiter for expensive endpoints.
//
// Keyed by client IP. Bounded: prunes expired keys so a long-running server
// can't grow the map without limit (CLAUDE.md long-running invariant).
function createLimiter({ windowMs, max, maxKeys = 5000 }) {
  const hits = new Map(); // key -> number[] (epoch ms)
  let lastSweep = 0;

  function sweep(now) {
    if (now - lastSweep < windowMs) return;
    lastSweep = now;
    for (const [k, arr] of hits) {
      const fresh = arr.filter(t => now - t < windowMs);
      if (fresh.length) hits.set(k, fresh); else hits.delete(k);
    }
    if (hits.size > maxKeys) hits.clear(); // pathological load → reset
  }

  /**
   * @param {string} key
   * @returns {{allowed:boolean, retryAfter:number}}
   */
  function check(key) {
    const now = Date.now();
    sweep(now);
    const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) {
      const retryAfter = Math.ceil((windowMs - (now - arr[0])) / 1000);
      hits.set(key, arr);
      return { allowed: false, retryAfter: Math.max(1, retryAfter) };
    }
    arr.push(now);
    hits.set(key, arr);
    return { allowed: true, retryAfter: 0 };
  }

  return { check, _hits: hits };
}

module.exports = { createLimiter };

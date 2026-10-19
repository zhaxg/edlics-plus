// http-body.js — bounded JSON body reader.
//
// Every handler that reads a request body must go through this. `readJsonBody`
// has no limit, so a client can stream unbounded data into memory; with a
// session cookie that is a one-request OOM. Two ceilings apply:
//
//   * Content-Length — rejected up front with 413 (cheap, no buffering)
//   * streamed bytes — the stream is destroyed as soon as the cap is crossed,
//     which covers chunked requests that lie about (or omit) Content-Length
//
// Chars are not bytes: a UTF-8 file of N bytes may decode to fewer string
// units, so the byte cap is what protects memory. The string is measured too,
// so an all-multi-byte payload cannot grow past the limit unbounded.

const DEFAULT_MAX = 8 * 1024 * 1024;   // JSON envelopes (paths, options)
const FILE_MAX = 32 * 1024 * 1024;     // file write/create contents

/**
 * Read a request body as JSON.
 * @param {import('http').IncomingMessage} req
 * @param {number} [max] byte cap
 * @returns {Promise<any>} parsed JSON (rejects with a `.status` code on failure)
 */
function readJsonBody(req, max = DEFAULT_MAX) {
  return new Promise((resolve, reject) => {
    const fail = (status, message) => {
      const err = new Error(message);
      err.status = status;
      reject(err);
    };

    const declared = parseInt(req.headers['content-length'], 10);
    if (Number.isFinite(declared) && declared > max) {
      req.resume();                      // drain so the socket can close cleanly
      return fail(413, `Request body too large (limit ${max} bytes)`);
    }

    let body = '';
    let bytes = 0;
    let done = false;
    req.setEncoding('utf8');

    const overflow = () => {
      if (done) return;
      done = true;
      body = '';
      // Answer before hanging up: destroying the request immediately would
      // take the socket down with it and the client would only see a reset.
      // `res` is optional so pure unit tests need no socket.
      if (req.res && !req.res.headersSent) {
        try {
          req.res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' });
          req.res.end(JSON.stringify({ error: `Request body too large (limit ${max} bytes)` }));
        } catch { /* socket already gone */ }
      }
      req.unpipe?.();
      // Drain-and-discard, then close: stops reading user data entirely while
      // still letting the response flush.
      req.resume();
      setTimeout(() => { try { req.destroy(); } catch { /* noop */ } }, 250).unref?.();
      fail(413, `Request body too large (limit ${max} bytes)`);
    };

    req.on('data', chunk => {
      if (done) return;
      bytes += Buffer.byteLength(chunk, 'utf8');
      body += chunk;
      if (bytes > max || body.length > max) overflow();
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try { resolve(JSON.parse(body)); } catch { fail(400, 'Invalid JSON'); }
    });
    req.on('error', err => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

/**
 * Run `fn(data)` with the parsed body, replying through the ctx ok/fail pair.
 * Keeps the handlers compact and guarantees one error style.
 * @param {object} ctx request context (req, ok, fail)
 * @param {(data:any) => any} fn
 * @param {number} [max]
 */
function withJsonBody(ctx, fn, max = DEFAULT_MAX) {
  return readJsonBody(ctx.req, max).then(fn).catch(err => {
    ctx.fail(err.message || 'Bad request', err.status || 400);
  });
}

module.exports = { readJsonBody, withJsonBody, DEFAULT_MAX, FILE_MAX };

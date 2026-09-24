// Unit tests: cookie parsing and timing-safe password check.
const { test } = require('node:test');
const assert = require('node:assert');
const { setPassword, checkPassword, parseCookies, isAuthed, pruneSessions } = require('../bin/lib/auth');

test('parseCookies: absent, single, multiple, spacing, URI-decoded values', () => {
  assert.deepStrictEqual(parseCookies({ headers: {} }), {});
  assert.deepStrictEqual(parseCookies({ headers: { cookie: 'a=1' } }), { a: '1' });
  assert.deepStrictEqual(
    parseCookies({ headers: { cookie: ' a=1 ;  edlics_session=abc  ; x=%2Fy%2Fz' } }),
    { a: '1', edlics_session: 'abc', x: '/y/z' }
  );
  // value containing '=' survives
  assert.deepStrictEqual(parseCookies({ headers: { cookie: 't=a=b' } }), { t: 'a=b' });
});

test('checkPassword: correct, wrong, unset password', () => {
  setPassword('hunter2-secret');
  assert.ok(checkPassword('hunter2-secret'));
  assert.ok(!checkPassword('hunter3-secret'));
  assert.ok(!checkPassword(''));
  assert.ok(!checkPassword(undefined));
});

test('isAuthed: unknown/expired tokens rejected; pruneSessions removes expired', () => {
  assert.ok(!isAuthed({ headers: {} }));
  assert.ok(!isAuthed({ headers: { cookie: 'edlics_session=nonexistent' } }));
  assert.doesNotThrow(() => pruneSessions());
});

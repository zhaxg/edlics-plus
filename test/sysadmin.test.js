// Unit tests: users/groups/sessions, crontab, docker/compose parsers (pure).
const { test } = require('node:test');
const assert = require('node:assert');
const users = require('../bin/lib/users-api');
const cron = require('../bin/lib/cron-api');
const containers = require('../bin/lib/container-api');

test('parsePasswd: fields, uid<1000 → system', () => {
  const u = users.parsePasswd('root:x:0:0:root:/root:/bin/bash\nalice:x:1001:1001:Alice,,,:/home/alice:/bin/sh\n');
  assert.strictEqual(u.length, 2);
  assert.strictEqual(u[0].name, 'root');
  assert.strictEqual(u[0].system, true);
  assert.strictEqual(u[0].gecos, 'root');
  assert.strictEqual(u[1].system, false);
  assert.strictEqual(u[1].home, '/home/alice');
});

test('parseGroup + decorateUsers: primary group name and memberships', () => {
  const g = users.parseGroup('root:x:0:\nsudo:x:27:alice,bob\nalice:x:1001:\n');
  assert.strictEqual(g.length, 3);
  assert.deepStrictEqual(g[1].members, ['alice', 'bob']);
  const p = users.parsePasswd('alice:x:1001:1001::/home/alice:/bin/sh\ncarol:x:1002:1002::/home/carol:/bin/sh\n');
  const d = users.decorateUsers(p, g);
  assert.strictEqual(d[0].group, 'alice');
  assert.deepStrictEqual(d[0].groups, ['sudo']);
  assert.deepStrictEqual(d[1].groups, []);
});

test('parseWho: user/tty/from, tolerant of extra columns', () => {
  const w = users.parseWho('root     pts/0        2024-01-02 03:04 (10.0.0.9)\n');
  assert.strictEqual(w[0].user, 'root');
  assert.strictEqual(w[0].tty, 'pts/0');
  assert.strictEqual(w[0].from, '10.0.0.9');
  assert.strictEqual(w[0].since, '2024-01-02 03:04');
  // this host prints an extra login-type column before the tty
  const w2 = users.parseWho('root     sshd pts/1   2026-10-18 22:16 (192.168.132.68)\n');
  assert.strictEqual(w2[0].tty, 'pts/1');
  assert.strictEqual(w2[0].since, '2026-10-18 22:16');
});

test('parseCrontab: user crontab, system crontab (user field), @specials, env lines', () => {
  const userTab = 'SHELL=/bin/bash\n# comment\n*/5 * * * * /usr/bin/backup.sh\n@reboot /opt/start.sh\n';
  const uj = cron.parseCrontab(userTab, false);
  assert.strictEqual(uj.length, 2);
  assert.strictEqual(uj[0].schedule, '*/5 * * * *');
  assert.strictEqual(uj[0].command, '/usr/bin/backup.sh');
  assert.strictEqual(uj[0].user, null);
  assert.strictEqual(uj[1].schedule, '@reboot');

  const sysTab = '17 * * * * root cd / && run-parts --report /etc/cron.hourly\n';
  const sj = cron.parseCrontab(sysTab, true);
  assert.strictEqual(sj[0].user, 'root');
  assert.ok(sj[0].command.startsWith('cd /'));
});

test('parseTimers: maps unit/next/activates, tolerates bad JSON', () => {
  const t = cron.parseTimers(JSON.stringify([{ unit: 'logrotate.timer', next: 'x', activates: 'logrotate.service' }]));
  assert.strictEqual(t[0].unit, 'logrotate.timer');
  assert.strictEqual(t[0].activates, 'logrotate.service');
  assert.deepStrictEqual(cron.parseTimers('nope'), []);
});

test('parseDockerPs / parseComposeLs / parseDockerStats', () => {
  const ps = JSON.stringify({ ID: 'abc123', Names: 'web', Image: 'nginx', State: 'running', Status: 'Up 2h', Ports: '80/tcp', CreatedAt: 'now' }) + '\n';
  const c = containers.parseDockerPs(ps);
  assert.strictEqual(c[0].name, 'web');
  assert.strictEqual(c[0].state, 'running');

  const ls = JSON.stringify([{ Name: 'proj', Status: 'running(2)', ConfigFiles: '/srv/proj/docker-compose.yml' }]);
  assert.strictEqual(containers.parseComposeLs(ls)[0].name, 'proj');

  const st = JSON.stringify({ ID: 'abc', Name: 'web', CPUPerc: '1.2%', MemUsage: '10MiB / 1GiB', MemPerc: '1%', NetIO: '0B / 0B', BlockIO: '0B / 0B', PIDs: '5' }) + '\n';
  assert.strictEqual(containers.parseDockerStats(st)[0].cpu, '1.2%');
});

test('isValidContainerRef: hex id or safe name, rejects odd input', () => {
  assert.ok(containers.isValidContainerRef('a1b2c3d4e5f6'));
  assert.ok(containers.isValidContainerRef('my-web_1'));
  assert.ok(!containers.isValidContainerRef('../../etc'));
  assert.ok(!containers.isValidContainerRef('--privileged'));
  assert.ok(!containers.isValidContainerRef('a b'));
  assert.ok(!containers.isValidContainerRef('x'.repeat(200)));
});

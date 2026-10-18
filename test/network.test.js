// Unit tests: network output parsers (ip -j / ip / ss -j / ss / resolv.conf / nft -j).
const { test } = require('node:test');
const assert = require('node:assert');
const n = require('../bin/lib/network-api');

test('parseIpAddr: interface, state, mac and family-split addresses', () => {
  const json = JSON.stringify([
    { ifname: 'eth0', operstate: 'UP', address: 'aa:bb:cc:dd:ee:ff', mtu: 1500,
      addr_info: [
        { family: 'inet', local: '10.0.0.5', prefixlen: 24 },
        { family: 'inet6', local: 'fe80::1', prefixlen: 64 },
      ] },
    { ifname: 'lo', operstate: 'UNKNOWN', address: '00:00:00:00:00:00', mtu: 65536, addr_info: [{ family: 'inet', local: '127.0.0.1', prefixlen: 8 }] },
  ]);
  const out = n.parseIpAddr(json);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].name, 'eth0');
  assert.strictEqual(out[0].state, 'UP');
  assert.deepStrictEqual(out[0].v4, ['10.0.0.5']);
  assert.deepStrictEqual(out[0].v6, ['fe80::1']);
  assert.deepStrictEqual(n.parseIpAddr('nope'), []);
});

test('parseRoutes: JSON form and text fallback agree', () => {
  const json = JSON.stringify([{ dst: 'default', gateway: '192.168.1.1', dev: 'eth0', metric: 100 }]);
  const r = n.parseRoutes(json);
  assert.strictEqual(r[0].dst, 'default');
  assert.strictEqual(r[0].gateway, '192.168.1.1');
  // the text form is what we fall back to when `ip -j route` truncates
  const t = n.parseRoutesText('default via 192.168.1.1 dev eth0 proto dhcp src 192.168.1.50 metric 100\n10.0.0.0/8 dev wg0 scope link\n');
  assert.strictEqual(t.length, 2);
  assert.strictEqual(t[0].gateway, '192.168.1.1');
  assert.strictEqual(t[0].dev, 'eth0');
  assert.strictEqual(t[1].dst, '10.0.0.0/8');
  assert.strictEqual(t[1].gateway, null);
});

test('parseResolvConf: nameservers and search/domain lines', () => {
  const d = n.parseResolvConf('# comment\nnameserver 1.1.1.1\nnameserver 8.8.8.8\nsearch lan example.com\n');
  assert.deepStrictEqual(d.nameservers, ['1.1.1.1', '8.8.8.8']);
  assert.deepStrictEqual(d.search, ['lan', 'example.com']);
});

test('parseSockets (JSON) and parseSocketsText (ss -tulpn)', () => {
  const json = JSON.stringify([{ netid: 'tcp', state: 'LISTEN', local_addr: '0.0.0.0', local_port: 22, peer_addr: '0.0.0.0', peer_port: 0, processes: [{ name: 'sshd', pid: 100 }] }]);
  const s = n.parseSockets(json);
  assert.strictEqual(s[0].local, '0.0.0.0:22');
  assert.strictEqual(s[0].process, 'sshd/100');

  const text = 'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process\n' +
    'LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=100,fd=3))\n' +
    'LISTEN 0 511 [::]:8088 [::]:* users:(("node",pid=200,fd=20))\n';
  const t = n.parseSocketsText(text);
  assert.strictEqual(t.length, 2);
  assert.strictEqual(t[0].local, '0.0.0.0:22');
  assert.ok(t[1].process.includes('node'));

  // newer iproute2 adds a Netid column → column offset shifts by one
  const text2 = 'Netid State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process\n' +
    'udp   UNCONN 0      0      0.0.0.0:41641    0.0.0.0:*    users:(("tailscaled",pid=854,fd=21))\n';
  const t2 = n.parseSocketsText(text2);
  assert.strictEqual(t2[0].proto, 'udp');
  assert.strictEqual(t2[0].local, '0.0.0.0:41641');
  assert.strictEqual(t2[0].peer, '0.0.0.0:*');
});

test('parseNft: summarises tables/chains/rules; unavailable is safe', () => {
  const json = JSON.stringify({ nftables: [
    { metainfo: {} },
    { table: { family: 'inet', name: 'filter' } },
    { chain: { family: 'inet', table: 'filter', name: 'input' } },
    { rule: { family: 'inet', table: 'filter', chain: 'input' } },
    { rule: { family: 'inet', table: 'filter', chain: 'input' } },
  ] });
  const f = n.parseNft(json);
  assert.strictEqual(f.available, true);
  assert.strictEqual(f.tables, 1);
  assert.strictEqual(f.chains, 1);
  assert.strictEqual(f.rules, 2);
  assert.strictEqual(f.list[0].name, 'filter');
  assert.strictEqual(f.list[0].chains, 1);

  assert.deepStrictEqual(n.parseNft('not json'), { available: false, tables: 0, chains: 0, rules: 0, list: [] });
});

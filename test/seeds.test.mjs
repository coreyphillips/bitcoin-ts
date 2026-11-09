import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SIGNET_CHALLENGE, networkParams } from '../dist/params.js';
import { discoverPeers, publicPeerAddress, seedHosts } from '../dist/seeds.js';

test('published DNS seeds match the selected public chain', () => {
  for (const [network, count] of Object.entries({ main: 7, testnet3: 4, testnet4: 2, signet: 2, regtest: 0 })) {
    assert.equal(seedHosts(networkParams(network)).length, count);
  }
  assert.deepEqual(seedHosts(networkParams('signet', { signetchallenge: DEFAULT_SIGNET_CHALLENGE })), seedHosts(networkParams('signet')));
  assert.deepEqual(seedHosts(networkParams('signet', { signetchallenge: '51' })), []);
  assert.deepEqual(seedHosts(networkParams('testnet4', { testactivationheight: { segwit: 100 } })), []);
});

test('discovery returns canonical public numeric addresses', () => {
  assert.equal(publicPeerAddress('8.8.8.8'), '8.8.8.8');
  assert.equal(publicPeerAddress('2606:4700:0000:0000:0000:0000:0000:1111'), '2606:4700::1111');
  for (const ip of ['::', '::1', '::ffff:127.0.0.1', '2002:7f00:1::', 'fe80::1', 'fc00::1',
    'ff02::1', '2001:db8::1', '3fff::20', '2606:4700::1%en0', '0.0.0.0', '10.0.0.12', '100.65.0.1',
    '127.1.1.1', '169.254.1.1', '172.21.0.1', '192.168.4.1', '224.0.0.1', '255.255.255.255',
    '192.0.2.1', 'localhost', '127.1', '8.8.8.8:8333', '[::1]:8333']) {
    assert.equal(publicPeerAddress(ip), undefined, ip);
  }
});

test('DNS results alternate seed sources and IP families and deduplicate by canonical IP', async () => {
  const a = ['8.8.8.8', '2606:4700::1111'];
  const b = ['1.1.1.1', '2606:4700::9999'];
  let cancelled = false;
  const resolver = {
    async resolve4(host) { return [host === 'a' ? a[0] : b[0], '10.0.0.1', '::1']; },
    async resolve6(host) { return host === 'a' ? [a[1], '2606:4700:0000:0000:0000:0000:0000:1111'] : [b[1]]; },
    cancel() { cancelled = true; },
  };
  const peers = await discoverPeers(['a', 'b', 'a'], 1000, resolver);
  assert.deepEqual(new Set(peers), new Set([...a, ...b]));
  assert.equal(peers.length, 4);
  assert.equal(peers.slice(0, 2).filter(ip => a.includes(ip)).length, 1);
  assert.equal(cancelled, true);
});

test('unresponsive or failing DNS seeds preserve successful results at deadline', async () => {
  let cancelled = false;
  const resolver = {
    async resolve4(host) { if (host === 'down') throw new Error('no A answer'); return ['1.1.1.1']; },
    async resolve6() { return new Promise(() => {}); },
    cancel() { cancelled = true; },
  };
  assert.deepEqual(await discoverPeers(['up', 'down'], 15, resolver), ['1.1.1.1']);
  assert.equal(cancelled, true);
});

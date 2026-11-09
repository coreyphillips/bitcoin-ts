// Loaded only in the test's CLI subprocess. All outbound connections go to its mock peer.
import { Resolver } from 'node:dns/promises';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';

const { trace, port, answers } = JSON.parse(process.env.BITCOIN_TEST_NETWORK);
function record(event) { appendFileSync(trace, JSON.stringify(event) + '\n'); }

Resolver.prototype.resolve4 = async function(host) {
  record({ query: host, family: 4 });
  return answers;
};
Resolver.prototype.resolve6 = async function(host) {
  record({ query: host, family: 6 });
  return [];
};

const connect = net.createConnection;
net.createConnection = function(options, ...args) {
  const { host } = options;
  record({ host, port: options.port });
  if (!['8.8.8.8', '1.1.1.1', '127.0.0.1'].includes(host) || !port) {
    throw new Error('Unexpected test connection to ' + host);
  }
  return connect({ ...options, host: '127.0.0.1', port }, ...args);
};
syncBuiltinESMExports();

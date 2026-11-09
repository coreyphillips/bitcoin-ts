import { randomInt } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { BlockList, isIP, SocketAddress } from 'node:net';
import { networkParams, type NetworkParams } from './params.js';

// Bitcoin Consensus Specification v32.1-1, section 14.6. Each seed returns peer IPs.
const hosts: Record<string, readonly string[]> = {
  main: ['dnsseed.bluematt.me', 'seed.bitcoin.jonasschnelli.ch', 'seed.btc.petertodd.net',
    'seed.bitcoin.sprovoost.nl', 'dnsseed.emzy.de', 'seed.bitcoin.wiz.biz', 'seed.mainnet.achownodes.xyz'],
  testnet3: ['testnet-seed.bitcoin.jonasschnelli.ch', 'seed.tbtc.petertodd.net',
    'testnet-seed.bluematt.me', 'seed.testnet.achownodes.xyz'],
  testnet4: ['seed.testnet4.bitcoin.sprovoost.nl', 'seed.testnet4.wiz.biz'],
  signet: ['seed.signet.bitcoin.sprovoost.nl', 'seed.signet.achownodes.xyz'],
};

export function seedHosts(params: NetworkParams): readonly string[] {
  const seeds = hosts[params.network];
  if (!seeds) return [];
  const defaults = networkParams(params.network);
  if (defaults.challenge && !defaults.challenge.equals(params.challenge ?? Buffer.alloc(0))) return [];
  for (const name of Object.keys(defaults.heights) as (keyof typeof defaults.heights)[]) {
    if (params.heights[name] !== defaults.heights[name]) return [];
  }
  return seeds.slice();
}

export function requireSeedHosts(params: NetworkParams): readonly string[] {
  const seeds = seedHosts(params);
  if (seeds.length === 0) throw new Error('This network has no public DNS seeds. Supply --connect HOST[:PORT]');
  return seeds;
}

// Discovery accepts public unicast addresses. Explicit peers may use private networks.
const reserved = new BlockList();
for (const [base, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) reserved.addSubnet(base, prefix, 'ipv4');
for (const [base, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
] as const) reserved.addSubnet(base, prefix, 'ipv6');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

export function publicPeerAddress(text: string): string | undefined {
  if (typeof text !== 'string' || text.includes('%')) return;
  const family = isIP(text);
  if (family === 4 && !reserved.check(text, 'ipv4')) return text;
  if (family === 6 && globalV6.check(text, 'ipv6') && !reserved.check(text, 'ipv6')) {
    return new SocketAddress({ family: 'ipv6', address: text }).address;
  }
}

function shuffle<T>(values: T[]): T[] {
  for (let i = values.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}

function interleave<T>(groups: T[][]): T[] {
  const result: T[] = [];
  const longest = Math.max(0, ...groups.map(group => group.length));
  for (let i = 0; i < longest; i++) {
    for (const group of groups) if (i < group.length) result.push(group[i]);
  }
  return result;
}

interface SeedResolver {
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
  cancel(): void;
}

/** Returns the usable answers received before the shared deadline, including partial DNS results. */
export async function discoverPeers(seeds: readonly string[], timeoutMs: number, resolver?: SeedResolver): Promise<string[]> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 0x7fffffff) throw new RangeError('Invalid DNS timeout');
  if (!seeds.length) return [];
  const dns = resolver ?? new Resolver({ timeout: Math.min(3000, timeoutMs), tries: 1 });
  const buckets = [...new Set(seeds)].map(host => ({ host, families: [[], []] as string[][] }));
  const queries = buckets.flatMap(({ host, families }) => [4, 6].map(async (family, index) => {
    const records = await (family === 4 ? dns.resolve4(host) : dns.resolve6(host));
    const unique = new Set<string>();
    for (const record of records) {
      const ip = publicPeerAddress(record);
      if (ip && isIP(ip) === family) unique.add(ip);
    }
    families[index] = shuffle([...unique]);
  }));
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([Promise.allSettled(queries), new Promise<void>(resolve => {
      timer = setTimeout(resolve, timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
    dns.cancel();
  }
  const bySeed = shuffle(buckets).map(({ families }) => interleave(shuffle(families)));
  return [...new Set(interleave(bySeed))];
}

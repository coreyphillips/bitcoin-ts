import { hash256, varBytes } from './codec.js';

export interface NetworkOptions {
  testactivationheight?: Partial<Record<'bip34' | 'dersig' | 'cltv' | 'csv' | 'segwit', number>>;
  test?: string[];
  signetchallenge?: string;
}

export const DEFAULT_SIGNET_CHALLENGE = '512103ad5e0edad18cb1f0fc0d28a3d4f1f3e445640337489abb10404f2d1e086be430210359ef5021964fe22d6f8e05b2463c9540ce96883fe3b278760f048f5189f2e6c452ae';

const genesisMerkle = '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b';
const testnet4Merkle = '7aa0a7ae1e223414cb807e40cd57e667b718e42aaf9306db9102fe28912b7b4e';

const networks = {
  main:     { magic: 'f9beb4d9', port: 8333,  time: 1231006505, nonce: 2083236893, bits: 0x1d00ffff },
  testnet3: { magic: '0b110907', port: 18333, time: 1296688602, nonce: 414098458,  bits: 0x1d00ffff },
  testnet4: { magic: '1c163f28', port: 48333, time: 1714777860, nonce: 393743547,  bits: 0x1d00ffff },
  signet:   { magic: '',         port: 38333, time: 1598918400, nonce: 52613770,   bits: 0x1e0377ae },
  regtest:  { magic: 'fabfb5da', port: 18444, time: 1296688602, nonce: 2,          bits: 0x207fffff },
};

export function networkParams(network: string, options: NetworkOptions = {}) {
  if (!Object.hasOwn(networks, network)) throw new Error('unknown Bitcoin network');
  const config = networks[network as keyof typeof networks];
  const regtest = network === 'regtest';
  const signet = network === 'signet';
  let challenge: Buffer | undefined;
  if (signet) {
    const hex = options.signetchallenge ?? DEFAULT_SIGNET_CHALLENGE;
    if (typeof hex !== 'string' || !/^(?:[0-9a-fA-F]{2})*$/.test(hex)) throw new Error('invalid signet challenge');
    challenge = Buffer.from(hex, 'hex');
  }

  const genesis = Buffer.alloc(80);
  genesis.writeInt32LE(1);
  Buffer.from(network === 'testnet4' ? testnet4Merkle : genesisMerkle, 'hex').reverse().copy(genesis, 36);
  genesis.writeUInt32LE(config.time, 68);
  genesis.writeUInt32LE(config.bits, 72);
  genesis.writeUInt32LE(config.nonce, 76);

  const heights = { bip34: 1, dersig: 1, cltv: 1, csv: 1, segwit: regtest ? 0 : 1 };
  if (network === 'main') Object.assign(heights, { bip34: 227931, dersig: 363725, cltv: 388381, csv: 419328, segwit: 481824 });
  if (network === 'testnet3') Object.assign(heights, { bip34: 21111, dersig: 330776, cltv: 581885, csv: 770112, segwit: 834624 });
  for (const [name, height] of Object.entries(options.testactivationheight ?? {})) {
    if (network === 'main' || !Object.hasOwn(heights, name) || !Number.isInteger(height) || height < 0 || height > 0x7fffffff) {
      throw new Error(`invalid ${network} activation override: ${name}`);
    }
    heights[name as keyof typeof heights] = height;
  }
  const exceptions = new Map<string, string[]>();
  if (network === 'main') {
    exceptions.set('00000000000002dc756eebf4f49723ed8d30cc28a5f108eb94b1ba88ac4f9c22', []);
    exceptions.set('0000000000000000000f14c35b2d841e986ab5441de8c585d5ffe55ea1e395ad', ['P2SH', 'WITNESS']);
  }
  if (network === 'testnet3') exceptions.set('00000000dd30457c001f4095d208cc1296b0eed002427aa599874af7a432b105', []);
  return {
    network, genesis, challenge, magic: challenge ? hash256(varBytes(challenge)).subarray(0, 4) : Buffer.from(config.magic, 'hex'),
    port: config.port, heights, exceptions,
    powLimit: signet ? 0x377aen << 216n : (1n << (regtest ? 255n : 224n)) - 1n,
    timespan: regtest ? 86400 : 1209600, interval: regtest ? 144 : 2016,
    minDifficulty: regtest || network.startsWith('testnet'), noRetarget: regtest,
    bip94: network === 'testnet4' || (regtest && !!options.test?.includes('bip94')),
    halving: regtest ? 150 : 210000,
  };
}

export type NetworkParams = ReturnType<typeof networkParams>;

export function blockFlags(params: NetworkParams, hash: string, height: number): Set<string> {
  const flags = new Set(params.exceptions.get(hash) ?? ['P2SH', 'WITNESS', 'TAPROOT']);
  if (height >= params.heights.dersig) flags.add('DERSIG');
  if (height >= params.heights.cltv) flags.add('CHECKLOCKTIMEVERIFY');
  if (height >= params.heights.csv) flags.add('CHECKSEQUENCEVERIFY');
  if (height >= params.heights.segwit) flags.add('NULLDUMMY');
  return flags;
}

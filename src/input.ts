export class RequestError extends Error {}

/** Validate at the text boundary before Buffer or Number can silently coerce a value. */
export function hex(value: unknown, name: string, bytes?: number): Buffer {
  if (typeof value !== 'string' || (value.length % 2) || /[^\da-f]/i.test(value) ||
      (bytes !== undefined && value.length !== bytes * 2)) {
    throw new RequestError(`Invalid hex for ${name}`);
  }
  return Buffer.from(value, 'hex');
}

export function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RequestError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function list(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new RequestError(`${name} must be an array`);
  return value;
}

export function integer(value: unknown, name: string, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new RequestError(`Invalid integer for ${name}`);
  }
  return value;
}

export function networkName(value: unknown): string {
  if (typeof value !== 'string' || !['main', 'testnet3', 'testnet4', 'signet', 'regtest'].includes(value)) {
    throw new RequestError('Choose main, testnet3, testnet4, signet or regtest');
  }
  return value;
}

export function networkOptions(value: unknown, network: string) {
  const options = object(value, 'options');
  for (const key of Object.keys(options)) {
    if (!['testactivationheight', 'test', 'signetchallenge'].includes(key)) throw new RequestError(`Unknown option ${key}`);
  }
  const normalized: { testactivationheight?: Record<string, number>, test?: string[], signetchallenge?: string } = {};
  if (options.testactivationheight !== undefined) {
    const heights = Object.entries(object(options.testactivationheight, 'testactivationheight')).sort();
    if (network === 'main' && heights.length) throw new RequestError('Mainnet activation heights are fixed');
    if (heights.length) normalized.testactivationheight = Object.fromEntries(heights.map(([name, height]) => {
      if (!['bip34', 'dersig', 'cltv', 'csv', 'segwit'].includes(name)) throw new RequestError(`Unknown deployment ${name}`);
      return [name, integer(height, name, 0, 0x7fffffff)];
    }));
  }
  if (options.test !== undefined) {
    const tests = [...new Set(list(options.test, 'test').map(name => {
      if (name !== 'bip94' || network !== 'regtest') throw new RequestError('bip94 is a regtest option');
      return name;
    }))];
    if (tests.length) normalized.test = tests;
  }
  if (options.signetchallenge !== undefined) {
    if (network !== 'signet') throw new RequestError('A custom challenge requires signet');
    normalized.signetchallenge = hex(options.signetchallenge, 'signetchallenge').toString('hex');
  }
  return normalized;
}

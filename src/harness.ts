import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { hex, integer, list, networkName, networkOptions, object, RequestError } from './input.js';
import { checkTransaction, parseTransaction, type TxOutput } from './tx.js';
import { legacySighash, taprootSighash } from './sighash.js';
import { verifySchnorr, verifyTaprootCommitment } from './crypto.js';
import type { Chain } from './chain.js';

const ops = ['info', 'tx_check', 'sighash_legacy', 'sighash_taproot', 'schnorr_verify',
  'taproot_commitment_verify', 'script_verify', 'chain_reset', 'chain_tip', 'chain_tips',
  'chain_process_block', 'chain_process_headers', 'chain_invalidate', 'utxo_hash'];
const scriptFlags = ['P2SH', 'DERSIG', 'NULLDUMMY', 'CHECKLOCKTIMEVERIFY', 'CHECKSEQUENCEVERIFY', 'WITNESS', 'TAPROOT'];

function spentOutputs(value: unknown, inputs: number): TxOutput[] {
  const items = list(value, 'spent_outputs');
  if (items.length !== inputs) throw new RequestError('Expected one spent output per input');
  return items.map(item => {
    const coin = object(item, 'spent output');
    return { script: hex(coin.script_pubkey, 'script_pubkey'), value: BigInt(integer(coin.amount, 'amount')) };
  });
}

// Each session owns its block tree and receives its network through chain_reset.
export function harnessSession() {
  let chain: Chain | undefined;
  return async function handle(line: string) {
    let id: number | null = null;
    try {
      const req = object(JSON.parse(line), 'request');
      id = integer(req.id, 'id');
      const ok = (fields: object) => ({ id, ok: true, ...fields });
      const op = req.op;
      if (typeof op !== 'string') throw new RequestError('Missing op');
      if (!ops.includes(op)) return { id, ok: false, error: 'unsupported_op', message: op };
      switch (op) {
        case 'info': return ok({ name: 'bitcoin-ts', version: '0.1.0', spec_version: 'v32.1-1', ops });
        case 'tx_check': {
          const raw = hex(req.tx, 'tx');
          let reason: string | null;
          try { reason = checkTransaction(parseTransaction(raw)); } catch { reason = 'tx-decode'; }
          return ok(reason ? { valid: false, reason } : { valid: true });
        }
        case 'schnorr_verify': return ok({ valid: verifySchnorr(hex(req.pubkey, 'pubkey', 32), hex(req.msg, 'msg'), hex(req.sig, 'sig', 64)) });
        case 'taproot_commitment_verify':
          return ok({ valid: verifyTaprootCommitment(hex(req.control_block, 'control_block'), hex(req.script, 'script'), hex(req.output_key, 'output_key', 32)) });
        case 'sighash_legacy':
        case 'sighash_taproot':
        case 'script_verify': {
          const raw = hex(req.tx, 'tx');
          let tx;
          try { tx = parseTransaction(raw); } catch { throw new RequestError('Cannot decode transaction'); }
          const index = integer(req.index, 'index', 0, tx.inputs.length - 1);
          if (op === 'sighash_legacy') {
            const hash = legacySighash(tx, index, hex(req.script_code, 'script_code'), integer(req.hash_type, 'hash_type', -2147483648, 2147483647));
            return ok({ sighash: hash.toString('hex') });
          }
          const spent = spentOutputs(req.spent_outputs, tx.inputs.length);
          if (op === 'script_verify') {
            const flags = new Set(list(req.flags, 'flags').map(flag => {
              if (typeof flag !== 'string' || !scriptFlags.includes(flag)) throw new RequestError(`Unknown script flag ${flag}`);
              return flag;
            }));
            const { verifyScript } = await import('./script.js');
            const script_error = verifyScript(tx, index, spent, flags);
            return ok({ valid: script_error === 'OK', script_error });
          }
          const hash = taprootSighash(tx, index, spent, integer(req.hash_type, 'hash_type', 0, 255),
            req.annex === undefined ? undefined : hex(req.annex, 'annex'),
            req.leaf_hash === undefined ? undefined : hex(req.leaf_hash, 'leaf_hash', 32),
            req.codesep_pos === undefined ? undefined : integer(req.codesep_pos, 'codesep_pos', 0, 0xffffffff));
          return ok(hash ? { valid: true, sighash: hash.toString('hex') } : { valid: false });
        }
        case 'chain_reset': {
          const { Chain } = await import('./chain.js');
          const network = networkName(req.network);
          chain = new Chain(network, networkOptions(req.options ?? {}, network));
          return ok({ genesis: chain.tip().tip });
        }
      }
      if (!chain) throw new RequestError('chain_reset first');
      const via = req.via ?? 'p2p';
      if (via !== 'p2p' && via !== 'rpc') throw new RequestError('Invalid delivery method');
      switch (op) {
        case 'chain_tip': return ok(chain.tip());
        case 'chain_tips': return ok(chain.tips());
        case 'utxo_hash': return ok(chain.utxoHash());
        case 'chain_invalidate': return ok(chain.invalidate(hex(req.hash, 'hash', 32).toString('hex')));
        case 'chain_process_block': {
          if (req.requested !== undefined && typeof req.requested !== 'boolean') throw new RequestError('Invalid requested flag');
          return ok(chain.processBlock(hex(req.block, 'block'), integer(req.now, 'now'), via, req.requested ?? true));
        }
        case 'chain_process_headers':
          return ok(chain.processHeaders(list(req.headers, 'headers').map(h => hex(h, 'header', 80)), integer(req.now, 'now'), via));
        default: throw new RequestError('Unknown operation');
      }
    } catch (error) {
      const code = error instanceof RequestError || error instanceof SyntaxError ? 'bad_request' : 'internal';
      return { id, ok: false, error: code, message: error instanceof Error ? error.message : String(error) };
    }
  };
}

export async function runHarness() {
  const session = harnessSession();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    if (!process.stdout.write(JSON.stringify(await session(line)) + '\n')) await once(process.stdout, 'drain');
  }
}

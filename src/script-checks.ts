import { verifyScript } from './script.js';
import { SighashCache } from './sighash.js';
import type { Transaction, TxOutput } from './tx.js';

export interface ScriptCheck {
  tx: Transaction;
  /** All inputs' spent outputs, in input order, including when checking a subrange. */
  spent: TxOutput[];
}

export function verifyInputs(
  { tx, spent }: ScriptCheck, flags: ReadonlySet<string>, start = 0, end = spent.length, progress?: () => void,
): string {
  const cache = new SighashCache(tx, spent);
  for (let input = start; input < end; input++) {
    const error = verifyScript(tx, input, spent, flags, cache);
    if (error !== 'OK') return error;
    if (progress && (input - start + 1) % 8 === 0) progress();
  }
  return 'OK';
}

export function verifyChecks(checks: readonly ScriptCheck[], flags: ReadonlySet<string>): string {
  for (const check of checks) {
    const error = verifyInputs(check, flags);
    if (error !== 'OK') return error;
  }
  return 'OK';
}

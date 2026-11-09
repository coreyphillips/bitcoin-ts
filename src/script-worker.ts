import { deserialize } from 'node:v8';
import { parentPort } from 'node:worker_threads';
import { verifyInputs, type ScriptCheck } from './script-checks.js';

export interface ScriptJob {
  ranges: { bytes: Uint8Array; start: number; end: number }[];
  flags: string[];
  /** Per lane: progress while working, -1 for success, -2 to replay locally. */
  status: Int32Array;
  lane: number;
}

parentPort!.on('message', ({ ranges, flags, status, lane }: ScriptJob) => {
  let passed = false;
  try {
    const active = new Set(flags);
    const progress = () => { Atomics.add(status, lane, 1); };
    for (const { bytes, start, end } of ranges) {
      const check: ScriptCheck = deserialize(bytes);
      if (verifyInputs(check, active, start, end, progress) !== 'OK') return;
      progress();
    }
    passed = true;
  } catch {
    // Reproduce local exceptions on the calling thread in the original input order.
  } finally {
    // Any failure is independently rechecked on the caller before returning a verdict.
    Atomics.store(status, lane, passed ? -1 : -2);
    Atomics.notify(status, lane);
  }
});

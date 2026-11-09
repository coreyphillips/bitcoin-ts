import { availableParallelism } from 'node:os';
import { serialize } from 'node:v8';
import { Worker } from 'node:worker_threads';
import { verifyChecks, verifyInputs, type ScriptCheck } from './script-checks.js';
import type { ScriptJob } from './script-worker.js';

export const MAX_SCRIPT_THREADS = 16;
export const DEFAULT_SCRIPT_THREADS = Math.min(8, availableParallelism());
const MIN_INPUTS_PER_THREAD = 8;

interface InputRange {
  check: ScriptCheck;
  start: number;
  end: number;
}

// Keep the batches in transaction/input order so serial and parallel error reporting agree.
function partition(checks: readonly ScriptCheck[], inputs: number, lanes: number): InputRange[][] {
  const batches: InputRange[][] = [[]];
  let remaining = Math.ceil(inputs / lanes);
  let assigned = 0;
  for (const check of checks) {
    for (let start = 0; start < check.spent.length;) {
      const count = Math.min(remaining, check.spent.length - start);
      batches[batches.length - 1].push({ check, start, end: start + count });
      assigned += count;
      remaining -= count;
      start += count;
      if (!remaining && assigned < inputs) {
        remaining = Math.ceil((inputs - assigned) / (lanes - batches.length));
        batches.push([]);
      }
    }
  }
  return batches;
}

function verifyBatch(batch: InputRange[], flags: ReadonlySet<string>): string {
  for (const { check, start, end } of batch) {
    const result = verifyInputs(check, flags, start, end);
    if (result !== 'OK') return result;
  }
  return 'OK';
}

/** Reuse workers across blocks. The calling thread is one of the verification threads. */
export class ScriptPool {
  private readonly workers: Worker[] = [];
  private closed = false;
  private retryAfter = 0;

  constructor(private readonly threads = DEFAULT_SCRIPT_THREADS) {
    if (!Number.isInteger(threads) || threads < 1 || threads > MAX_SCRIPT_THREADS) {
      throw new RangeError(`scriptThreads must be between 1 and ${MAX_SCRIPT_THREADS}`);
    }
  }

  private worker(index: number): Worker {
    if (!this.workers[index]) {
      const worker = new Worker(new URL('./script-worker.js', import.meta.url), { execArgv: [] });
      this.workers.push(worker);
      const lost = () => {
        if (this.workers[index] === worker) this.retireWorkers();
      };
      worker.on('error', lost);
      worker.once('exit', lost);
      worker.unref();
    }
    return this.workers[index];
  }

  verify(checks: readonly ScriptCheck[], flags: ReadonlySet<string>): string {
    if (this.closed) throw new Error('Script verifier is closed');
    if (this.threads === 1 || performance.now() < this.retryAfter) return verifyChecks(checks, flags);
    const inputs = checks.reduce((sum, check) => sum + check.spent.length, 0);
    const lanes = Math.min(this.threads, Math.floor(inputs / MIN_INPUTS_PER_THREAD));
    if (lanes < 2) return verifyChecks(checks, flags);

    const batches = partition(checks, inputs, lanes);
    const status = new Int32Array(new SharedArrayBuffer(lanes * Int32Array.BYTES_PER_ELEMENT));
    const sharedChecks = new Map<ScriptCheck, Uint8Array>();
    try {
      for (let lane = 1; lane < lanes; lane++) {
        const ranges = batches[lane].map(({ check, start, end }) => {
          // V8 serialization preserves Buffers and packs only their visible bytes. Structured
          // cloning the original views could copy an entire block for a single short script.
          let bytes = sharedChecks.get(check);
          if (!bytes) {
            bytes = serialize(check);
            if (start !== 0 || end !== check.spent.length) {
              // A large transaction can span many lanes. Share its immutable bytes across them.
              const shared = new Uint8Array(new SharedArrayBuffer(bytes.byteLength));
              shared.set(bytes);
              bytes = shared;
              sharedChecks.set(check, bytes);
            }
          }
          return { bytes, start, end };
        });
        const job: ScriptJob = { ranges, flags: [...flags], status, lane };
        this.worker(lane - 1).postMessage(job);
      }
    } catch {
      this.retireWorkers();
      return verifyChecks(checks, flags);
    }

    try {
      let result = verifyBatch(batches[0], flags);
      for (let lane = 1; lane < lanes; lane++) {
        // Node delivers worker exit events on the event loop, which cannot run while this
        // synchronous chain transaction waits. Detect a dead or hung worker independently.
        let state = Atomics.load(status, lane);
        while (state >= 0) {
          const wait = Atomics.wait(status, lane, state, 10_000);
          const next = Atomics.load(status, lane);
          if (wait === 'timed-out' && next === state) {
            this.retireWorkers();
            return verifyChecks(checks, flags);
          }
          state = next;
        }
        // Failures are rare. Replaying just that lane gives the exact serial error, including
        // local exceptions, without transporting exceptions across thread boundaries.
        if (state !== -1 && result === 'OK') result = verifyBatch(batches[lane], flags);
      }
      return result;
    } catch (error) {
      this.retireWorkers();
      throw error;
    }
  }

  private retireWorkers(): void {
    this.retryAfter = performance.now() + 5_000;
    for (const worker of this.workers.splice(0)) void worker.terminate();
  }

  close(): void {
    this.closed = true;
    this.retireWorkers();
  }
}

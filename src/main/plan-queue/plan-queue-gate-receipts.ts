/** Machine-owned evidence, taken before a read-only checker sees the worktree. */
import { stripVTControlCharacters } from 'node:util';
import { buildCliEnv } from '../cli/cli-environment';
import { extractVerifyFailureKeys } from '../orchestration/verify-failure-keys';
import { runInProcessGroup } from './plan-queue-process';

export type GateEvidence = 'passed' | 'failed' | 'no-tests-found' | 'not-recognised';
export interface PlanQueueGateReceipt {
  command: string;
  head: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  tail: string;
  classification: GateEvidence;
  baseline: 'new' | 'also-failing-on-base';
  failureKeyCounts: Record<string, number>;
}
interface GateExecution { exitCode: number; output: string; timedOut?: boolean }
type ExecuteGate = (command: string, cwd: string, signal?: AbortSignal) => Promise<GateExecution>;
interface GateInput {
  cwd: string; head: string; commands: readonly string[]; signal?: AbortSignal;
  scope?: string;
  baseSha?: string;
  withBaseline?: <T>(action: (cwd: string) => Promise<T>) => Promise<T>;
}

export function classifyGateEvidence(command: string, exitCode: number, output: string): GateEvidence {
  const plain = stripVTControlCharacters(output);
  if (exitCode !== 0) return 'failed';
  if (/no test (?:files|suites|cases|tests)?\s*found|no tests (?:found|collected)/i.test(plain)) return 'no-tests-found';
  if (/\b0 tests? passed|\bTests\s*:?\s+0 passed|\b0 passing\b/i.test(plain)) return 'no-tests-found';
  const goPackages = plain.split(/\r?\n/).filter(line => /^\s*(?:ok|\?)\s+\S+/.test(line));
  if (goPackages.length && goPackages.every(line => /\[(?:no tests to run|no test files)\]\s*$/.test(line))) return 'no-tests-found';
  if (/\b(?:test(?::[\w-]+)?|vitest|jest|pytest|mocha)\b/i.test(command)) {
    return /\d+ tests? passed|Tests\s*:?\s+\d+ passed|\d+ passed.*(?:in|\[)|\b[1-9]\d* passing\b|^ok\s+\S+\s+(?:[\d.]+s|\(cached\))/im.test(plain) ? 'passed' : 'not-recognised';
  }
  return 'passed';
}

const executeGate: ExecuteGate = (command, cwd, signal) => runInProcessGroup(command, [], {
  cwd, shell: true, env: { ...buildCliEnv(), AIO_TEST_SUMMARY: '0' }, timeoutMs: 15 * 60_000,
  // Retain enough for a diagnostic comparison; the persisted receipt has only a 2 KB tail.
  outputTail: 256_000, label: 'verification check', signal,
});

/** The pump reserves each job's check slot; unrelated gate sets run concurrently. */
export class PlanQueueGateRunner {
  private readonly cache = new Map<string, PlanQueueGateReceipt[]>();
  private readonly baseCache = new Map<string, PlanQueueGateReceipt[]>();
  private readonly pendingBases = new Map<string, { result: Promise<PlanQueueGateReceipt[]>; signal?: AbortSignal }>();
  constructor(private readonly execute: ExecuteGate = executeGate) {}

  async run(input: GateInput): Promise<PlanQueueGateReceipt[]> {
    const key = JSON.stringify([input.cwd, input.head, input.baseSha, input.commands]);
    input.signal?.throwIfAborted();
    const cached = this.cache.get(key);
    if (cached) return structuredClone(cached);
    const receipts: PlanQueueGateReceipt[] = [];
    for (const command of input.commands) {
      input.signal?.throwIfAborted();
      const started = Date.now();
      const result = await this.execute(command, input.cwd, input.signal);
      input.signal?.throwIfAborted();
      const timedOut = result.timedOut === true;
      receipts.push({ command, head: input.head, exitCode: timedOut ? 1 : result.exitCode, timedOut,
        durationMs: Date.now() - started, tail: Buffer.from(result.output).subarray(-2048).toString('utf8').replace(/^\uFFFD+/, ''),
        classification: timedOut ? 'failed' : classifyGateEvidence(command, result.exitCode, result.output), baseline: 'new',
        failureKeyCounts: Object.fromEntries(extractVerifyFailureKeys(result.output.replaceAll(input.cwd, ''), {
          truncated: result.output.length >= 256_000, failureKind: 'command',
        }).keys) });
    }
    if (input.withBaseline && input.baseSha && receipts.some(receipt => receipt.classification === 'failed')) {
      const base = await this.baseline(input);
      for (const receipt of receipts) {
        const original = base.find(candidate => candidate.command === receipt.command);
        if (receipt.classification === 'failed' && !receipt.timedOut && original?.classification === 'failed' && !original.timedOut
          && Object.keys(receipt.failureKeyCounts).length > 0
          && Object.entries(receipt.failureKeyCounts).every(([failure, count]) => count <= (original.failureKeyCounts[failure] ?? 0))) {
          receipt.baseline = 'also-failing-on-base';
        }
      }
    }
    // Bound the lifetime cache; completed items must not grow it indefinitely.
    input.signal?.throwIfAborted();
    for (const receipt of receipts) receipt.failureKeyCounts = {};
    if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, structuredClone(receipts));
    return receipts;
  }

  private async baseline(input: GateInput): Promise<PlanQueueGateReceipt[]> {
    input.signal?.throwIfAborted();
    const key = JSON.stringify([input.scope ?? input.cwd, input.baseSha, input.commands]);
    const cached = this.baseCache.get(key);
    if (cached) return cached;
    const pending = this.pendingBases.get(key);
    if (pending) {
      try { return await waitForBaseline(pending.result, input.signal); }
      catch (error) {
        input.signal?.throwIfAborted();
        // Another job owned that comparison and cancelled it. This job still needs evidence.
        if (pending.signal?.aborted) return this.baseline(input);
        throw error;
      }
    }
    const result = input.withBaseline!(async cwd => {
      const collected: PlanQueueGateReceipt[] = [];
      for (const command of input.commands) {
        input.signal?.throwIfAborted();
        const result = await this.execute(command, cwd, input.signal);
        input.signal?.throwIfAborted();
        collected.push({ command, head: input.baseSha!, exitCode: result.exitCode, timedOut: result.timedOut === true,
          durationMs: 0, tail: '', classification: classifyGateEvidence(command, result.exitCode, result.output), baseline: 'new',
          failureKeyCounts: Object.fromEntries(extractVerifyFailureKeys(result.output.replaceAll(cwd, ''), {
            truncated: result.output.length >= 256_000, failureKind: 'command',
          }).keys) });
      }
      return collected;
    });
    this.pendingBases.set(key, { result, signal: input.signal });
    try {
      const base = await result;
      input.signal?.throwIfAborted();
      if (this.baseCache.size >= 20) this.baseCache.delete(this.baseCache.keys().next().value!);
      this.baseCache.set(key, base);
      return base;
    } finally { this.pendingBases.delete(key); }
  }
}

/** Reuse only the identical base computation; unrelated gate sets never wait here. */
function waitForBaseline<T>(result: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return result;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason); };
    signal.addEventListener('abort', aborted, { once: true });
    void result.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

export function blockingGateReceipts(receipts: readonly PlanQueueGateReceipt[]): PlanQueueGateReceipt[] {
  return receipts.filter(receipt => receipt.baseline === 'new'
    && (receipt.timedOut || receipt.classification === 'failed' || receipt.classification === 'no-tests-found'));
}

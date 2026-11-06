/** Machine-owned evidence, taken before a read-only checker sees the worktree. */
import { stripVTControlCharacters } from 'node:util';
import { gitExec } from '../workspace/git/git-exec';
import { buildCliEnv } from '../cli/cli-environment';
import { extractVerifyFailureKeys } from '../orchestration/verify-failure-keys';
import { QUEUE_TEST_ENV, runInProcessGroup } from './plan-queue-process';

export type GateEvidence = 'passed' | 'failed' | 'no-tests-found' | 'not-recognised';
export interface PlanQueueGateReceipt {
  command: string;
  head: string;
  testedTree: string;
  checkGroup?: { id: string; baseTip: string; memberItemIds: string[] };
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
export interface GateInput {
  cwd: string; head: string; commands: readonly string[]; signal?: AbortSignal;
  scope?: string;
  onExecution?: () => void;
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

/**
 * Time one check may take. The full test suite needs about 7 minutes on a quiet machine and went past the old
 * 15 minutes whenever several workers and checkers shared it: in the first Plan Queue wave for this programme it
 * timed out in 4 of 5 jobs, whose work was otherwise sound.
 */
export const GATE_TIMEOUT_MS = 45 * 60_000;

const executeGate: ExecuteGate = (command, cwd, signal) => runInProcessGroup(command, [], {
  cwd, shell: true, env: { ...buildCliEnv(), ...QUEUE_TEST_ENV, AIO_TEST_SUMMARY: '0' }, timeoutMs: GATE_TIMEOUT_MS,
  // Retain enough for a diagnostic comparison; the persisted receipt has only a 2 KB tail.
  outputTail: 256_000, label: 'verification check', signal,
});

/** The pump reserves each job's check slot; unrelated gate sets run concurrently. */
export class PlanQueueGateRunner {
  private readonly cache = new Map<string, PlanQueueGateReceipt[]>();
  private readonly baseCache = new Map<string, PlanQueueGateReceipt[]>();
  private readonly pendingBases = new Map<string, { result: Promise<PlanQueueGateReceipt[]>; signal?: AbortSignal }>();
  constructor(
    private readonly execute: ExecuteGate = executeGate,
    private readonly readTree: (cwd: string) => string | Promise<string> = cwd => gitExec(['rev-parse', 'HEAD^{tree}'], cwd),
  ) {}

  cached(input: GateInput): PlanQueueGateReceipt[] | undefined {
    input.signal?.throwIfAborted();
    const cached = this.cache.get(this.key(input));
    return cached ? structuredClone(cached) : undefined;
  }

  forget(input: GateInput): void {
    this.cache.delete(this.key(input));
  }

  seed(input: GateInput, receipts: readonly PlanQueueGateReceipt[]): void {
    input.signal?.throwIfAborted();
    if (receipts.length !== input.commands.length || receipts.some((receipt, index) =>
      receipt.head !== input.head || receipt.command !== input.commands[index] || !receipt.testedTree)) {
      throw new Error('Gate receipts do not describe this member commit and checklist.');
    }
    if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(this.key(input), structuredClone(receipts).map(receipt => ({ ...receipt, failureKeyCounts: {} })));
  }

  private key(input: GateInput): string {
    return JSON.stringify([input.cwd, input.head, input.baseSha, input.commands]);
  }

  async run(input: GateInput): Promise<PlanQueueGateReceipt[]> {
    const cached = this.cached(input);
    if (cached) return cached;
    const receipts = await this.compareWithBase(input, await this.executeCommands(input));
    // A timeout says nothing about the code, so it must never answer for a later check.
    if (!receipts.some(receipt => receipt.timedOut)) this.seed(input, receipts);
    return receipts;
  }

  async executeCommands(input: GateInput): Promise<PlanQueueGateReceipt[]> {
    input.signal?.throwIfAborted();
    if (!input.commands.length) return [];
    const tree = this.readTree(input.cwd);
    const testedTree = typeof tree === 'string' ? tree : await tree;
    input.signal?.throwIfAborted();
    const receipts: PlanQueueGateReceipt[] = [];
    for (const command of input.commands) {
      input.signal?.throwIfAborted();
      if (!receipts.length) input.onExecution?.();
      const started = Date.now();
      const result = await this.execute(command, input.cwd, input.signal);
      input.signal?.throwIfAborted();
      const timedOut = result.timedOut === true;
      receipts.push({ command, head: input.head, testedTree, exitCode: timedOut ? 1 : result.exitCode, timedOut,
        durationMs: Date.now() - started, tail: Buffer.from(result.output).subarray(-2048).toString('utf8').replace(/^\uFFFD+/, ''),
        classification: timedOut ? 'failed' : classifyGateEvidence(command, result.exitCode, result.output), baseline: 'new',
        failureKeyCounts: Object.fromEntries(extractVerifyFailureKeys(result.output.replaceAll(input.cwd, ''), {
          truncated: result.output.length >= 256_000, failureKind: 'command',
        }).keys) });
      // The rest would wait behind the same computer, holding the one checklist turn for nothing.
      if (timedOut) break;
    }
    return receipts;
  }

  async compareWithBase(input: GateInput, raw: readonly PlanQueueGateReceipt[]): Promise<PlanQueueGateReceipt[]> {
    input.signal?.throwIfAborted();
    const receipts = structuredClone([...raw]);
    // A timeout can't be compared with the base, so only a real failure is worth a second run.
    if (input.withBaseline && input.baseSha && receipts.some(receipt => receipt.classification === 'failed' && !receipt.timedOut)) {
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
    input.signal?.throwIfAborted();
    for (const receipt of receipts) receipt.failureKeyCounts = {};
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
    const result = input.withBaseline!(cwd => this.executeCommands({
      cwd, head: input.baseSha!, commands: input.commands, signal: input.signal,
    }));
    this.pendingBases.set(key, { result, signal: input.signal });
    try {
      const base = await result;
      input.signal?.throwIfAborted();
      if (this.baseCache.size >= 20) this.baseCache.delete(this.baseCache.keys().next().value!);
      if (!base.some(receipt => receipt.timedOut)) this.baseCache.set(key, base);
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

/** True when every blocking check ran out of time, so the run says nothing about the code. */
export function onlyTimedOut(receipts: readonly PlanQueueGateReceipt[]): boolean {
  const red = blockingGateReceipts(receipts);
  return red.length > 0 && red.every(receipt => receipt.timedOut);
}

export function blockingGateReceipts(receipts: readonly PlanQueueGateReceipt[]): PlanQueueGateReceipt[] {
  return receipts.filter(receipt => receipt.baseline === 'new'
    && (receipt.timedOut || receipt.classification === 'failed' || receipt.classification === 'no-tests-found'));
}

/** Machine-owned evidence, taken before a read-only checker sees the worktree. */
import { stripVTControlCharacters } from 'node:util';
import { gitExec } from '../workspace/git/git-exec';
import { buildCliEnv } from '../cli/cli-environment';
import { extractVerifyFailureKeys, failedTestNames } from '../orchestration/verify-failure-keys';
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
  /** Where a full test run happened, as the test runner reported it. Absent when it didn't say. */
  ranOn?: string;
  tail: string;
  classification: GateEvidence;
  baseline: 'new' | 'also-failing-on-base';
  failureKeyCounts: Record<string, number>;
  /** Named tests that failed, kept with the verdict so Queue health can spot one failing across unrelated jobs. */
  failingTests?: string[];
}
interface GateExecution { exitCode: number; output: string; timedOut?: boolean }
type ExecuteGate = (command: string, cwd: string, signal?: AbortSignal, extraEnv?: Record<string, string>) => Promise<GateExecution>;
export interface GateInput {
  cwd: string; head: string; commands: readonly string[]; signal?: AbortSignal;
  scope?: string;
  onExecution?: () => void;
  baseSha?: string;
  withBaseline?: <T>(action: (cwd: string) => Promise<T>) => Promise<T>;
  extraEnv?: Record<string, string>;
}

/** As `scripts/run-tests-quiet.js` prints it: `Ran on the Mac in ...`. */
const MAC = 'the Mac';
const MAX_TAIL_CHARS = 2048;
const MAX_MACHINE_CHARS = 200;
const MAX_FAILING_TESTS = 20;
const MAX_TEST_NAME_CHARS = 300;
const STAY_ON_THE_MAC = { AIO_REMOTE_CHECKS: 'off' };
const MACHINE_MISMATCH_NOTE = '\nThe comparison with main ran on a different machine, so this check did not finish.';

/** `scripts/run-tests-quiet.js` prints this line for every run it routes. */
function ranOn(output: string): string | undefined {
  return [...stripVTControlCharacters(output).matchAll(/^\s*Ran on (.+?) in \d/gm)].at(-1)?.[1]?.slice(0, MAX_MACHINE_CHARS);
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

const executeGate: ExecuteGate = (command, cwd, signal, extraEnv) => runInProcessGroup(command, [], {
  cwd, shell: true, env: { ...buildCliEnv(), ...QUEUE_TEST_ENV, AIO_TEST_SUMMARY: '0', ...extraEnv }, timeoutMs: GATE_TIMEOUT_MS,
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

  /** Resume asks for a fresh check: a replayed failure wouldn't show that the computer has since been fixed. */
  forgetCommit(head: string): void {
    for (const key of this.cache.keys()) if ((JSON.parse(key) as unknown[])[1] === head) this.cache.delete(key);
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
      const result = await this.execute(command, input.cwd, input.signal, input.extraEnv);
      input.signal?.throwIfAborted();
      const timedOut = result.timedOut === true;
      const machine = ranOn(result.output);
      const output = result.output.replaceAll(input.cwd, '');
      const tests = failedTestNames(output).slice(0, MAX_FAILING_TESTS).map(name => name.slice(0, MAX_TEST_NAME_CHARS));
      receipts.push({ command, head: input.head, testedTree, exitCode: timedOut ? 1 : result.exitCode, timedOut,
        ...(machine ? { ranOn: machine } : {}),
        durationMs: Date.now() - started, tail: Buffer.from(result.output).subarray(-2048).toString('utf8').replace(/^\uFFFD+/, ''),
        classification: timedOut ? 'failed' : classifyGateEvidence(command, result.exitCode, result.output), baseline: 'new',
        failureKeyCounts: Object.fromEntries(extractVerifyFailureKeys(output, {
          truncated: result.output.length >= 256_000, failureKind: 'command',
        }).keys), ...(tests.length ? { failingTests: tests } : {}) });
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
      // Failures are matched by their message, which can differ between machines, so the run on main
      // has to happen where this one did. If this one fell back to the Mac, main must not go elsewhere.
      const onlyOnMac = receipts.some(receipt => receipt.classification === 'failed' && receipt.ranOn === MAC);
      const base = await this.baseline(onlyOnMac ? { ...input, extraEnv: { ...input.extraEnv, ...STAY_ON_THE_MAC } } : input);
      for (const receipt of receipts) {
        const original = base.find(candidate => candidate.command === receipt.command);
        // Only when both sides say: a run that failed before the test runner chose a machine names none.
        if (receipt.classification === 'failed' && !receipt.timedOut && original?.ranOn && receipt.ranOn && original.ranOn !== receipt.ranOn) {
          // Marking this "new" would block the job on a difference between machines, not on its code.
          receipt.timedOut = true;
          receipt.tail = `${receipt.tail}${MACHINE_MISMATCH_NOTE}`.slice(-MAX_TAIL_CHARS);
          continue;
        }
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
    const key = JSON.stringify([input.scope ?? input.cwd, input.baseSha, input.commands, input.extraEnv]);
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
      cwd, head: input.baseSha!, commands: input.commands, signal: input.signal, extraEnv: input.extraEnv,
    }));
    this.pendingBases.set(key, { result, signal: input.signal });
    try {
      const base = await result;
      input.signal?.throwIfAborted();
      if (this.baseCache.size >= 20) this.baseCache.delete(this.baseCache.keys().next().value!);
      // A run on main free to go anywhere that fell back to the Mac is that moment's outage, not a
      // lasting answer: kept, it would mismatch every later job that ran on the PC.
      const fellBack = !input.extraEnv && base.some(receipt => receipt.ranOn === MAC);
      if (!fellBack && !base.some(receipt => receipt.timedOut)) this.baseCache.set(key, base);
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

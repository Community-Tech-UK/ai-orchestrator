import { describe, expect, it, vi } from 'vitest';
import { LoopVerificationRunLedger } from './loop-verification-run-ledger';
import type { VerificationRun } from './verification-run-store';
import type { VerifyOutcome } from './loop-completion-detector';
import { runLoopVerify } from './loop-verify-runner';
import type { LoopState } from '../../shared/types/loop.types';

describe('LoopVerificationRunLedger read seam', () => {
  it('returns durable rows supplied by the injected reader', () => {
    const ledger = new LoopVerificationRunLedger();
    const rows = [{ id: 'verify-1' }] as unknown as VerificationRun[];
    ledger.setRunReader({
      listForLoop: (loopRunId) => {
        expect(loopRunId).toBe('loop-1');
        return rows;
      },
    });

    expect(ledger.listForLoop('loop-1')).toBe(rows);
  });

  it('fails open when no durable reader is available', () => {
    const ledger = new LoopVerificationRunLedger();
    ledger.setRunReader(null);

    expect(ledger.listForLoop('loop-1')).toBeUndefined();
  });
});

/**
 * L2 — identical-tree verify replay. The ledger owns the tree hash and the
 * store; `runLoopVerify` owns when the port is consulted, so the anti-flake
 * second pass still runs for real on a fresh tree.
 */
describe('LoopVerificationRunLedger identical-tree replay port (L2)', () => {
  function stateFor(verifyCommand = 'npm run verify'): LoopState {
    return {
      id: 'loop-1',
      config: {
        workspaceCwd: '/repo',
        completion: { verifyCommand, quickVerifyCommand: '' },
      },
    } as unknown as LoopState;
  }

  function ledgerWithHash(hash: string | null): LoopVerificationRunLedger {
    const ledger = new LoopVerificationRunLedger();
    ledger.setRecorder(null);
    ledger.setRunReader(null);
    ledger.setTreeHasher(() => hash);
    return ledger;
  }

  const commandRed: VerifyOutcome = {
    status: 'failed',
    output: '3 tests failed',
    durationMs: 1_000,
    exitCode: 1,
    failureKind: 'command',
  };

  const skipped: VerifyOutcome = { status: 'skipped', output: '', durationMs: 0 };

  async function runWith(
    ledger: LoopVerificationRunLedger,
    state: LoopState,
    runVerify: () => Promise<VerifyOutcome>,
    runVerifyTwice = false,
  ) {
    return runLoopVerify<VerifyOutcome>({
      runQuickVerify: async () => skipped,
      runVerify,
      runVerifyTwice,
      replay: ledger.replayPortFor(state, 'verify'),
    });
  }

  it('replays a command red instead of re-running an identical tree', async () => {
    const ledger = ledgerWithHash('tree-a');
    const state = stateFor();
    const runVerify = vi.fn<() => Promise<VerifyOutcome>>().mockResolvedValue(commandRed);

    await runWith(ledger, state, runVerify);
    const second = await runWith(ledger, state, runVerify);

    expect(runVerify).toHaveBeenCalledTimes(1);
    expect(second.replayed).toBe(true);
    expect(second.final.status).toBe('failed');
    expect(second.final.output).toContain('Verify was NOT re-run');
    expect(second.final.output).toContain('3 tests failed');
  });

  // The anti-flake retry is the whole point of runVerifyTwice: a red first pass
  // must still get a real second run rather than a cache read.
  it('never short-circuits the anti-flake second pass with the replay', async () => {
    const ledger = ledgerWithHash('tree-a');
    const green: VerifyOutcome = { status: 'passed', output: 'ok', durationMs: 5 };
    const runVerify = vi.fn<() => Promise<VerifyOutcome>>()
      .mockResolvedValueOnce(commandRed)
      .mockResolvedValueOnce(green);

    const result = await runWith(ledger, stateFor(), runVerify, true);

    expect(runVerify).toHaveBeenCalledTimes(2);
    expect(result.final.status).toBe('passed');
  });

  it('re-runs when the tree hash changed', async () => {
    const ledger = new LoopVerificationRunLedger();
    ledger.setRecorder(null);
    ledger.setRunReader(null);
    let hash = 'tree-a';
    ledger.setTreeHasher(() => hash);
    const state = stateFor();
    const runVerify = vi.fn<() => Promise<VerifyOutcome>>().mockResolvedValue(commandRed);

    await runWith(ledger, state, runVerify);
    hash = 'tree-b';
    await runWith(ledger, state, runVerify);

    expect(runVerify).toHaveBeenCalledTimes(2);
  });

  it('re-runs when the verify command changed', async () => {
    const ledger = ledgerWithHash('tree-a');
    const runVerify = vi.fn<() => Promise<VerifyOutcome>>().mockResolvedValue(commandRed);

    await runWith(ledger, stateFor('npm run verify'), runVerify);
    await runWith(ledger, stateFor('npm run verify:fast'), runVerify);

    expect(runVerify).toHaveBeenCalledTimes(2);
  });

  it('never replays an environment failure — it can heal without a tree change', async () => {
    const ledger = ledgerWithHash('tree-a');
    const envRed: VerifyOutcome = {
      status: 'failed',
      output: 'Cannot find module',
      durationMs: 5,
      exitCode: 1,
      failureKind: 'environment',
    };
    const state = stateFor();
    const runVerify = vi.fn<() => Promise<VerifyOutcome>>().mockResolvedValue(envRed);

    await runWith(ledger, state, runVerify);
    await runWith(ledger, state, runVerify);

    expect(runVerify).toHaveBeenCalledTimes(2);
  });

  it('never replays a pass', async () => {
    const ledger = ledgerWithHash('tree-a');
    const green: VerifyOutcome = { status: 'passed', output: 'ok', durationMs: 5 };
    const state = stateFor();
    const runVerify = vi.fn<() => Promise<VerifyOutcome>>().mockResolvedValue(green);

    await runWith(ledger, state, runVerify);
    await runWith(ledger, state, runVerify);

    expect(runVerify).toHaveBeenCalledTimes(2);
  });

  it('fails open when the tree hash cannot be computed', async () => {
    const ledger = ledgerWithHash(null);
    const state = stateFor();
    const runVerify = vi.fn<() => Promise<VerifyOutcome>>().mockResolvedValue(commandRed);

    expect(ledger.replayPortFor(state, 'verify')).toBeUndefined();
    await runWith(ledger, state, runVerify);
    await runWith(ledger, state, runVerify);

    expect(runVerify).toHaveBeenCalledTimes(2);
  });

  it('drops replayable results when the loop run is cleared', async () => {
    const ledger = ledgerWithHash('tree-a');
    const state = stateFor();
    const runVerify = vi.fn<() => Promise<VerifyOutcome>>().mockResolvedValue(commandRed);

    await runWith(ledger, state, runVerify);
    ledger.clearReplayCache(state.id);
    await runWith(ledger, state, runVerify);

    expect(runVerify).toHaveBeenCalledTimes(2);
  });
});

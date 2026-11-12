import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultLoopConfig } from '../../shared/types/loop.types';
import type { VerifyOutcome } from './loop-completion-detector';
import { LoopCompletionDetector } from './loop-completion-detector';
import { runVerifyUntilItRuns, VERIFY_NOT_RUN_RETRY_MS } from './loop-verify-not-run';

const notRun: VerifyOutcome = { status: 'failed', output: 'Not run: both test machines are paused\n', durationMs: 5, exitCode: 69, failureKind: 'command' };
const passed: VerifyOutcome = { status: 'passed', output: 'all good', durationMs: 5 };

describe('a loop verify no test machine could take', () => {
  it('waits and runs the verify again, never reporting a failure, and says why it is waiting', async () => {
    const attempt = vi.fn<() => Promise<VerifyOutcome>>().mockResolvedValueOnce(notRun).mockResolvedValueOnce(passed);
    const wait = vi.fn(async () => true);
    const onWaiting = vi.fn();
    expect(await runVerifyUntilItRuns(attempt, 'verify', { wait, onWaiting })).toBe(passed);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(VERIFY_NOT_RUN_RETRY_MS);
    expect(onWaiting).toHaveBeenCalledWith('Waiting for a test machine: both test machines are paused. The verify runs again in 5 minutes.');
  });

  it('returns a real failure as it is, without waiting', async () => {
    const failed: VerifyOutcome = { status: 'failed', output: 'Not run: printed by a test\n1 failed', durationMs: 5, exitCode: 1, failureKind: 'command' };
    const wait = vi.fn(async () => true);
    expect(await runVerifyUntilItRuns(async () => failed, 'verify', { wait })).toBe(failed);
    expect(wait).not.toHaveBeenCalled();
  });

  it('returns another command\'s exit 69 as a failure when the runner\'s line is missing', async () => {
    const failed: VerifyOutcome = { status: 'failed', output: 'service unavailable\n', durationMs: 5, exitCode: 69, failureKind: 'command' };
    const wait = vi.fn(async () => true);
    expect(await runVerifyUntilItRuns(async () => failed, 'verify', { wait })).toBe(failed);
    expect(wait).not.toHaveBeenCalled();
  });

  it('calls it infrastructure trouble, not failing tests, when there is no loop to wait in', async () => {
    expect(await runVerifyUntilItRuns(async () => notRun, 'verify', undefined)).toMatchObject({ status: 'failed', failureKind: 'infra' });
  });

  it('reports a cancel during the wait as cancelled', async () => {
    const attempt = vi.fn(async () => notRun);
    expect(await runVerifyUntilItRuns(attempt, 'quick-verify', { wait: async () => false }))
      .toMatchObject({ status: 'failed', failureKind: 'cancelled', exitCode: null });
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});

describe('LoopCompletionDetector waiting for a test machine', () => {
  let workspace: string;
  beforeEach(() => { workspace = mkdtempSync(join(tmpdir(), 'loop-verify-not-run-')); });
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  it('shows the wait for that loop, and cancelling the loop ends it', async () => {
    const script = join(workspace, 'not-run.js');
    writeFileSync(script, "console.log('Not run: both test machines are paused'); process.exit(69);\n");
    const onWaiting = vi.fn();
    const detector = new LoopCompletionDetector(onWaiting);
    const config = defaultLoopConfig(workspace, 'x');
    config.completion.verifyCommand = `"${process.execPath.replace(/"/g, '\\"')}" "${script}"`;
    config.completion.verifyTimeoutMs = 10_000;
    const outcome = detector.runVerify(config, 'loop-1');
    await vi.waitFor(() => expect(onWaiting).toHaveBeenCalled(), { timeout: 10_000 });
    expect(onWaiting.mock.calls[0]).toEqual(['loop-1', expect.stringContaining('Waiting for a test machine: both test machines are paused.')]);
    await detector.abortVerify('loop-1');
    expect(await outcome).toMatchObject({ status: 'failed', failureKind: 'cancelled' });
  });
});

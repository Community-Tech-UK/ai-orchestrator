import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runLoopVerify } from './loop-verify-runner';
import type { VerifyOutcomeLike } from './loop-coordinator-utils';

const passed = (output = 'ok'): VerifyOutcomeLike => ({ status: 'passed', output });
const failed = (output = 'nope'): VerifyOutcomeLike => ({
  status: 'failed',
  output,
  failureKind: 'command',
});
const skipped: VerifyOutcomeLike = { status: 'skipped', output: '' };

describe('runLoopVerify', () => {
  it('returns the quick-verify failure without running the full verify', async () => {
    const runVerify = vi.fn().mockResolvedValue(passed());
    const result = await runLoopVerify({
      runQuickVerify: async () => failed('tsc'),
      runVerify,
      runVerifyTwice: true,
    });

    expect(runVerify).not.toHaveBeenCalled();
    expect(result.final.output).toBe('tsc');
    expect(result.verifyLabel).toBe('quick verify');
    expect(result.resolverVerifyLabel).toBe('quick-verify');
  });

  it('skips the second pass when runVerifyTwice is off', async () => {
    const runVerify = vi.fn().mockResolvedValue(passed());
    const result = await runLoopVerify({
      runQuickVerify: async () => skipped,
      runVerify,
      runVerifyTwice: false,
    });

    expect(runVerify).toHaveBeenCalledTimes(1);
    expect(result.final.status).toBe('passed');
    expect(result.resolverVerifyLabel).toBe('verify');
  });

  it('runs verify twice only after a non-skipped first pass', async () => {
    const runVerify = vi.fn()
      .mockResolvedValueOnce(passed('v1'))
      .mockResolvedValueOnce(failed('v2'));
    const result = await runLoopVerify({
      runQuickVerify: async () => skipped,
      runVerify,
      runVerifyTwice: true,
    });

    expect(runVerify).toHaveBeenCalledTimes(2);
    expect(result.final.output).toBe('v2');
    expect(result.resolverVerifyLabel).toBe('second-verify');
  });
});

describe('T16 loop transcripts vs RLM compaction', () => {
  it('never calls getSmartCompactionManager from the loop coordinator', () => {
    const src = readFileSync(join(process.cwd(), 'src/main/orchestration/loop-coordinator.ts'), 'utf8');
    expect(src).not.toContain('getSmartCompactionManager');
  });
});

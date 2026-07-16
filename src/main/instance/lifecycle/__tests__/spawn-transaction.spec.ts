import { describe, expect, it, vi } from 'vitest';
import { createSpawnTransaction } from '../spawn-transaction';

describe('SpawnTransaction', () => {
  it('runs rollback actions in LIFO order', async () => {
    const calls: string[] = [];
    const transaction = createSpawnTransaction('spawn-test');

    transaction.addRollback('first', () => { calls.push('first'); });
    transaction.addRollback('second', async () => { calls.push('second'); });
    transaction.addRollback('third', () => { calls.push('third'); });

    await transaction.rollback(new Error('spawn failed'));

    expect(calls).toEqual(['third', 'second', 'first']);
  });

  it('continues rollback after one cleanup action fails', async () => {
    const calls: string[] = [];
    const transaction = createSpawnTransaction('spawn-test');

    transaction.addRollback('first', () => { calls.push('first'); });
    transaction.addRollback('broken', () => {
      calls.push('broken');
      throw new Error('cleanup failed');
    });
    transaction.addRollback('third', () => { calls.push('third'); });

    await transaction.rollback(new Error('spawn failed'));

    expect(calls).toEqual(['third', 'broken', 'first']);
  });

  it('does not run rollback actions after commit', async () => {
    const cleanup = vi.fn();
    const transaction = createSpawnTransaction('spawn-test');

    transaction.addRollback('cleanup', cleanup);
    transaction.commit();
    await transaction.rollback(new Error('ignored'));

    expect(cleanup).not.toHaveBeenCalled();
  });

  it('redacts secret-looking rollback failure details', async () => {
    const warn = vi.fn();
    const transaction = createSpawnTransaction('spawn-test', {
      warn,
    });

    transaction.addRollback('secret-cleanup', () => {
      throw new Error('token=sk-test-1234567890abcdef password=hunter2');
    });

    await transaction.rollback(new Error('spawn failed'));

    const metadata = warn.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(metadata['error']).not.toContain('sk-test-1234567890abcdef');
    expect(metadata['error']).not.toContain('hunter2');
    expect(metadata['error']).toContain('<redacted-secret>');
  });
});

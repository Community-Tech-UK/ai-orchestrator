import { describe, expect, it, vi } from 'vitest';
import { exitOneShotProcess } from './one-shot-process-exit';

describe('exitOneShotProcess', () => {
  it('terminates a utility-process entrypoint with the completed operation result', () => {
    const operation = vi.fn(() => 72);
    const exitSignal = new Error('exit called');
    const exit = vi.fn((_code: number): never => {
      throw exitSignal;
    });

    expect(() => exitOneShotProcess(operation, exit)).toThrow(exitSignal);
    expect(operation).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(72);
  });
});

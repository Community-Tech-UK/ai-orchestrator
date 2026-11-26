import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoopState } from '../../shared/types/loop.types';

const harness = vi.hoisted(() => ({
  readLoops: vi.fn<() => Pick<LoopState, 'chatId' | 'status' | 'endedAt'>[]>(),
  loadCoordinator: vi.fn(),
}));
vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>();
  const createRequire = () => harness.loadCoordinator;
  return { ...actual, createRequire, default: { ...actual, createRequire } };
});

import { sessionHostsActiveLoop } from './session-hosts-active-loop';

describe('session loop ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.readLoops.mockReturnValue([]);
    harness.loadCoordinator.mockReturnValue({ getLoopCoordinator: () => ({ getActiveLoops: harness.readLoops }) });
  });

  it.each([
    ['running', null, true],
    ['paused', null, true],
    ['provider-limit', null, true],
    ['provider-limit', 100, false],
    ['completed', 100, false],
    ['cancelled', 100, false],
    ['needs-human-arbitration', 100, false],
  ] as const)('classifies %s with endedAt %s as owned: %s', (status, endedAt, expected) => {
    expect(sessionHostsActiveLoop('chat', () => [{ chatId: 'chat', status, endedAt }])).toBe(expected);
    expect(harness.loadCoordinator).not.toHaveBeenCalled();
  });

  it('ignores active loops belonging to another chat', () => {
    expect(sessionHostsActiveLoop('ordinary', () => [{ chatId: 'other', status: 'running', endedAt: null }])).toBe(false);
  });

  it('resolves the runtime coordinator lazily and reads current ownership on every inspection', () => {
    expect(harness.loadCoordinator).not.toHaveBeenCalled();
    harness.readLoops.mockReturnValue([{ chatId: 'chat', status: 'running', endedAt: null }]);
    expect(sessionHostsActiveLoop('chat')).toBe(true);
    harness.readLoops.mockReturnValue([{ chatId: 'chat', status: 'completed', endedAt: 100 }]);
    expect(sessionHostsActiveLoop('chat')).toBe(false);
    expect(harness.loadCoordinator).toHaveBeenCalledWith('./loop-coordinator');
  });

  it('preserves the chat if the runtime coordinator cannot be loaded', () => {
    harness.loadCoordinator.mockImplementationOnce(() => { throw new Error('runtime unavailable'); });
    expect(sessionHostsActiveLoop('chat')).toBe(true);
  });

  it('preserves the chat if its loop state cannot be read', () => {
    expect(sessionHostsActiveLoop('chat', () => { throw new Error('state unavailable'); })).toBe(true);
  });
});

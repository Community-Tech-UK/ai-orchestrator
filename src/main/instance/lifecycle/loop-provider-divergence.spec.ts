import { describe, it, expect, beforeEach } from 'vitest';

import { describeLoopProviderDivergence } from './loop-provider-divergence';

import type { LoopState } from '../../../shared/types/loop.types';

interface LoopLike {
  chatId?: string;
  status?: LoopState['status'];
  endedAt?: number | null;
  config?: { provider?: string };
}
const state = { activeLoops: [] as LoopLike[], throwOnRead: false };
const readLoops = (): LoopLike[] => {
  if (state.throwOnRead) throw new Error('coordinator unavailable');
  return state.activeLoops;
};
const describe_ = (instanceId: string, provider: string) =>
  describeLoopProviderDivergence(instanceId, provider, readLoops);

/**
 * LT-020, second half. A `same-session` loop runs on the instance's adapter but
 * keeps its own configured provider, so a swap leaves the badge and the loop
 * disagreeing. The decision was to keep them decoupled and *say so* — these pin
 * that the notice appears exactly when it should and never otherwise.
 */
describe('describeLoopProviderDivergence (LT-020)', () => {
  beforeEach(() => {
    state.activeLoops = [];
    state.throwOnRead = false;
  });

  it('describes the divergence when a live loop keeps a different provider', () => {
    state.activeLoops = [{ chatId: 'inst-1', status: 'running', config: { provider: 'claude' } }];

    const notice = describe_('inst-1', 'codex');

    expect(notice).toContain('now on codex');
    expect(notice).toContain('stays on claude');
    // It must tell the user what to do about it, not just that it happened.
    expect(notice).toContain('Stop and restart the loop');
  });

  it('says nothing when the loop is already on the new provider', () => {
    state.activeLoops = [{ chatId: 'inst-1', status: 'running', config: { provider: 'codex' } }];
    expect(describe_('inst-1', 'codex')).toBeNull();
  });

  it('says nothing when the instance has no loop', () => {
    state.activeLoops = [{ chatId: 'other', status: 'running', config: { provider: 'claude' } }];
    expect(describe_('inst-1', 'codex')).toBeNull();
  });

  it('ignores a loop that has already finished', () => {
    state.activeLoops = [
      { chatId: 'inst-1', status: 'completed', config: { provider: 'claude' } },
      { chatId: 'inst-1', status: 'cancelled', config: { provider: 'claude' } },
    ];
    expect(describe_('inst-1', 'codex')).toBeNull();
  });

  it('still notices a paused loop — the work is still attached to the session', () => {
    state.activeLoops = [{ chatId: 'inst-1', status: 'paused', config: { provider: 'claude' } }];
    expect(describe_('inst-1', 'codex')).toContain('stays on claude');
  });

  it('never throws — a notice must not break a change that already applied', () => {
    state.throwOnRead = true;
    expect(() => describe_('inst-1', 'codex')).not.toThrow();
    expect(describe_('inst-1', 'codex')).toBeNull();
  });
});

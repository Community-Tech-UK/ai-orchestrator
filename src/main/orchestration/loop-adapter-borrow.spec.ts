import { describe, it, expect, beforeEach } from 'vitest';
import { decideAdapterBorrow, type BorrowInstanceManager, type BorrowRequest } from './loop-adapter-borrow';
import {
  beginRuntimeChange,
  isAdapterOnLoan,
  endAdapterLoan,
  _resetAdapterLoansForTesting,
} from '../instance/lifecycle/adapter-loan-registry';

function managerWith(instance: Record<string, unknown> | undefined, adapter: unknown): BorrowInstanceManager {
  return {
    getInstance: () => instance,
    getAdapter: () => adapter,
  };
}

const liveAdapter = { sendMessage: async () => ({ content: '' }) };

function request(overrides: Partial<BorrowRequest> = {}): BorrowRequest {
  return {
    chatId: 'chat-1',
    loopRunId: 'loop-1',
    provider: 'claude',
    model: undefined,
    workspaceCwd: '/w',
    executionCwd: '/w',
    contextStrategy: 'same-session',
    ...overrides,
  } as BorrowRequest;
}

describe('decideAdapterBorrow (LT-020 / LT-030)', () => {
  beforeEach(() => {
    _resetAdapterLoansForTesting();
  });

  it('borrows a matching claude adapter and takes the loan', async () => {
    const d = await decideAdapterBorrow(managerWith({ provider: 'claude' }, liveAdapter), request());

    expect(d.borrowedFromInstance).toBe(true);
    expect(d.reusedAdapter).toBe(liveAdapter);
    expect(d.adapterLoan).toBeDefined();
    expect(isAdapterOnLoan('chat-1')).toBe(true);

    endAdapterLoan(d.adapterLoan);
    expect(isAdapterOnLoan('chat-1')).toBe(false);
  });

  /**
   * The loan exists to stop a runtime change tearing down an adapter a loop is
   * mid-iteration on. Claiming one when nothing was borrowed would park real
   * swaps behind an iteration that never touches the instance's adapter.
   */
  it('takes no loan when nothing is borrowed', async () => {
    const cases: BorrowInstanceManager[] = [
      managerWith({ provider: 'codex' }, liveAdapter),   // non-borrowable provider
      managerWith({ provider: 'claude' }, undefined),    // no live adapter
      managerWith(undefined, liveAdapter),               // no live instance
      managerWith({ provider: 'claude' }, {}),           // not a base-CLI adapter
    ];

    for (const manager of cases) {
      const d = await decideAdapterBorrow(manager, request());
      expect(d.borrowedFromInstance).toBe(false);
      expect(d.reusedAdapter).toBeUndefined();
      expect(d.adapterLoan).toBeUndefined();
      expect(isAdapterOnLoan('chat-1')).toBe(false);
    }
  });

  it('does not borrow into an isolated worktree', async () => {
    const d = await decideAdapterBorrow(
      managerWith({ provider: 'claude' }, liveAdapter),
      request({ executionCwd: '/w/.worktrees/x', workspaceCwd: '/w' }),
    );
    expect(d.borrowedFromInstance).toBe(false);
  });

  it('does not borrow when the live model differs from the requested one', async () => {
    const d = await decideAdapterBorrow(
      managerWith({ provider: 'claude', currentModel: 'opus' }, liveAdapter),
      request({ model: 'haiku' }),
    );
    expect(d.borrowedFromInstance).toBe(false);
  });

  /**
   * LT-030. The whole point of the await is that a swap in flight must settle
   * before the adapter is read — otherwise the loop takes a turn on an adapter
   * the reconciler is still terminating.
   */
  it('waits for an in-flight runtime change before deciding', async () => {
    const claim = beginRuntimeChange('chat-1');
    let settled = false;
    const pending = decideAdapterBorrow(managerWith({ provider: 'claude' }, liveAdapter), request())
      .then((d) => { settled = true; return d; });

    await Promise.resolve();
    expect(settled).toBe(false);

    claim.release();
    const d = await pending;
    expect(settled).toBe(true);
    expect(d.borrowedFromInstance).toBe(true);
    endAdapterLoan(d.adapterLoan);
  });

  it('does not wait when the strategy is not same-session', async () => {
    beginRuntimeChange('chat-1');   // never released
    const d = await decideAdapterBorrow(
      managerWith({ provider: 'claude' }, liveAdapter),
      request({ contextStrategy: 'fresh' }),
    );
    expect(d.borrowedFromInstance).toBe(false);
  });

  it('returns the live instance for evidence attribution', async () => {
    const instance = { provider: 'claude', providerSessionId: 'sess-9' };
    const d = await decideAdapterBorrow(managerWith(instance, liveAdapter), request());
    expect(d.liveInstance).toBe(instance);
    endAdapterLoan(d.adapterLoan);
  });
});

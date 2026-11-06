import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Automation } from '../../shared/types/automation.types';
import { cancelInstanceProviderLimitResumes } from './instance-provider-limit-resume-scheduler';

const { store } = vi.hoisted(() => ({
  store: { list: vi.fn(), delete: vi.fn() },
}));
vi.mock('../automations', () => ({ getAutomationStore: () => store }));
vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function resume(id: string, instanceId: string, overrides: Partial<Automation> = {}, historyEntryId?: string): Automation {
  return {
    id, active: true,
    destination: { kind: 'thread', instanceId, reviveIfArchived: true, ...(historyEntryId ? { historyEntryId } : {}) },
    action: { systemAction: { type: 'instanceProviderLimitResume', instanceId } },
    ...overrides,
  } as Automation;
}

describe('cancelInstanceProviderLimitResumes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.delete.mockResolvedValue({ runningInstanceIds: [] });
  });

  it('deletes pending resumes for this session, by instance or by conversation', async () => {
    store.list.mockResolvedValue([
      resume('same-instance', 'example-session'),
      resume('same-conversation', 'example-earlier-instance', {}, 'example-thread'),
      resume('other-session', 'example-other-session', {}, 'example-other-thread'),
      resume('already-run', 'example-session', { active: false }),
      resume('other-action', 'example-session', { action: { systemAction: { type: 'loopProviderLimitResume', loopRunId: 'x' } } } as never),
    ]);

    await cancelInstanceProviderLimitResumes({ instanceId: 'example-session', historyThreadId: 'example-thread' });

    expect(store.delete.mock.calls.map(([id]) => id)).toEqual(['same-instance', 'same-conversation']);
  });

  it('never matches on a missing conversation id', async () => {
    store.list.mockResolvedValue([resume('other-session', 'example-other-session')]);

    await cancelInstanceProviderLimitResumes({ instanceId: 'example-session' });

    expect(store.delete).not.toHaveBeenCalled();
  });

  it('keeps a failure to read saved resumes from breaking the switch', async () => {
    store.list.mockRejectedValue(new Error('Example store failure'));

    await expect(cancelInstanceProviderLimitResumes({ instanceId: 'example-session' })).resolves.toBeUndefined();
  });
});

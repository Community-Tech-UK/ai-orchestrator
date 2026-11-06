import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Automation } from '../../shared/types/automation.types';
import type { ContextUsage } from '../../shared/types/instance.types';
import type { InstanceManager } from '../instance/instance-manager';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
const listSchedulable = vi.hoisted(() => vi.fn<() => Automation[]>(() => []));
vi.mock('../automations', () => ({ getAutomationStore: () => ({ listSchedulable }) }));
const compactInstance = vi.hoisted(() => vi.fn(async () => ({ success: true })));
vi.mock('../context/context-engine', () => ({ getContextEngine: () => ({ compactInstance }) }));

import { getAutomationEvents, resetAutomationEventsForTesting } from '../automations/automation-events';
import { getPreSleepContext } from '../context/pre-sleep-context';
import { _resetForTesting as resetAsyncWork, getInstanceAsyncWorkRegistry } from '../instance/instance-async-work-registry';
import { setupPreSleepContext, wakeUpOf } from './pre-sleep-context-runtime';

const MIN = 60_000;
const big: ContextUsage = { used: 260_000, total: 1_000_000, percentage: 26, occupancyReported: true };

function automation(patch: Partial<Automation> = {}): Automation {
  return {
    id: 'a1', name: 'Wake', enabled: true, active: true, workspaceId: 'w',
    schedule: { type: 'oneTime', runAt: Date.now() + 180 * MIN, timezone: 'UTC' },
    trigger: { kind: 'schedule' },
    missedRunPolicy: 'skip', concurrencyPolicy: 'skip',
    destination: { kind: 'thread', instanceId: 'chat-1', reviveIfArchived: true },
    action: { prompt: 'Continue.', workingDirectory: '/tmp/x' },
    nextFireAt: Date.now() + 180 * MIN,
    lastFiredAt: null, lastRunId: null, createdAt: 1, updatedAt: 1,
    ...patch,
  } as Automation;
}

describe('wakeUpOf', () => {
  it('reads the wake-up time of an enabled schedule aimed at an existing chat', () => {
    const a = automation();
    expect(wakeUpOf(a)).toEqual({ instanceId: 'chat-1', wakeAt: a.nextFireAt });
  });

  it.each([
    ['a disabled schedule', { enabled: false }],
    ['an inactive schedule', { active: false }],
    ['a schedule that starts a new session', { destination: { kind: 'newInstance' } }],
    ['a provider-limit resume', { action: { prompt: 'x', workingDirectory: '/tmp', systemAction: { type: 'instanceProviderLimitResume', instanceId: 'chat-1' } } }],
    ['a loop resume', { action: { prompt: 'x', workingDirectory: '/tmp', systemAction: { type: 'loopProviderLimitResume', loopRunId: 'l' } } }],
    ['no next run', { nextFireAt: null }],
  ])('ignores %s', (_name, patch) => {
    expect(wakeUpOf(automation(patch as Partial<Automation>))).toBeNull();
  });

  it('ignores a missing automation', () => {
    expect(wakeUpOf(null)).toBeNull();
    expect(wakeUpOf(undefined)).toBeNull();
  });
});

describe('setupPreSleepContext', () => {
  let manager: EventEmitter & Partial<InstanceManager>;
  let detach: () => void;
  const settle = async (): Promise<void> => { await new Promise((resolve) => setImmediate(resolve)); };

  beforeEach(() => {
    compactInstance.mockClear();
    listSchedulable.mockReset().mockReturnValue([]);
    resetAutomationEventsForTesting();
    resetAsyncWork();
    const instance = { id: 'chat-1', provider: 'claude', status: 'idle', contextUsage: big, executionLocation: { type: 'local' } };
    manager = Object.assign(new EventEmitter(), {
      getInstance: vi.fn(() => instance),
      getAdapter: vi.fn(() => undefined),
    }) as unknown as EventEmitter & Partial<InstanceManager>;
    detach = setupPreSleepContext(manager as unknown as InstanceManager);
  });

  afterEach(() => detach());

  const restartWith = (schedules: Automation[]): void => {
    detach();
    listSchedulable.mockReturnValue(schedules);
    detach = setupPreSleepContext(manager as unknown as InstanceManager);
  };

  it('knows a restored near wake-up before a later schedule is created', async () => {
    restartWith([automation({ id: 'near', nextFireAt: Date.now() + 20 * MIN })]);
    getAutomationEvents().emitChanged({ automation: automation(), automationId: 'a1', type: 'created' });
    await settle();
    expect(compactInstance).not.toHaveBeenCalled();
  });

  it.each([false, true])('loads the entire startup snapshot before evaluating it (near first: %s)', async (nearFirst) => {
    const near = automation({ id: 'near', nextFireAt: Date.now() + 20 * MIN });
    const far = automation({ id: 'far' });
    restartWith(nearFirst ? [near, far] : [far, near]);
    await settle();
    expect(compactInstance).not.toHaveBeenCalled();
    getAutomationEvents().emitChanged({ automation: null, automationId: 'near', type: 'deleted' });
    manager.emit('instance:idle', { instanceId: 'chat-1' });
    await settle();
    expect(compactInstance).toHaveBeenCalledExactlyOnceWith('chat-1');
  });

  it('compacts once for restored distant schedules without a later change event', async () => {
    restartWith([automation(), automation({ id: 'a2', nextFireAt: Date.now() + 240 * MIN })]);
    await settle();
    expect(compactInstance).toHaveBeenCalledExactlyOnceWith('chat-1');
  });

  it.each(['deleted', 'disabled', 'retargeted'] as const)('revokes a restored busy claim when %s', async (change) => {
    const instance = vi.mocked(manager.getInstance!)('chat-1')!;
    instance.status = 'busy';
    vi.mocked(manager.getInstance!).mockImplementation((id: string) => id === 'chat-1' ? instance : undefined);
    restartWith([automation()]);
    await settle();
    const updated = change === 'deleted' ? null : automation(change === 'disabled'
      ? { enabled: false }
      : { destination: { kind: 'thread', instanceId: 'chat-2', reviveIfArchived: true } });
    getAutomationEvents().emitChanged({ automation: updated, automationId: 'a1', type: change === 'deleted' ? 'deleted' : 'updated' });
    instance.status = 'idle';
    manager.emit('instance:idle', { instanceId: 'chat-1' });
    await settle();
    expect(compactInstance).not.toHaveBeenCalled();
  });

  it('replaces a restored near wake-up when it is moved farther away', async () => {
    restartWith([automation({ nextFireAt: Date.now() + 20 * MIN })]);
    getAutomationEvents().emitChanged({ automation: automation(), automationId: 'a1', type: 'updated' });
    await settle();
    expect(compactInstance).toHaveBeenCalledExactlyOnceWith('chat-1');
  });

  it('drops restored pending claims on session removal and detaches event listeners', async () => {
    const instance = vi.mocked(manager.getInstance!)('chat-1')!;
    instance.status = 'busy';
    restartWith([automation()]);
    await settle();
    manager.emit('instance:removed', 'chat-1');
    instance.status = 'idle';
    manager.emit('instance:idle', { instanceId: 'chat-1' });
    await settle();
    expect(compactInstance).not.toHaveBeenCalled();
    detach();
    getAutomationEvents().emitChanged({ automation: automation(), automationId: 'a1', type: 'created' });
    manager.emit('instance:idle', { instanceId: 'chat-1' });
    await settle();
    expect(compactInstance).not.toHaveBeenCalled();
    expect(manager.listenerCount('instance:idle')).toBe(0);
    expect(manager.listenerCount('instance:removed')).toBe(0);
  });

  it('compacts a large idle chat when a wake-up is scheduled for hours later', async () => {
    getAutomationEvents().emitChanged({ automation: automation(), automationId: 'a1', type: 'created' });
    await settle();
    expect(compactInstance).toHaveBeenCalledWith('chat-1');
  });

  it('does nothing for a deleted schedule or a near wake-up', async () => {
    getAutomationEvents().emitChanged({ automation: null, automationId: 'a1', type: 'deleted' });
    getAutomationEvents().emitChanged({ automation: automation({ nextFireAt: Date.now() + 20 * MIN }), automationId: 'a1', type: 'updated' });
    await settle();
    expect(compactInstance).not.toHaveBeenCalled();
  });

  it('leaves a chat with background agents alone', async () => {
    getInstanceAsyncWorkRegistry().observe('chat-1', { phase: 'snapshot', work: [{ workId: 't1', kind: 'shell' }] } as never);
    getAutomationEvents().emitChanged({ automation: automation(), automationId: 'a1', type: 'created' });
    await settle();
    expect(compactInstance).not.toHaveBeenCalled();
  });

  it('waits for a busy chat to finish its turn', async () => {
    const instance = vi.mocked(manager.getInstance!)('chat-1')!;
    instance.status = 'busy';
    getAutomationEvents().emitChanged({ automation: automation(), automationId: 'a1', type: 'created' });
    await settle();
    expect(compactInstance).not.toHaveBeenCalled();
    instance.status = 'idle';
    manager.emit('instance:idle', { instanceId: 'chat-1' });
    await settle();
    expect(compactInstance).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['deleted', () => getAutomationEvents().emitChanged({ automation: null, automationId: 'a1', type: 'deleted' })],
    ['disabled', () => getAutomationEvents().emitChanged({ automation: automation({ enabled: false }), automationId: 'a1', type: 'updated' })],
    ['made inactive', () => getAutomationEvents().emitChanged({ automation: automation({ active: false }), automationId: 'a1', type: 'updated' })],
    ['retargeted to another chat', () => getAutomationEvents().emitChanged({
      automation: automation({ destination: { kind: 'thread', instanceId: 'chat-2', reviveIfArchived: true } }),
      automationId: 'a1',
      type: 'updated',
    })],
  ])('drops the pending compaction when its wake-up is %s', async (_name, change) => {
    const instance = vi.mocked(manager.getInstance!)('chat-1')!;
    vi.mocked(manager.getInstance!).mockImplementation((id: string) => (id === 'chat-1' ? instance : undefined));
    instance.status = 'busy';
    getAutomationEvents().emitChanged({ automation: automation(), automationId: 'a1', type: 'created' });
    await settle();
    expect(compactInstance).not.toHaveBeenCalled();
    instance.status = 'idle';
    change();
    await settle();
    manager.emit('instance:idle', { instanceId: 'chat-1' });
    await settle();
    expect(compactInstance).not.toHaveBeenCalled();
  });

  it('keeps another schedule pending when one of them goes away', async () => {
    const instance = vi.mocked(manager.getInstance!)('chat-1')!;
    instance.status = 'busy';
    const soon = automation();
    const later = automation({ id: 'a2', nextFireAt: Date.now() + 240 * MIN });
    getAutomationEvents().emitChanged({ automation: soon, automationId: 'a1', type: 'created' });
    getAutomationEvents().emitChanged({ automation: later, automationId: 'a2', type: 'created' });
    await settle();
    getAutomationEvents().emitChanged({ automation: null, automationId: 'a1', type: 'deleted' });
    await settle();
    instance.status = 'idle';
    manager.emit('instance:idle', { instanceId: 'chat-1' });
    await settle();
    expect(compactInstance).toHaveBeenCalledTimes(1);
  });

  it('registers the service for the loop hand-off, and detaches cleanly', () => {
    expect(getPreSleepContext()).not.toBeNull();
    detach();
    expect(getPreSleepContext()).toBeNull();
    expect(getAutomationEvents().listenerCount('automation:changed')).toBe(0);
    detach = setupPreSleepContext(manager as unknown as InstanceManager);
  });
});

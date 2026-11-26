import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@contracts/channels';
import type { AutomationRun } from '../../shared/types/automation.types';
import { ElectronWindowTransport } from './electron-window-transport';
import { MainEventBus } from './main-event-bus';

describe('automation run attention events', () => {
  const run: AutomationRun = {
    id: 'run-1',
    automationId: 'automation-1',
    status: 'needs-attention',
    trigger: 'scheduled',
    scheduledAt: 100,
    startedAt: 100,
    finishedAt: 200,
    instanceId: null,
    loopRunId: 'loop-1',
    error: 'Loop paused: No progress after 3 checks: open the loop to Resume it',
    outputSummary: null,
    outputFullRef: null,
    idempotencyKey: null,
    triggerSource: null,
    deliveryMode: 'notify',
    seenAt: null,
    createdAt: 100,
    updatedAt: 200,
    configSnapshot: null,
    attempt: 1,
    maxAttempts: 1,
  };

  it('delivers a paused loop run and its reason through the real Electron event boundary', () => {
    const send = vi.fn();
    const bus = new MainEventBus();
    bus.addTransport(new ElectronWindowTransport(() => ({ send })));
    const event = { automationId: run.automationId, run };

    bus.emitRendererEvent(IPC_CHANNELS.AUTOMATION_RUN_CHANGED, event);

    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.AUTOMATION_RUN_CHANGED, event);
  });

  it('continues blocking unknown run statuses at the Electron event boundary', () => {
    const send = vi.fn();
    const bus = new MainEventBus();
    bus.addTransport(new ElectronWindowTransport(() => ({ send })));

    bus.emitRendererEvent(IPC_CHANNELS.AUTOMATION_RUN_CHANGED, {
      automationId: run.automationId,
      run: { ...run, status: 'unknown' },
    });

    expect(send).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Automation, CreateAutomationInput, UpdateAutomationInput } from '../../../shared/types/automation.types';

type Handler = (event: unknown, payload?: unknown) => Promise<unknown>;

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  storeCreate: vi.fn(),
  storeGet: vi.fn(),
  storeUpdate: vi.fn(),
  storeList: vi.fn(),
  schedulerSchedule: vi.fn(),
  runnerUntrack: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Handler) => mocks.handlers.set(channel, handler)),
    removeHandler: vi.fn(),
  },
}));

vi.mock('../../automations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../automations')>();
  return {
    computeNextFireAt: actual.computeNextFireAt,
    validateCronExpression: actual.validateCronExpression,
    computeMissedFireTimes: actual.computeMissedFireTimes,
    getAutomationStore: () => ({
      create: mocks.storeCreate,
      get: mocks.storeGet,
      update: mocks.storeUpdate,
      list: mocks.storeList,
      listRuns: vi.fn(async () => []),
    }),
    getAutomationRunner: () => ({ untrackInstances: mocks.runnerUntrack, fire: vi.fn() }),
    getAutomationScheduler: () => ({ schedule: mocks.schedulerSchedule, deactivate: vi.fn() }),
  };
});

vi.mock('../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ get: () => 'notify' }),
}));

vi.mock('../../automations/automation-events', () => ({
  getAutomationEvents: () => ({
    emitChanged: vi.fn(),
    emitRunChanged: vi.fn(),
    emitRunTerminal: vi.fn(),
    emitScheduleDeactivated: vi.fn(),
    emitOrphanedFire: vi.fn(),
  }),
}));

vi.mock('../../security/task-preflight-service', () => ({
  getTaskPreflightService: () => ({ runPreflight: vi.fn() }),
}));

import { registerAutomationHandlers } from './automation-handlers';

function asResponse(result: unknown): { success: boolean; data?: unknown; error?: { message: string } } {
  return result as { success: boolean; data?: unknown; error?: { message: string } };
}

describe('automation IPC handlers — Automations page may set a check (A15 / 8b)', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    vi.clearAllMocks();
    registerAutomationHandlers();
    mocks.storeCreate.mockImplementation(async (input: CreateAutomationInput) => ({
      id: 'a1',
      ...input,
      trigger: input.trigger ?? { kind: 'schedule' },
      missedRunPolicy: 'notify',
      concurrencyPolicy: 'skip',
      destination: { kind: 'newInstance' },
      nextFireAt: 1,
      lastFiredAt: null,
      lastRunId: null,
      createdAt: 1,
      updatedAt: 1,
      enabled: true,
      active: true,
      workspaceId: '/repo',
    } as Automation));
    mocks.storeGet.mockResolvedValue({
      id: 'a1',
      name: 'Checked job',
      enabled: true,
      active: true,
      workspaceId: '/repo',
      schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
      trigger: { kind: 'schedule' },
      missedRunPolicy: 'notify',
      concurrencyPolicy: 'skip',
      destination: { kind: 'newInstance' },
      action: { prompt: 'Do', workingDirectory: '/repo', preCheck: { command: 'check.sh' } },
      nextFireAt: 1,
      lastFiredAt: null,
      lastRunId: null,
      createdAt: 1,
      updatedAt: 1,
    } as Automation);
  });

  it('the Automations page can create a job with a check', async () => {
    const handler = mocks.handlers.get('automation:create')!;
    const response = asResponse(await handler(undefined, {
      name: 'Checked job',
      schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
      action: {
        prompt: 'Do the job',
        workingDirectory: '/repo',
        preCheck: { command: 'check.sh', onError: 'stop' },
      },
    }));

    expect(response.error).toBeUndefined();
    expect(mocks.storeCreate).toHaveBeenCalledOnce();
    expect(mocks.storeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: expect.objectContaining({ preCheck: { command: 'check.sh', onError: 'stop' } }),
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('the Automations page can update a job and keep its check', async () => {
    mocks.storeUpdate.mockImplementation(async (_id: string, updates: UpdateAutomationInput) => ({
      ...(await mocks.storeGet()),
      action: {
        prompt: 'Do',
        workingDirectory: '/repo',
        preCheck: { command: 'check.sh' },
        ...updates.action,
      },
    }));
    const handler = mocks.handlers.get('automation:update')!;
    const response = asResponse(await handler(undefined, {
      id: 'a1',
      updates: { name: 'Renamed' },
    }));

    expect(response.error).toBeUndefined();
    expect(mocks.storeUpdate).toHaveBeenCalledOnce();
    expect(mocks.schedulerSchedule).toHaveBeenCalledOnce();
  });

  it('rejects a schedule-only update to one-time when the saved action has a check', async () => {
    const response = asResponse(await mocks.handlers.get('automation:update')!(undefined, {
      id: 'a1', updates: { schedule: { type: 'oneTime', runAt: 1_800_000_000_000 } },
    }));
    expect(response.success).toBe(false);
    expect(response.error?.message).toContain('recurring schedule');
    expect(mocks.storeUpdate).not.toHaveBeenCalled();
    expect(mocks.schedulerSchedule).not.toHaveBeenCalled();
  });

  it('rejects adding a check to a saved one-time job when schedule is omitted', async () => {
    const existing = await mocks.storeGet();
    mocks.storeGet.mockResolvedValue({ ...existing, schedule: { type: 'oneTime', runAt: 1_800_000_000_000 } });
    const response = asResponse(await mocks.handlers.get('automation:update')!(undefined, {
      id: 'a1', updates: { action: { prompt: 'Do', workingDirectory: '/repo', preCheck: { command: 'check.sh' } } },
    }));
    expect(response.success).toBe(false);
    expect(response.error?.message).toContain('recurring schedule');
    expect(mocks.storeUpdate).not.toHaveBeenCalled();
  });
});

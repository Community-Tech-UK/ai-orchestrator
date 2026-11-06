import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Automation, CreateAutomationInput } from '../../shared/types/automation.types';

const storeMocks = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
  recordSkipped: vi.fn(),
  completeOneTime: vi.fn(),
  fire: vi.fn(),
}));

vi.mock('./index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./index')>();
  return {
    computeNextFireAt: actual.computeNextFireAt,
    getAutomationStore: () => storeMocks,
    getAutomationRunner: () => ({ fire: storeMocks.fire }),
  };
});

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ get: () => 'notify' }),
}));

vi.mock('./automation-events', () => ({
  getAutomationEvents: () => ({
    emitChanged: vi.fn(),
    emitRunChanged: vi.fn(),
    emitRunTerminal: vi.fn(),
    emitScheduleDeactivated: vi.fn(),
  }),
}));

import { createAutomationWithScheduling } from './automation-create-service';

describe('createAutomationWithScheduling check origin (A15 / 8b item 9)', () => {
  const checkedInput = (): CreateAutomationInput => ({
    name: 'Checked job',
    schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
    action: {
      prompt: 'Do the job',
      workingDirectory: '/repo',
      preCheck: { command: 'check.sh' },
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    storeMocks.create.mockImplementation(async (input: CreateAutomationInput) => ({
      id: 'a1',
      ...input,
      trigger: input.trigger ?? { kind: 'schedule' },
      missedRunPolicy: input.missedRunPolicy ?? 'notify',
      concurrencyPolicy: input.concurrencyPolicy ?? 'skip',
      destination: input.destination ?? { kind: 'newInstance' },
      nextFireAt: 1,
      lastFiredAt: null,
      lastRunId: null,
      createdAt: 1,
      updatedAt: 1,
      enabled: true,
      active: true,
      workspaceId: '/repo',
    } as Automation));
    storeMocks.get.mockImplementation(async (id: string) => ({ id } as Automation));
  });

  it('a create with preCheck and no origin (agent) throws and creates nothing', async () => {
    await expect(createAutomationWithScheduling(checkedInput())).rejects.toThrow(
      'A check command can only be added on the Automations page.',
    );
    expect(storeMocks.create).not.toHaveBeenCalled();
  });

  it('origin automations-page succeeds', async () => {
    const automation = await createAutomationWithScheduling(checkedInput(), 'automations-page');
    expect(automation).toBeTruthy();
    expect(storeMocks.create).toHaveBeenCalledOnce();
    expect(storeMocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: expect.objectContaining({ preCheck: { command: 'check.sh' } }),
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('an agent may still create a job without a check', async () => {
    const input = checkedInput();
    delete input.action.preCheck;
    await expect(createAutomationWithScheduling(input)).resolves.toBeTruthy();
  });
});

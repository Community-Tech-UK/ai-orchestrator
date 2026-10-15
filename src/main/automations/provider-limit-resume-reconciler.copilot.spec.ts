import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutomationSchema } from '../../../packages/contracts/src/schemas/automation.schemas';
import type { Automation, CreateAutomationInput } from '../../shared/types/automation.types';
import { scheduleInstanceProviderLimitResume } from '../instance/instance-provider-limit-resume-scheduler';
import { reconcileProviderLimitResumeAutomations } from './provider-limit-resume-reconciler';

const create = vi.hoisted(() => vi.fn(async (_input: CreateAutomationInput) => ({ id: 'resume' })));
vi.mock('./automation-create-service', () => ({ createAutomationWithScheduling: create }));
vi.mock('./index', () => ({ getAutomationStore: () => ({ delete: vi.fn(async () => true) }) }));
describe('Copilot durable quota-blind resume', () => {
  afterEach(() => { vi.useRealTimers(); create.mockClear(); });
  it('persists blindness through scheduler, contract validation, JSON storage and restart reconciliation', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const cancel = scheduleInstanceProviderLimitResume({ request: { instanceId: 'copilot-chat', workspaceCwd: '/tmp/project', provider: 'copilot',
      resumeAt: now + 6 * 3600_000, reason: 'weekly limit', resumePrompt: 'continue', quotaBlind: true }, resumeInstance: vi.fn() });
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    const input = create.mock.calls[0]?.[0];
    const automation = AutomationSchema.parse({ ...input, id: 'resume', active: true, workspaceId: '/tmp/project',
      trigger: { kind: 'schedule' }, nextFireAt: now + 6 * 3600_000, lastFiredAt: null, lastRunId: null, createdAt: now, updatedAt: now });
    expect(automation.action.systemAction).toMatchObject({ quotaBlind: true });
    const fire = vi.fn();
    const probe = vi.fn(async () => ({ provider: 'copilot' as const, takenAt: now, source: 'header' as const, ok: true,
      windows: [], usageAccess: { ordinaryUsageAllowed: true, creditsAvailable: null } }));
    expect(await reconcileProviderLimitResumeAutomations({ listAutomations: async () => [JSON.parse(JSON.stringify(automation)) as Automation],
      fire, probeQuota: probe, now: () => now })).toBe(0);
    expect(probe).not.toHaveBeenCalled();
    expect(fire).not.toHaveBeenCalled();
    cancel();
  });
});

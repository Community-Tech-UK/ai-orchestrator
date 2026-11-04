import { afterEach, expect, it, vi } from 'vitest';
import { AutomationDispatchDeadline } from './automation-dispatch-deadline';
import type { AutomationRun } from '../../shared/types/automation.types';
import { AutomationActionSchema } from '@contracts/schemas/automation';
afterEach(() => vi.useRealTimers());
it('preserves long migrated limits and expires them at the deadline without timer overflow', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const action = { prompt: 'Long job', workingDirectory: '/repo', maxRunMinutes: 60_000 };
  expect(AutomationActionSchema.safeParse(action).success).toBe(true);
  const expire = vi.fn();
  const deadline = new AutomationDispatchDeadline(Date.now, expire);
  deadline.arm({ id: 'long', startedAt: 0, configSnapshot: { action, schedule: { type: 'cron', expression: '0 0 * * *', timezone: 'UTC' } } } as AutomationRun);
  await vi.advanceTimersByTimeAsync(2_147_000_000);
  expect(expire).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1_453_000_000);
  expect(expire).toHaveBeenCalledOnce();
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaimedAutomationRun, AutomationRun } from '../../shared/types/automation.types';

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  notify: vi.fn(),
  setPending: vi.fn(),
  clearCheckFailure: vi.fn(),
  setRunOutcome: vi.fn(),
  setRunPrompt: vi.fn(),
  recordCheckFailure: vi.fn(),
}));

vi.mock('./automation-pre-check', () => ({ runAutomationPreCheck: mocks.run }));
vi.mock('./automation-check-store', () => ({
  getAutomationCheckStore: () => mocks,
}));
vi.mock('../notifications/notification-service', () => ({
  getNotificationService: () => ({ notify: mocks.notify }),
}));

import { runAutomationPreCheckGate } from './automation-pre-check-gate';

function claimed(trigger: AutomationRun['trigger'] = 'scheduled'): ClaimedAutomationRun {
  const snapshot = {
    name: 'Checked job',
    schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
    trigger: { kind: 'schedule' },
    missedRunPolicy: 'notify',
    concurrencyPolicy: 'skip',
    destination: { kind: 'newInstance' },
    action: { prompt: 'Do the job', workingDirectory: '/repo', preCheck: { command: 'printf state' } },
  } as ClaimedAutomationRun['snapshot'];
  const run = {
    id: 'run-1', automationId: 'job-1', trigger, status: 'running',
    attempt: 1, maxAttempts: 3, configSnapshot: snapshot,
  } as AutomationRun;
  return { run, snapshot, automation: { id: 'job-1' } } as ClaimedAutomationRun;
}

describe('runAutomationPreCheckGate', () => {
  const order: string[] = [];
  const terminalizeRun = vi.fn();
  const markSeen = vi.fn();
  const getRun = vi.fn();
  const handleTerminalRun = vi.fn();
  const host = {
    store: { terminalizeRun, markSeen, getRun },
    now: () => 3_000,
    handleTerminalRun,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    order.length = 0;
    terminalizeRun.mockImplementation((_id, status, error) => {
      order.push('terminalize');
      return { ...claimed().run, status, error, outcome: status === 'skipped' ? 'no-change' : 'check-failed' };
    });
    markSeen.mockImplementation(() => order.push('seen'));
    getRun.mockImplementation(() => ({ ...claimed().run, status: 'skipped', outcome: 'no-change', seenAt: 3_000 }));
    handleTerminalRun.mockImplementation(() => order.push('emit'));
    mocks.recordCheckFailure.mockReturnValue(1);
  });

  it('marks an unchanged run seen before its terminal event and starts no AI', async () => {
    mocks.run.mockResolvedValue({ kind: 'no-change', hash: 'h', output: 'state' });
    expect(await runAutomationPreCheckGate(claimed(), host)).toBe(true);
    expect(order).toEqual(['terminalize', 'seen', 'emit']);
    expect(mocks.setRunOutcome).toHaveBeenCalledWith('run-1', 'no-change');
    expect(mocks.setPending).not.toHaveBeenCalled();
    expect(handleTerminalRun).toHaveBeenCalledWith(expect.objectContaining({ seenAt: 3_000 }), { retryable: false });
  });

  it('persists a changed check once and carries the note into dispatch', async () => {
    mocks.run.mockResolvedValue({ kind: 'changed', hash: 'new-h', output: 'new', note: '<automation_check_result>diff</automation_check_result>' });
    const run = claimed();
    expect(await runAutomationPreCheckGate(run, host)).toBe(false);
    expect(mocks.setPending).toHaveBeenCalledWith('job-1', 'run-1', 'new-h', 'new');
    expect(mocks.setRunPrompt).toHaveBeenCalledWith('run-1', run.snapshot.action.prompt);
    expect(run.snapshot.action.prompt).toContain('<automation_check_result>diff</automation_check_result>');
    expect(terminalizeRun).not.toHaveBeenCalled();
  });

  it('skips checks for manual runs and retries', async () => {
    expect(await runAutomationPreCheckGate(claimed('manual'), host)).toBe(false);
    const retry = claimed();
    retry.run.attempt = 2;
    expect(await runAutomationPreCheckGate(retry, host)).toBe(false);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('stops a broken check without retry and notifies only on the first failure', async () => {
    mocks.run.mockResolvedValue({ kind: 'error', hash: '', output: '', note: 'error note', error: 'exit code 2' });
    const first = claimed();
    first.snapshot.action.preCheck!.onError = 'stop';
    expect(await runAutomationPreCheckGate(first, host)).toBe(true);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'automation-check-failed',
      title: 'Automation check failing',
      body: expect.stringContaining('the run stopped'),
    }));
    expect(handleTerminalRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }), { retryable: false });
    mocks.recordCheckFailure.mockReturnValue(2);
    await runAutomationPreCheckGate(claimed(), host);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });
});

import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import type {
  Automation,
  AutomationFireOutcome,
  AutomationRun,
} from '../../shared/types/automation.types';
import { MobileGatewayAutomationHandlers } from './mobile-gateway-automation-handlers';

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'daily-review',
    name: 'Daily review',
    enabled: true,
    active: true,
    workspaceId: '/repo/private',
    schedule: { type: 'cron', expression: '0 8 * * *', timezone: 'Europe/London' },
    trigger: { kind: 'schedule' },
    missedRunPolicy: 'skip',
    concurrencyPolicy: 'queue',
    destination: { kind: 'newInstance' },
    action: {
      prompt: 'PRIVATE PROMPT',
      workingDirectory: '/repo/private',
      provider: 'auto',
      attachments: [{ id: 'secret', name: 'secret.txt', path: '/secret/path' }],
    },
    nextFireAt: 20_000,
    lastFiredAt: 10_000,
    lastRunId: 'run-1',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  } as Automation;
}

function run(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-1', automationId: 'daily-review', status: 'failed', trigger: 'scheduled',
    scheduledAt: 10_000, startedAt: 10_100, finishedAt: 10_200, instanceId: null,
    loopRunId: null, error: 'PRIVATE FAILURE', outputSummary: null, outputFullRef: null,
    idempotencyKey: null, triggerSource: null, deliveryMode: 'notify', seenAt: null,
    createdAt: 10_000, updatedAt: 10_200, configSnapshot: null, attempt: 1, maxAttempts: 1,
    ...overrides,
  };
}

function setup(fireOutcome: AutomationFireOutcome = { status: 'started', run: run({ status: 'running' }) }) {
  const events = new EventEmitter();
  const listRuns = vi.fn(() => [run()]);
  const list = vi.fn(async (_options?: { limit?: number }) => [automation()]);
  const listLatestRuns = vi.fn((_ids: readonly string[]) => new Map([['daily-review', run()]]));
  const fire = vi.fn(async () => fireOutcome);
  const sendFailedPush = vi.fn();
  const handlers = new MobileGatewayAutomationHandlers({
    getStore: () => ({ list, listRuns, listLatestRuns }),
    getRunner: () => ({ fire }),
    getEvents: () => events,
    getModelDefaults: () => ({
      automationDefaultCli: 'auto', automationDefaultModel: '',
      modelPickerFavorites: ['codex:gpt-5.4', 'claude:claude-sonnet-4-5'],
    }),
    sendFailedPush,
  });
  return { events, fire, handlers, list, listRuns, listLatestRuns, sendFailedPush };
}

describe('MobileGatewayAutomationHandlers', () => {
  it('caps the mobile list at 100 and requests latest runs in exactly one bulk call', async () => {
    const { handlers, list, listRuns, listLatestRuns } = setup();
    const items = Array.from({ length: 250 }, (_, index) => automation({ id: `job-${index}` }));
    list.mockImplementation(async options => items.slice(0, options?.limit));
    listLatestRuns.mockReturnValue(new Map([['job-99', run({ automationId: 'job-99', status: 'succeeded' })]]));
    const result = await handlers.list();
    expect(result).toHaveLength(100);
    expect(list).toHaveBeenCalledWith({ limit: 100 });
    expect(listLatestRuns).toHaveBeenCalledTimes(1);
    expect(listLatestRuns).toHaveBeenCalledWith(items.slice(0, 100).map(item => item.id));
    expect(listRuns).not.toHaveBeenCalled();
    expect(result[0].lastRun).toBeNull();
    expect(result[99].lastRun?.status).toBe('succeeded');
  });
  it('joins the actual last run and resolves an unpinned favourite without leaking action data', async () => {
    const { handlers, listLatestRuns } = setup();

    const result = await handlers.list();

    expect(listLatestRuns).toHaveBeenCalledWith(['daily-review']);
    expect(result).toEqual([{
      id: 'daily-review', name: 'Daily review',
      schedule: { type: 'cron', expression: '0 8 * * *', timezone: 'Europe/London' },
      enabled: true, nextRunAt: 20_000, maxRunMinutes: 90,
      lastRun: { status: 'failed', at: 10_200, result: null, maxRunMinutes: null, paused: false, deadlineAt: null },
      provider: 'codex', model: 'gpt-5.4',
    }]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(JSON.stringify(result)).not.toContain('/repo');
  });

  it('projects the reported result and effective job limit without exposing run content', async () => {
    const { handlers, list, listLatestRuns } = setup();
    const job = automation();
    job.action.maxRunMinutes = 45;
    list.mockResolvedValue([job]);
    listLatestRuns.mockReturnValue(new Map([['daily-review', run({ result: { outcome: 'needs_attention', notify: false } })]]));
    const [item] = await handlers.list();
    expect(item).toMatchObject({ maxRunMinutes: 45,
      lastRun: { result: { outcome: 'needs_attention', notify: false } } });
    expect(JSON.stringify(item)).not.toContain('PRIVATE');
    expect(JSON.stringify(item)).not.toContain('/secret');
  });

  it('projects a running job clock from its run snapshot rather than a later edit to the job', async () => {
    const { handlers, list, listLatestRuns } = setup();
    const job = automation();
    job.action.maxRunMinutes = 120;
    list.mockResolvedValue([job]);
    const configSnapshot = { name: job.name, schedule: job.schedule, trigger: job.trigger,
      concurrencyPolicy: job.concurrencyPolicy, missedRunPolicy: job.missedRunPolicy, destination: job.destination,
      action: { ...job.action, maxRunMinutes: 10 }, runClock: { pausedAt: null, pausedMs: 60_000 } };
    listLatestRuns.mockReturnValue(new Map([['daily-review', run({ status: 'running', startedAt: 10_000, finishedAt: null, configSnapshot })]]));
    const [item] = await handlers.list();
    expect(item).toMatchObject({ maxRunMinutes: 120, lastRun: {
      status: 'running', at: 10_000, maxRunMinutes: 10, result: null, paused: false, deadlineAt: 670_000,
    } });
  });

  it('reports a paused run explicitly while leaving jobs without a last run alone', async () => {
    const { handlers, listLatestRuns } = setup();
    const job = automation();
    const configSnapshot = { name: job.name, schedule: job.schedule, trigger: job.trigger,
      concurrencyPolicy: job.concurrencyPolicy, missedRunPolicy: job.missedRunPolicy, destination: job.destination,
      action: job.action, runClock: { pausedAt: 20_000, pausedMs: 0 } };
    listLatestRuns.mockReturnValue(new Map([['daily-review', run({ status: 'running', finishedAt: null, configSnapshot })]]));
    expect((await handlers.list())[0].lastRun).toMatchObject({ paused: true, maxRunMinutes: 90 });
    listLatestRuns.mockReturnValue(new Map());
    expect((await handlers.list())[0]).toMatchObject({ maxRunMinutes: 90, lastRun: null });
  });

  it.each([
    [{ status: 'started', run: run({ id: 'started', status: 'running' }) } as AutomationFireOutcome, { status: 'started', runId: 'started' }],
    [{ status: 'queued', run: run({ id: 'queued', status: 'pending' }) } as AutomationFireOutcome, { status: 'queued', runId: 'queued' }],
    [{ status: 'skipped', run: run({ id: 'skipped', status: 'skipped' }), reason: 'Provider excluded' } as AutomationFireOutcome,
      { status: 'skipped', runId: 'skipped', reason: 'Provider excluded' }],
  ])('projects the runner %s outcome safely', async (outcome, expected) => {
    const { handlers, fire } = setup(outcome);
    await expect(handlers.run('daily-review', { idempotencyKey: 'mobile-abc' })).resolves.toEqual(expected);
    expect(fire).toHaveBeenCalledWith('daily-review', {
      trigger: 'manual', idempotencyKey: 'mobile-abc',
      triggerSource: { type: 'manual', id: 'mobile' },
    });
  });

  it.each([
    ['', { idempotencyKey: 'mobile-abc' }],
    ['x'.repeat(101), { idempotencyKey: 'mobile-abc' }],
    ['daily-review', { idempotencyKey: '' }],
    ['daily-review', { idempotencyKey: 'x'.repeat(501) }],
  ])('rejects malformed run-now input before firing', async (id, body) => {
    const { handlers, fire } = setup();
    await expect(handlers.run(id, body)).rejects.toMatchObject({ statusCode: 400 });
    expect(fire).not.toHaveBeenCalled();
  });

  it('subscribes at lifecycle attach, pushes each failed run once, and detaches cleanly', () => {
    const { events, handlers, sendFailedPush } = setup();
    handlers.attach();
    handlers.attach();
    const failed = { automationId: 'daily-review', runId: 'run-failed', status: 'failed' };
    events.emit('automation:run-terminal', failed);
    events.emit('automation:run-terminal', failed);
    events.emit('automation:run-terminal', { ...failed, runId: 'run-ok', status: 'succeeded' });
    expect(sendFailedPush).toHaveBeenCalledTimes(1);
    expect(sendFailedPush).toHaveBeenCalledWith({ automationId: 'daily-review', runId: 'run-failed' });
    handlers.detach();
    events.emit('automation:run-terminal', { ...failed, runId: 'later' });
    expect(sendFailedPush).toHaveBeenCalledTimes(1);
  });
});

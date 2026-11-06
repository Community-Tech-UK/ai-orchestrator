/**
 * Startup must never wait on check commands. The Automations init step runs
 * before the main window is created, and the startup catch-up sweep fires each
 * `runOnce` job inline, which runs the job's pre-check (up to 30 s per job).
 * The sweep therefore runs in the background; this spec pins that:
 *  - `initializeAutomations` resolves while a catch-up fire (a hung check) is
 *    still pending,
 *  - catch-up semantics hold: jobs fire one at a time, in store order,
 *  - the scheduler is armed only after the sweep ends (so it cannot double-fire
 *    a job the sweep is catching up), and still armed if the sweep throws.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Automation } from '../../shared/types/automation.types';
import type { InstanceManager } from '../instance/instance-manager';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/ai-orchestrator-test') },
}));

const h = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  automations: [] as unknown[],
  fire: vi.fn(),
  listError: null as Error | null,
  schedulerInitialize: vi.fn(),
  runnerInitialize: vi.fn(),
  reconcilerStarted: vi.fn(),
}));

vi.mock('../logging/logger', () => ({ getLogger: () => h.logger }));
vi.mock('../persistence/rlm-database', () => ({ getRLMDatabase: () => ({ getRawDb: () => ({}) }) }));
vi.mock('../core/system/provider-quota-service', () => ({ getProviderQuotaService: () => ({ refresh: vi.fn() }) }));
vi.mock('./automation-check-store', () => ({
  getAutomationCheckStore: () => ({}),
  _resetAutomationCheckStoreForTesting: vi.fn(),
}));
vi.mock('./provider-limit-resume-reconciler', () => ({
  startProviderLimitResumeReconciler: () => {
    h.reconcilerStarted();
    return () => undefined;
  },
}));
vi.mock('./automation-attachment-service', () => ({ AutomationAttachmentService: class {} }));
vi.mock('./automation-store', () => ({
  AutomationStore: class {
    list = async () => {
      if (h.listError) throw h.listError;
      return h.automations;
    };
    listPendingRetries = () => [];
  },
}));
vi.mock('./automation-runner', () => ({
  AutomationRunner: class {
    initialize = h.runnerInitialize;
    fire = h.fire;
    setRetryScheduler = vi.fn();
  },
}));
vi.mock('./automation-scheduler', () => ({
  AutomationScheduler: class {
    initialize = h.schedulerInitialize;
  },
}));

import { initializeAutomations, resetAutomationsForTesting } from './index';

const NOW = Date.parse('2026-10-20T12:00:00Z');

function runOnceJob(id: string): Automation {
  return {
    id,
    name: id,
    active: true,
    enabled: true,
    missedRunPolicy: 'runOnce',
    action: { prompt: 'Check', workingDirectory: '/repo' },
    // Every minute; never fired, created two hours ago: plenty of missed ticks.
    schedule: { type: 'cron', expression: '* * * * *', timezone: 'UTC' },
    lastFiredAt: null,
    createdAt: NOW - 2 * 60 * 60 * 1000,
  } as unknown as Automation;
}

/** Resolves true if `promise` settles within `ms`, false if it is still pending. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => true, () => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

describe('initializeAutomations startup catch-up (R6N3)', () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetAutomationsForTesting();
    h.automations = [runOnceJob('checked-a'), runOnceJob('checked-b')];
    h.listError = null;
    h.fire.mockReset();
    h.schedulerInitialize.mockReset();
    h.runnerInitialize.mockReset();
    h.reconcilerStarted.mockReset();
    h.logger.error.mockReset();
    h.logger.warn.mockReset();
  });

  it('resolves while a catch-up job is still waiting on its check', async () => {
    // A hung pre-check: fire() never returns.
    h.fire.mockImplementation(() => new Promise<never>(() => undefined));

    const init = initializeAutomations({} as InstanceManager);

    expect(await settlesWithin(init, 250)).toBe(true);
    expect(h.runnerInitialize).toHaveBeenCalledTimes(1);
    expect(h.reconcilerStarted).toHaveBeenCalledTimes(1);
    // The sweep did start, and is stuck on the first job.
    await vi.waitFor(() => expect(h.fire).toHaveBeenCalledTimes(1));
    expect(h.fire.mock.calls[0]?.[0]).toBe('checked-a');
    expect(h.fire.mock.calls[0]?.[1]).toMatchObject({ trigger: 'catchUp' });
  });

  it('keeps catch-up order and only arms the scheduler once the sweep has finished', async () => {
    const releases: (() => void)[] = [];
    h.fire.mockImplementation(() => new Promise<void>((resolve) => { releases.push(resolve); }));

    await initializeAutomations({} as InstanceManager);

    await vi.waitFor(() => expect(releases).toHaveLength(1));
    // One job at a time: the second is not fired while the first is pending.
    expect(h.fire).toHaveBeenCalledTimes(1);
    expect(h.schedulerInitialize).not.toHaveBeenCalled();

    releases[0]!();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(h.fire.mock.calls.map((call) => call[0])).toEqual(['checked-a', 'checked-b']);
    expect(h.schedulerInitialize).not.toHaveBeenCalled();

    releases[1]!();
    await vi.waitFor(() => expect(h.schedulerInitialize).toHaveBeenCalledTimes(1));
  });

  it('logs a failed sweep instead of failing startup, and still arms the scheduler', async () => {
    h.listError = new Error('store unavailable');

    await expect(initializeAutomations({} as InstanceManager)).resolves.toBeUndefined();

    await vi.waitFor(() => expect(h.schedulerInitialize).toHaveBeenCalledTimes(1));
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('catch-up'),
      expect.objectContaining({ message: 'store unavailable' }),
    );
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { PlanQueueFlowHost } from './plan-queue-host';
import { newPlanQueueItem } from './plan-queue-state';
import { PlanQueueWorkerReports, REPORT_REQUIRED_PROVIDERS } from './plan-queue-worker-report';

describe('REPORT_REQUIRED_PROVIDERS', () => {
  // A provider joins this list only with a passing live check recorded in
  // docs/plans/2026-11-04-pq-b3-report-ready_livetest.md. copilot has not been run and gemini fails (LT-1037).
  it('names only the providers whose live check has passed', () => {
    expect([...REPORT_REQUIRED_PROVIDERS].sort()).toEqual(['claude', 'codex', 'cursor', 'opencode']);
  });
});

describe('the reminder to a worker that ended its turn without reporting', () => {
  /** A host with one live Claude worker; returns the text of the reminder it was sent. */
  function remindedWith(sourceRef: string, sourceKind: 'markdown' | 'linear'): string {
    const sendInput = vi.fn().mockResolvedValue(undefined);
    const host = {
      instances: { getInstance: () => ({ provider: 'claude', status: 'idle' }), sendInput },
      tracker: { beginTurn: () => undefined, isShuttingDown: () => false },
      getRun: () => ({ workerProvider: 'claude' }),
    } as unknown as PlanQueueFlowHost;
    const item = newPlanQueueItem('item-1', 'run-1', sourceRef, 1, { sourceKind, workerProvider: 'claude' });
    expect(new PlanQueueWorkerReports(host, () => undefined).afterTurn(item, 'worker-1')).toBe('reminded');
    return sendInput.mock.calls[0][1] as string;
  }

  it('names the live-test file for a plan', () => {
    expect(remindedWith('/repo/docs/plans/a_plan.md', 'markdown')).toContain('_livetest.md');
  });

  it('does not name a live-test file for a ticket, which has no plan to put one beside', () => {
    const reminder = remindedWith('linear:lin-12', 'linear');
    expect(reminder).toContain('plan_queue_report_ready');
    expect(reminder).not.toContain('_livetest.md');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG, type PlanQueueRouting } from '@contracts/schemas/plan-queue';
import { changeRunRouting } from './plan-queue-run-routing-change';
import type { PlanQueueRoutingDeps } from './plan-queue-routing';
import type { PlanQueueRun } from './plan-queue.types';

function fixture(options: { scope?: string; excluded?: string[]; installed?: string[] } = {}) {
  const run: PlanQueueRun = { id: 'run', parentInstanceId: 'parent', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: '/repo',
    status: 'running', config: { ...DEFAULT_PLAN_QUEUE_CONFIG.plans, routing: { worker: { provider: 'codex' }, verifiers: [] } },
    relaxation: null, workerProvider: 'codex', workerModel: null, startedAt: 1, endedAt: null };
  const host = { getRun: () => run, hasParkedWork: () => true, parentRoute: () => ({ provider: 'claude', currentModel: 'parent-model' }), upsertRun: vi.fn(), holdRun: vi.fn().mockResolvedValue(undefined), requestPump: vi.fn(), notifyParent: vi.fn() };
  const deps: PlanQueueRoutingDeps = { readSaved: () => ({ worker: { provider: 'codex' }, verifiers: [] }), poolProfiles: () => [], copilotProfiles: () => [],
    isProviderExcluded: (p) => options.excluded?.includes(p) ?? false, defaultProvider: () => null,
    checkerScopeKind: () => options.scope ?? 'none', listInstalledProviders: async () => options.installed ?? ['codex', 'claude', 'copilot'] };
  return { host, run, deps };
}
const choice: PlanQueueRouting = { worker: { provider: 'claude' }, verifiers: [{ provider: 'codex' }] };

describe('changing a run route', () => {
  it('persists provider, model and routing in one save and notifies the parent', async () => {
    const { host, run, deps } = fixture();
    await changeRunRouting(host, run, { ...choice, worker: { provider: 'claude', model: 'new-model' } }, 'panel', false, deps);
    expect(host.upsertRun).toHaveBeenCalledTimes(1);
    expect(host.upsertRun).toHaveBeenCalledWith(expect.objectContaining({ workerProvider: 'claude', workerModel: 'new-model', config: expect.objectContaining({ routing: { ...choice, worker: { provider: 'claude', model: 'new-model' }, checkersChosenBy: 'saved' } }) }));
    expect(host.notifyParent).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('James changed this run'));
    expect(host.holdRun).not.toHaveBeenCalled();
  });
  it('inherits the starting session instead of the current saved worker when worker is null', async () => {
    const { host, run, deps } = fixture();
    await changeRunRouting(host, run, { worker: null, verifiers: [] }, 'panel', false, deps);
    expect(host.upsertRun).toHaveBeenCalledWith(expect.objectContaining({ workerProvider: 'claude', workerModel: 'parent-model' }));
  });
  it('moves in-progress documents only when asked on a running run', async () => {
    const { host, run, deps } = fixture();
    await changeRunRouting(host, run, choice, 'panel', true, deps);
    expect(host.holdRun).toHaveBeenCalledWith(expect.objectContaining({ id: run.id }));
    expect(host.requestPump).toHaveBeenCalledTimes(1);
    run.status = 'paused';
    await changeRunRouting(host, run, choice, 'panel', true, deps);
    expect(host.holdRun).toHaveBeenCalledTimes(1);
  });
  it('refuses parent checker overrides in protected scopes while allowing the page', async () => {
    const { host, run, deps } = fixture({ scope: 'protected' });
    await expect(changeRunRouting(host, run, choice, 'parent', false, deps)).rejects.toThrow('protected work Copilot rule');
    expect(host.upsertRun).not.toHaveBeenCalled();
    await changeRunRouting(host, run, choice, 'panel', false, deps);
    expect(host.upsertRun).toHaveBeenCalledTimes(1);
  });
  it.each([
    [{ excluded: ['claude'] }, choice, 'never auto-pick'],
    [{ installed: ['codex'] }, choice, 'claude is not installed'],
    [{}, { worker: { provider: 'claude' }, verifiers: [{ provider: 'claude' }] }, 'None of the chosen checkers'],
    [{}, { worker: { provider: 'codex', accountProfileIds: ['missing'] }, verifiers: [] }, 'there is no codex account'],
  ])('refuses invalid routing without saving or stopping sessions %#', async (options, routing, reason) => {
    const { host, run, deps } = fixture(options);
    await expect(changeRunRouting(host, run, routing, 'panel', true, deps)).rejects.toThrow(reason);
    expect(host.upsertRun).not.toHaveBeenCalled();
    expect(host.holdRun).not.toHaveBeenCalled();
  });
  it('honours relaxed exclusions and permits a completed run with parked work', async () => {
    const { host, run, deps } = fixture({ excluded: ['claude'] });
    run.status = 'completed'; run.config = { ...run.config, relaxSettings: true };
    await changeRunRouting(host, run, choice, 'parent', false, deps);
    expect(host.upsertRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
  });
});


it('does not resurrect a run completed while CLI detection was pending', async () => {
  const { host, run, deps } = fixture();
  deps.listInstalledProviders = async () => { run.status = 'completed'; run.endedAt = 42; return ['codex', 'claude']; };
  await changeRunRouting(host, { ...run }, choice, 'panel', true, deps);
  expect(host.upsertRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed', endedAt: 42 }));
  expect(host.holdRun).not.toHaveBeenCalled();
});


it.each(['completed', 'cancelled'] as const)('refuses a %s run without parked documents', async (status) => {
  const { host, run, deps } = fixture();
  run.status = status; host.hasParkedWork = () => false;
  await expect(changeRunRouting(host, run, choice, 'panel', false, deps)).rejects.toThrow('no parked documents');
  expect(host.upsertRun).not.toHaveBeenCalled();
});

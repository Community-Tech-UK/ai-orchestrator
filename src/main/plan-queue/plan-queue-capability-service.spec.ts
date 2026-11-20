import { describe, expect, it, vi } from 'vitest';
import { readFileSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DEFAULT_PLAN_QUEUE_CONFIG, type PlanQueueCapabilityGap } from '@contracts/schemas/plan-queue';
import { coordinator, fake, git, itemIdOf, repo, store, waitForRun, writeDoc } from './plan-queue-coordinator.test-helpers';
import { PlanQueueItemFlow } from './plan-queue-item-flow';
import { newPlanQueueItem } from './plan-queue-state';
import { PlanQueueCapabilityService, type CapabilityHooks } from './plan-queue-capability-service';
import type { PlanQueueRun } from './plan-queue.types';
import type { CapabilityRepair } from './plan-queue-capability-store';
import { enableCapabilityRepairs, releaseHeldCapabilityRepairs, retryCapabilityOrigin } from './plan-queue-capability-control';

function fixture(role: 'worker' | 'triage' | 'verifier' = 'worker') {
  const parent = fake.addParent();
  vi.spyOn(coordinator, 'requestPump').mockImplementation(() => undefined);
  store.upsertRun({ id: 'source', parentInstanceId: parent.id, parentHistoryThreadId: null, kind: 'livetests', workspaceCwd: repo,
    status: 'running', config: { ...DEFAULT_PLAN_QUEUE_CONFIG.livetests, capabilityRepairRepository: repo }, relaxation: null,
    workerProvider: 'claude', workerModel: null, startedAt: Date.now() - 1000, endedAt: null });
  const document = writeDoc('docs/plans/origin_livetest.md', '# Runtime checks\n- [ ] Disposable session\n- [ ] Real account signout\n');
  store.upsertItem(newPlanQueueItem('origin', 'source', document, Date.now() - 1000, {
    state: role === 'triage' ? 'discovered' : role === 'verifier' ? 'verifying' : 'working',
    workerInstanceId: role === 'worker' ? 'caller' : null, verifierInstanceId: role === 'verifier' ? 'caller' : null,
  }));
  coordinator.registerRole('caller', role === 'triage' ? { role, runId: 'source' } : { role, runId: 'source', itemId: 'origin' });
  const hooks: CapabilityHooks = { currentTriage: () => true, forgetTriage: vi.fn(), accountRules: () => ({ never: [], last: [] }),
    sourceSettled: () => true,
    excludedProviders: () => [],
    controlRun: vi.fn(async () => undefined), retryOrigin: vi.fn(async () => true) };
  const launch = vi.fn(async () => undefined);
  const service = new PlanQueueCapabilityService(coordinator, hooks, Date.now, launch);
  const gap: PlanQueueCapabilityGap = { capabilityKey: 'owned-session', check: 'Disposable session', requiredAction: 'Create a disposable restricted session',
    platform: 'macos', provider: 'codex', classification: 'capability', attempts: [{ operation: 'Discover owned session tools', observedAt: Date.now(), result: 'No owned-session creation operation.' }],
    alternative: 'The production app is outside the test boundary.', expectedResult: 'The owned session answers and is removed.', implementation: 'Extend the existing owned test session controls and enforce scope with tests.' };
  return { service, hooks, launch, gap, parent };
}

describe('capability reporting and authority', () => {
  it('runs the real coordinator turn-boundary path: authenticated report, saved original branch, durable waiting plan', async () => {
    const parent = fake.addParent();
    const document = writeDoc('docs/plans/runtime_livetest.md', '# Runtime\n- [ ] Owned fixture\n');
    fake.scripts.worker = async instance => {
      await coordinator.capabilities.reportGap(instance.id, { item_id: itemIdOf(instance), gap: {
        capabilityKey: 'test-fixture', check: 'Owned fixture', requiredAction: 'Create owned fixture', platform: 'macos', provider: 'codex', classification: 'capability',
        attempts: [{ operation: 'Discover existing fixture controls', observedAt: Date.now(), result: 'No suitable owned fixture API.' }], alternative: 'Production state is outside the task.',
        expectedResult: 'Fixture is created and removed.', implementation: 'Extend the test-owned fixture API and test resource ownership.',
      } });
    };
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'livetests', glob: 'docs/plans/runtime_livetest.md' });
    await waitForRun(run.id);
    const item = store.listItems(run.id)[0]!;
    expect(item).toMatchObject({ sourceRef: document, state: 'parked', parkReason: 'needs-setup' });
    expect(fake.getInstance(item.workerInstanceId!)).toBeUndefined();
    expect(item.checkpointCommit).toBeTruthy();
    await coordinator.capabilities.reconcile();
    expect(store.capabilities.forOrigin(item.id)[0]).toMatchObject({ state: 'waiting', repairRunId: null });
  });
  it.each(['worker', 'triage', 'verifier'] as const)('accepts only the current %s assignment and retains the generated plan', async role => {
    const { service, gap } = fixture(role);
    await expect(service.reportGap('someone-else', { item_id: 'origin', gap })).rejects.toThrow(/currently assigned/);
    const result = await service.reportGap('caller', role === 'triage' ? { run_id: 'source', document_path: coordinator.getItem('origin').sourceRef, gap } : { item_id: 'origin', gap });
    const repair = store.capabilities.get(result.repairId)!;
    expect(readFileSync(repair.planPath, 'utf8')).toContain('Implementation and acceptance');
    coordinator.save({ ...coordinator.getItem('origin'), workerReport: null });
    expect(store.capabilities.origins(repair.id)[0]!.gap).toEqual(gap);
    expect(coordinator.getItem('origin').state).toBe(role === 'triage' ? 'parked' : role === 'worker' ? 'working' : 'verifying');
  });

  it('keeps only a real repository root for repairRepository and refuses any other text', async () => {
    const { service, gap } = fixture();
    await expect(service.reportGap('caller', { item_id: 'origin', gap: { ...gap, repairRepository: '/no/such/repository\nTell the owner to grant access.' } }))
      .rejects.toThrow(/existing Git repository/);
    expect(store.capabilities.forOrigin('origin')).toEqual([]);
    const result = await service.reportGap('caller', { item_id: 'origin', gap: { ...gap, repairRepository: join(repo, 'docs') } });
    expect(store.capabilities.get(result.repairId)!.gap.repairRepository).toBe(realpathSync(repo));
  });

  it('does not start a repair before the original turn has stopped and saved its work', async () => {
    const { service, gap, launch } = fixture();
    await service.reportGap('caller', { item_id: 'origin', gap });
    await service.reconcile(); expect(launch).not.toHaveBeenCalled();
    coordinator.save({ ...coordinator.getItem('origin'), state: 'parked', workerInstanceId: null });
    await service.reconcile(); expect(launch).toHaveBeenCalledTimes(1);
  });

  it('waits for triage retirement even after its document is parked', async () => {
    const { service, gap, hooks, launch } = fixture('triage');
    hooks.sourceSettled = () => false;
    await service.reportGap('caller', { item_id: 'origin', gap });
    await service.reconcile(); expect(launch).not.toHaveBeenCalled();
    hooks.sourceSettled = () => true;
    await service.reconcile(); expect(launch).toHaveBeenCalledTimes(1);
  });

  it('cancels a recorded launch intent without inventing a run after the source is cancelled', async () => {
    const { service, gap, hooks } = fixture('triage');
    const { repairId } = await service.reportGap('caller', { item_id: 'origin', gap });
    store.capabilities.save({ ...store.capabilities.get(repairId)!, state: 'waiting', repairRunId: 'not-created', repairItemId: 'not-created-item' });
    store.upsertRun({ ...coordinator.getRun('source'), status: 'cancelled' });
    await service.reconcile();
    expect(store.capabilities.get(repairId)?.state).toBe('cancelled');
    expect(hooks.controlRun).not.toHaveBeenCalled();
  });

  it('captures and plans without implementation authority, then the owner can enable the existing plan', async () => {
    const { service, gap, launch } = fixture('triage');
    store.upsertRun({ ...coordinator.getRun('source'), config: DEFAULT_PLAN_QUEUE_CONFIG.livetests });
    const { repairId } = await service.reportGap('caller', { item_id: 'origin', gap });
    await service.reconcile(); expect(launch).not.toHaveBeenCalled();
    expect(store.capabilities.get(repairId)?.state).toBe('waiting');
    const authorize = vi.fn();
    await enableCapabilityRepairs(coordinator, 'source', repo, authorize);
    await service.reconcile(); expect(launch).toHaveBeenCalledTimes(1); expect(authorize).toHaveBeenCalledTimes(1);
  });

  it('refuses stale assignment after plan generation and does not overwrite cancellation', async () => {
    const { service, gap } = fixture('triage');
    const report = service.reportGap('caller', { item_id: 'origin', gap });
    store.upsertRun({ ...coordinator.getRun('source'), status: 'cancelled' });
    await expect(report).rejects.toThrow(/paused or cancelled|stopped|currently assigned/);
    expect(coordinator.getItem('origin').state).toBe('discovered');
  });

  it('does not derive a repair from a repair', async () => {
    const { service, gap, launch } = fixture();
    const { repairId } = await service.reportGap('caller', { item_id: 'origin', gap });
    store.upsertRun({ ...coordinator.getRun('source'), config: { ...coordinator.getRun('source').config, capabilityRepairId: repairId } });
    store.capabilities.save({ ...store.capabilities.get(repairId)!, repairItemId: 'origin', state: 'running' });
    await service.reportGap('caller', { item_id: 'origin', gap: { ...gap, capabilityKey: 'another-control' } });
    expect(store.capabilities.list()).toHaveLength(1);
    expect(service.waitingForRepair('origin')).toBe(true);
    expect(launch).not.toHaveBeenCalled();
  });

  it('keeps genuine human authority separate from technical implementation', async () => {
    const { service, gap, launch } = fixture('triage');
    await service.reportGap('caller', { item_id: 'origin', gap: { ...gap, classification: 'human-authority' } });
    await service.reconcile(); expect(launch).not.toHaveBeenCalled(); expect(coordinator.getItem('origin').state).toBe('discovered');
    expect(service.waitingForRepair('origin')).toBe(false);
  });
});

describe('waiting status on the original job', () => {
  it('writes one status for a job waiting on two repairs, and leaves it alone on the next pass', async () => {
    const { service, gap } = fixture();
    const technical = await service.reportGap('caller', { item_id: 'origin', gap });
    const human = await service.reportGap('caller', { item_id: 'origin', gap: { ...gap, capabilityKey: 'signed-in-account',
      check: 'Real account signout', requiredAction: 'Sign a test account in', classification: 'human-authority' } });
    coordinator.save({ ...coordinator.getItem('origin'), state: 'parked', parkReason: 'needs-setup', workerInstanceId: null });
    await service.reconcile();
    const [first, second] = [technical, human].map(({ repairId }) => store.capabilities.get(repairId)!)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    expect(coordinator.getItem('origin').detail).toBe(['Original check still open.',
      `${first!.detail} Repair plan: ${first!.planPath}`, `${second!.detail} Repair plan: ${second!.planPath}`].join('\n'));
    const save = vi.spyOn(coordinator, 'save');
    await service.reconcile(); await service.reconcile();
    expect(save.mock.calls.filter(([item]) => item.id === 'origin')).toEqual([]);
  });

  it('keeps today\'s wording for a job waiting on one repair', async () => {
    const { service, gap } = fixture();
    const { repairId } = await service.reportGap('caller', { item_id: 'origin', gap: { ...gap, classification: 'human-authority' } });
    coordinator.save({ ...coordinator.getItem('origin'), state: 'parked', parkReason: 'needs-setup', workerInstanceId: null });
    await service.reconcile();
    const repair = store.capabilities.get(repairId)!;
    expect(coordinator.getItem('origin').detail).toBe(`${repair.detail} Original check still open. Repair plan: ${repair.planPath}`);
  });
});

function landedRepair(repair: CapabilityRepair, suffix = '') {
  const run = coordinator.getRun('source'), checkpoint = git(['rev-parse', 'HEAD']);
  store.upsertRun({ ...run, id: `repair-run${suffix}`, kind: 'plans', config: { ...run.config, capabilityRepairId: repair.id } });
  store.upsertItem(newPlanQueueItem(`repair-item${suffix}`, `repair-run${suffix}`, repair.planPath, Date.now() - 1000, {
    state: 'landed', checkpointCommit: checkpoint, landedCommit: checkpoint,
    verdict: { verdict: 'PASS', findings: [], gatesRun: [], documentComplete: true, needJames: [] },
  }));
  store.capabilities.save({ ...repair, repairRunId: `repair-run${suffix}`, repairItemId: `repair-item${suffix}`, state: 'running',
    probeReceipt: '{}', probe: { computer: 'ct-test-mac', runtimeBuild: git(['rev-parse', 'HEAD^{tree}']), testedTree: git(['rev-parse', 'HEAD^{tree}']),
      observedAt: Date.now(), operation: 'Create owned session', result: 'Responded and removed', receiptPath: '_scratch/probe.json', receiptSha256: 'a'.repeat(64) } });
}

describe('repair completion and original check revalidation', () => {
  it.each([false, true].flatMap(retained => ['before-item-save', 'after-item-save', 'after-reopen'].map(boundary => ({ retained, boundary }))))('recovers a durable retry after restart $boundary (retained work: $retained)', async ({ boundary, retained }) => {
    const { service, gap, hooks, launch } = fixture('triage');
    const { repairId } = await service.reportGap('caller', { item_id: 'origin', gap });
    landedRepair(store.capabilities.get(repairId)!);
    store.upsertRun({ ...coordinator.getRun('source'), status: 'completed' });
    if (retained) coordinator.save({ ...coordinator.getItem('origin'), branchName: 'main' });
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    hooks.retryOrigin = async () => {
      if (boundary !== 'before-item-save') coordinator.transition(coordinator.getItem('origin'), retained ? 'queued' : 'discovered', { parkReason: null });
      if (boundary === 'after-reopen') store.upsertRun({ ...coordinator.getRun('source'), status: 'running' });
      enter();
      return new Promise<boolean>(() => undefined); // The old process ends here, before origin finalisation.
    };
    void service.reconcile();
    await entered;
    const flow = new PlanQueueItemFlow(coordinator);
    const resume = vi.fn((id: string, admitted: () => boolean) => flow.resume(id, admitted));
    const reopen = vi.fn((run: PlanQueueRun) => store.upsertRun({ ...run, status: 'running' }));
    const restarted = new PlanQueueCapabilityService(coordinator, { ...hooks,
      retryOrigin: id => retryCapabilityOrigin(coordinator, id, resume, reopen),
    }, Date.now, launch);
    await restarted.reconcile();
    expect(store.capabilities.get(repairId)?.state).toBe('verifying-origin');
    expect(store.capabilities.origins(repairId)[0]?.state).toBe('retrying');
    expect(coordinator.getItem('origin').state).toBe(retained ? 'queued' : 'discovered');
    expect(restarted.waitingForRepair('origin')).toBe(false);
    expect(resume).toHaveBeenCalledTimes(retained && boundary === 'before-item-save' ? 1 : 0);
    expect(reopen).toHaveBeenCalledTimes(1);
    expect(coordinator.getRun('source').status).toBe('running');
    await restarted.reconcile();
    expect(reopen).toHaveBeenCalledTimes(1);
  });
  it.each(['source-paused', 'source-cancelled', 'repair-paused', 'repair-cancelled'] as const)('retains operator control during asynchronous original resume: %s', async stop => {
    const { service, gap, hooks } = fixture('triage');
    const { repairId } = await service.reportGap('caller', { item_id: 'origin', gap });
    landedRepair(store.capabilities.get(repairId)!);
    coordinator.save({ ...coordinator.getItem('origin'), branchName: 'main' });
    const flow = new PlanQueueItemFlow(coordinator);
    const reopen = vi.fn();
    vi.spyOn(coordinator.history, 'recordDocumentTransformation').mockImplementation(() => {
      const runId = stop.startsWith('source') ? 'source' : 'repair-run';
      store.upsertRun({ ...coordinator.getRun(runId), status: stop.endsWith('paused') ? 'paused' : 'cancelled' });
    });
    hooks.retryOrigin = id => retryCapabilityOrigin(coordinator, id, (itemId, admitted) => flow.resume(itemId, admitted), reopen);
    await service.reconcile();
    expect(coordinator.getItem('origin')).toMatchObject({ state: 'parked', parkReason: 'needs-setup' });
    expect(store.capabilities.origins(repairId)[0]?.state).toBe('waiting');
    expect(reopen).not.toHaveBeenCalled();
  });

  it('does not finalize a retry when cancellation arrives after the item and run saves', async () => {
    const { service, gap, hooks } = fixture('triage');
    const { repairId } = await service.reportGap('caller', { item_id: 'origin', gap });
    landedRepair(store.capabilities.get(repairId)!);
    hooks.retryOrigin = async id => {
      const result = await retryCapabilityOrigin(coordinator, id, async () => undefined, () => undefined);
      store.upsertRun({ ...coordinator.getRun('source'), status: 'cancelled' });
      return result;
    };
    await service.reconcile();
    expect(store.capabilities.origins(repairId)[0]?.state).toBe('waiting');
    await service.reconcile();
    expect(store.capabilities.origins(repairId)[0]?.state).toBe('withdrawn');
  });

  it('refuses original PASS until every retried check has independent evidence for the current checkpoint', async () => {
    const { service, gap } = fixture('verifier');
    const { repairId } = await service.reportGap('caller', { item_id: 'origin', gap });
    await service.reportGap('caller', { item_id: 'origin', gap: { ...gap, check: 'Remove owned session' } });
    for (const origin of store.capabilities.origins(repairId)) store.capabilities.setOriginState(origin, 'retrying');
    const checkpoint = git(['rev-parse', 'HEAD']);
    coordinator.save({ ...coordinator.getItem('origin'), checkpointCommit: checkpoint });
    const pass = () => coordinator.reportVerdict('caller', { item_id: 'origin', verdict: 'PASS', findings: [],
      gates_run: [], document_complete: true, need_james: [], not_checked: [] });
    expect(pass).toThrow(/original check/);
    expect(coordinator.getItem('origin').verdict).toBeNull();
    service.reportCheck('caller', { item_id: 'origin', repair_id: repairId, check: gap.check, evidence: 'Owned session responded on the test Mac.' });
    expect(pass).toThrow(/original check/);
    service.reportCheck('caller', { item_id: 'origin', repair_id: repairId, check: 'Remove owned session', evidence: 'Owned session was removed on the test Mac.' });
    coordinator.save({ ...coordinator.getItem('origin'), checkpointCommit: 'later-checkpoint' });
    expect(pass).toThrow(/original check/);
    coordinator.save({ ...coordinator.getItem('origin'), checkpointCommit: checkpoint });
    expect(pass()).toMatchObject({ accepted: true });
    // Accepted verdicts remain pending until the checker ends its turn.
    expect(coordinator.getItem('origin').state).toBe('verifying');
  });
  it('parks a failed original retry without repeatedly recycling a landed repair', async () => {
    const { service, gap, hooks } = fixture();
    const { repairId } = await service.reportGap('caller', { item_id: 'origin', gap });
    landedRepair(store.capabilities.get(repairId)!);
    store.capabilities.setOriginState(store.capabilities.origins(repairId)[0]!, 'retrying');
    await service.reportGap('caller', { item_id: 'origin', gap });
    expect(service.waitingForRepair('origin')).toBe(true);
    coordinator.save({ ...coordinator.getItem('origin'), state: 'parked' });
    await service.reconcile();
    expect(store.capabilities.get(repairId)?.state).toBe('waiting');
    expect(hooks.retryOrigin).not.toHaveBeenCalled();
  });
  it('holds a landed repair whose original rerun failed under different wording until its owner resumes the original job', async () => {
    const { service, gap, hooks } = fixture();
    const { repairId } = await service.reportGap('caller', { item_id: 'origin', gap });
    landedRepair(store.capabilities.get(repairId)!);
    store.capabilities.setOriginState(store.capabilities.origins(repairId)[0]!, 'retrying');
    await service.reportGap('caller', { item_id: 'origin', gap: { ...gap, check: 'Disposable session, reworded' } });
    expect(store.capabilities.get(repairId)).toMatchObject({ state: 'waiting', heldForOwner: true });
    expect(store.capabilities.get(repairId)?.detail).toContain('Resume the original job');
    coordinator.save({ ...coordinator.getItem('origin'), state: 'parked', workerInstanceId: null });
    await service.reconcile(); await service.reconcile();
    expect(hooks.retryOrigin).not.toHaveBeenCalled();
    releaseHeldCapabilityRepairs(coordinator, 'origin');
    expect(store.capabilities.get(repairId)).toMatchObject({ state: 'verifying-origin', heldForOwner: false });
    await service.reconcile();
    expect(hooks.retryOrigin).toHaveBeenCalledTimes(1);
  });
  it.each(['retry-landing', 'land-anyway'] as const)('a set-aside repair sent to merge (%s) is active again, so a clash fixed by its worker is not re-parked', async action => {
    const { service, gap } = fixture('triage');
    const { repairId } = await service.reportGap('caller', { item_id: 'origin', gap });
    landedRepair(store.capabilities.get(repairId)!);
    coordinator.save({ ...coordinator.getItem('repair-item'), state: 'parked', parkReason: 'land-blocked' });
    await service.reconcile();
    expect(store.capabilities.get(repairId)?.state).toBe('waiting');
    expect(service.waitingForRepair('repair-item')).toBe(true);
    // The flow's own awaits leave the item parked while a queue pass runs, then the landing starts.
    const merge = vi.spyOn(PlanQueueItemFlow.prototype, action === 'retry-landing' ? 'retryLanding' : 'landAnyway').mockImplementation(async () => {
      await service.reconcile();
      coordinator.save({ ...coordinator.getItem('repair-item'), state: 'landing', parkReason: null });
    });
    try {
      await coordinator.control({ action, itemId: 'repair-item' });
      expect(store.capabilities.get(repairId)?.state).toBe('running');
      expect(service.waitingForRepair('repair-item')).toBe(false);
    } finally { merge.mockRestore(); }
  });
  it('leaves a cancelled repair cancelled when its job is sent to merge', async () => {
    const { service, gap } = fixture('triage');
    const { repairId } = await service.reportGap('caller', { item_id: 'origin', gap });
    landedRepair(store.capabilities.get(repairId)!);
    coordinator.save({ ...coordinator.getItem('repair-item'), state: 'parked', parkReason: 'land-blocked' });
    store.capabilities.save({ ...store.capabilities.get(repairId)!, state: 'cancelled' });
    const merge = vi.spyOn(PlanQueueItemFlow.prototype, 'retryLanding').mockResolvedValue(undefined);
    try {
      await coordinator.control({ action: 'retry-landing', itemId: 'repair-item' });
      expect(store.capabilities.get(repairId)?.state).toBe('cancelled');
    } finally { merge.mockRestore(); }
  });
  it('releases a held landed repair when its owner resumes the original job, and retries it without a second resume', async () => {
    const { service, gap, hooks } = fixture();
    const { repairId } = await service.reportGap('caller', { item_id: 'origin', gap });
    landedRepair(store.capabilities.get(repairId)!);
    store.capabilities.setOriginState(store.capabilities.origins(repairId)[0]!, 'retrying');
    await service.reportGap('caller', { item_id: 'origin', gap });
    coordinator.save({ ...coordinator.getItem('origin'), state: 'parked', parkReason: 'needs-setup', workerInstanceId: null });
    const resume = vi.spyOn(PlanQueueItemFlow.prototype, 'resume').mockImplementation(async itemId => {
      coordinator.transition(coordinator.getItem(itemId), 'queued', { parkReason: null });
    });
    hooks.retryOrigin = id => retryCapabilityOrigin(coordinator, id, (itemId, admitted) => new PlanQueueItemFlow(coordinator).resume(itemId, admitted), () => undefined);
    try {
      await coordinator.control({ action: 'resume-item', itemId: 'origin' });
      expect(resume).toHaveBeenCalledTimes(1);
      expect(store.capabilities.get(repairId)).toMatchObject({ state: 'verifying-origin', heldForOwner: false });
      await service.reconcile();
      expect(store.capabilities.origins(repairId)[0]?.state).toBe('retrying');
      expect(resume).toHaveBeenCalledTimes(1);
    } finally { resume.mockRestore(); }
  });
  it('holds a landed repair saved before heldForOwner existed after its original rerun failed', async () => {
    const { service, gap, hooks } = fixture();
    const { repairId } = await service.reportGap('caller', { item_id: 'origin', gap });
    coordinator.save({ ...coordinator.getItem('origin'), state: 'parked', workerInstanceId: null });
    landedRepair(store.capabilities.get(repairId)!);
    store.capabilities.save({ ...store.capabilities.get(repairId)!, state: 'waiting',
      detail: 'The repaired control did not satisfy the original check. Its owner must investigate the new evidence and arrange a corrective plan; the landed repair is not retried blindly.' });
    await service.reconcile();
    expect(hooks.retryOrigin).not.toHaveBeenCalled();
    expect(store.capabilities.get(repairId)?.state).toBe('waiting');
  });
  it('does not retry a landed repair on every pass when rechecking its original keeps failing, and tells the owner once', async () => {
    const { service, gap, hooks } = fixture();
    const { repairId } = await service.reportGap('caller', { item_id: 'origin', gap });
    coordinator.save({ ...coordinator.getItem('origin'), state: 'parked', workerInstanceId: null });
    landedRepair(store.capabilities.get(repairId)!);
    const notify = vi.spyOn(coordinator, 'notifyParent');
    try {
      hooks.retryOrigin = vi.fn(async () => { throw new Error('git could not restore the retained work'); });
      await service.reconcile();
      expect(store.capabilities.get(repairId)).toMatchObject({ state: 'waiting', heldForOwner: true,
        detail: 'git could not restore the retained work Resume the original job to recheck it.' });
      await service.reconcile();
      expect(hooks.retryOrigin).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0]![1]).toContain('Resume the original job');
    } finally { notify.mockRestore(); }
  });
  it('does not revive a repair cancelled while an earlier repair was being reconciled', async () => {
    const { service, gap, hooks } = fixture();
    const { repairId } = await service.reportGap('caller', { item_id: 'origin', gap });
    coordinator.save({ ...coordinator.getItem('origin'), state: 'parked', workerInstanceId: null });
    landedRepair(store.capabilities.get(repairId)!);
    const snapshot = store.capabilities.list();
    store.capabilities.save({ ...store.capabilities.get(repairId)!, state: 'cancelled' });
    const list = vi.spyOn(store.capabilities, 'list').mockReturnValueOnce(snapshot);
    await service.reconcile();
    list.mockRestore();
    expect(store.capabilities.get(repairId)?.state).toBe('cancelled');
    expect(hooks.retryOrigin).not.toHaveBeenCalled();
  });
  it('retries once only after both capabilities for the same original item are verified', async () => {
    const { service, gap, hooks } = fixture();
    const first = await service.reportGap('caller', { item_id: 'origin', gap });
    const second = await service.reportGap('caller', { item_id: 'origin', gap: { ...gap, capabilityKey: 'owned-restart', check: 'Restart owned session' } });
    coordinator.save({ ...coordinator.getItem('origin'), state: 'parked', workerInstanceId: null });
    landedRepair(store.capabilities.get(first.repairId)!);
    landedRepair(store.capabilities.get(second.repairId)!, '-second');
    await service.reconcile(); await service.reconcile();
    expect(hooks.retryOrigin).toHaveBeenCalledTimes(1);
    expect(store.capabilities.origins(first.repairId)[0]!.state).toBe('retrying');
    expect(store.capabilities.origins(second.repairId)[0]!.state).toBe('retrying');
  });
  it('retries an item once for two attached checks, never marks either check passed', async () => {
    const { service, gap, hooks } = fixture();
    const { repairId } = await service.reportGap('caller', { item_id: 'origin', gap });
    await service.reportGap('caller', { item_id: 'origin', gap: { ...gap, check: 'Remove owned session' } });
    coordinator.save({ ...coordinator.getItem('origin'), state: 'parked', workerInstanceId: null });
    landedRepair(store.capabilities.get(repairId)!);
    await service.reconcile();
    expect(hooks.retryOrigin).toHaveBeenCalledTimes(1);
    expect(store.capabilities.origins(repairId).map(origin => origin.state)).toEqual(['retrying', 'retrying']);
    expect(store.capabilities.get(repairId)?.state).toBe('verifying-origin');
  });

  it('resolves one independently passed check while the document still has a human check open', async () => {
    const { service, gap } = fixture();
    const { repairId } = await service.reportGap('caller', { item_id: 'origin', gap });
    const origin = store.capabilities.origins(repairId)[0]!;
    store.capabilities.setOriginState(origin, 'retrying');
    const checkpoint = git(['rev-parse', 'HEAD']);
    coordinator.save({ ...coordinator.getItem('origin'), state: 'verifying', verifierInstanceId: 'checker', checkpointCommit: checkpoint });
    coordinator.registerRole('checker', { role: 'verifier', runId: 'source', itemId: 'origin' });
    service.reportCheck('checker', { item_id: 'origin', repair_id: repairId, check: gap.check, evidence: 'Owned session responded and was removed on the test Mac.' });
    coordinator.save({ ...coordinator.getItem('origin'), state: 'landed', verdict: { verdict: 'PASS', findings: [], gatesRun: [], documentComplete: false, needJames: [{ check: 'Real account signout', classification: 'real', reason: 'Owner authority remains absent.' }] } });
    await service.reconcile();
    expect(store.capabilities.get(repairId)?.state).toBe('resolved');
    expect(coordinator.getItem('origin').verdict?.documentComplete).toBe(false);
  });

  it('does not resume a paused source, and retries the original once other work landed alongside the repair', async () => {
    const { service, gap, hooks } = fixture();
    const { repairId } = await service.reportGap('caller', { item_id: 'origin', gap });
    coordinator.save({ ...coordinator.getItem('origin'), state: 'parked', workerInstanceId: null });
    landedRepair(store.capabilities.get(repairId)!);
    store.upsertRun({ ...coordinator.getRun('source'), status: 'paused' });
    await service.reconcile(); expect(hooks.retryOrigin).not.toHaveBeenCalled();
    store.upsertRun({ ...coordinator.getRun('source'), status: 'running' });
    writeFileSync(join(repo, 'changed.ts'), 'export const changed = true;'); git(['add', 'changed.ts']); git(['commit', '-qm', 'changed during landing']);
    coordinator.save({ ...coordinator.getItem('repair-item'), landedCommit: git(['rev-parse', 'HEAD']) });
    await service.reconcile();
    expect(hooks.retryOrigin).toHaveBeenCalledTimes(1);
    expect(store.capabilities.get(repairId)?.state).toBe('verifying-origin');
    expect(store.capabilities.origins(repairId)[0]?.state).toBe('retrying');
  });

  it('retries the original after a repair that was set aside is merged without a checker pass', async () => {
    const { service, gap, hooks } = fixture();
    const { repairId } = await service.reportGap('caller', { item_id: 'origin', gap });
    coordinator.save({ ...coordinator.getItem('origin'), state: 'parked', workerInstanceId: null });
    landedRepair(store.capabilities.get(repairId)!);
    coordinator.save({ ...coordinator.getItem('repair-item'), state: 'parked' });
    await service.reconcile();
    expect(store.capabilities.get(repairId)?.state).toBe('waiting');
    expect(hooks.retryOrigin).not.toHaveBeenCalled();
    coordinator.save({ ...coordinator.getItem('repair-item'), state: 'landed',
      verdict: { verdict: 'FAIL', findings: [], gatesRun: [], documentComplete: false, needJames: [] } });
    await service.reconcile();
    expect(hooks.retryOrigin).toHaveBeenCalledTimes(1);
    expect(store.capabilities.get(repairId)?.state).toBe('verifying-origin');
  });

  it('validates and retains checker receipt bytes before cleanup; rejects a worker probe', async () => {
    const { service, gap } = fixture();
    const { repairId } = await service.reportGap('caller', { item_id: 'origin', gap });
    const item = coordinator.getItem('origin'), tree = git(['rev-parse', 'HEAD^{tree}']);
    store.capabilities.save({ ...store.capabilities.get(repairId)!, repairItemId: item.id });
    coordinator.save({ ...item, state: 'verifying', verifierInstanceId: 'checker', worktreePath: repo, checkpointCommit: git(['rev-parse', 'HEAD']) });
    coordinator.registerRole('checker', { role: 'verifier', runId: 'source', itemId: 'origin' });
    const now = Date.now(), operation = 'Create owned session', result = 'Responded and removed';
    const receipt = JSON.stringify({ launch: { tree, root: repo, startedAt: new Date(now).toISOString(), computer: 'ct-test-mac', mode: 'dev' },
      runtime: { application: 'Harness', version: 'test-build', isPackaged: false }, operation, result, observedAt: now });
    mkdirSync(join(repo, '_scratch'), { recursive: true }); writeFileSync(join(repo, '_scratch/probe.json'), receipt);
    const probe = { computer: 'ct-test-mac' as const, runtimeBuild: tree, testedTree: tree, observedAt: now, operation, result,
      receiptPath: '_scratch/probe.json', receiptSha256: createHash('sha256').update(receipt).digest('hex') };
    await expect(service.reportProbe('caller', { item_id: item.id, probe })).rejects.toThrow(/currently assigned/);
    await service.reportProbe('checker', { item_id: item.id, probe });
    expect(store.capabilities.get(repairId)?.probeReceipt).toBe(receipt);
    await expect(service.reportProbe('checker', { item_id: item.id, probe: { ...probe, runtimeBuild: '0'.repeat(40) } })).rejects.toThrow(/does not match/);
    await expect(service.reportProbe('checker', { item_id: item.id, probe: { ...probe, receiptSha256: '0'.repeat(64) } })).rejects.toThrow(/digest/);
    await expect(service.reportProbe('checker', { item_id: item.id, probe: { ...probe, receiptPath: '../probe.json' } })).rejects.toThrow(/relative path/);
  });

  it('accepts the receipt a native Windows launch writes (mode "windows", not packaged)', async () => {
    const { service, gap } = fixture();
    const { repairId } = await service.reportGap('caller', { item_id: 'origin', gap });
    const item = coordinator.getItem('origin'), tree = git(['rev-parse', 'HEAD^{tree}']);
    store.capabilities.save({ ...store.capabilities.get(repairId)!, repairItemId: item.id });
    coordinator.save({ ...item, state: 'verifying', verifierInstanceId: 'checker', worktreePath: repo, checkpointCommit: git(['rev-parse', 'HEAD']) });
    coordinator.registerRole('checker', { role: 'verifier', runId: 'source', itemId: 'origin' });
    const now = Date.now(), operation = 'Seed the Windows copy', result = 'navigator.platform Win32';
    const receipt = JSON.stringify({ launch: { tree, root: repo, startedAt: new Date(now).toISOString(), computer: 'windows-pc', mode: 'windows' },
      runtime: { application: 'Harness', version: 'test-build', isPackaged: false }, operation, result, observedAt: now });
    mkdirSync(join(repo, '_scratch'), { recursive: true }); writeFileSync(join(repo, '_scratch/probe-win.json'), receipt);
    const probe = { computer: 'windows-pc' as const, runtimeBuild: tree, testedTree: tree, observedAt: now, operation, result,
      receiptPath: '_scratch/probe-win.json', receiptSha256: createHash('sha256').update(receipt).digest('hex') };
    await service.reportProbe('checker', { item_id: item.id, probe });
    expect(store.capabilities.get(repairId)?.probeReceipt).toBe(receipt);
    const packagedWindows = receipt.replace('"isPackaged":false', '"isPackaged":true');
    writeFileSync(join(repo, '_scratch/probe-win.json'), packagedWindows);
    await expect(service.reportProbe('checker', { item_id: item.id, probe: { ...probe, receiptSha256: createHash('sha256').update(packagedWindows).digest('hex') } }))
      .rejects.toThrow(/does not match the launch receipt/);
  });
});

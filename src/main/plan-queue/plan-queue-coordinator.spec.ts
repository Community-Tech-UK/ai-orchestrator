import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanQueueCoordinator } from './plan-queue-coordinator';
import { PlanQueueItemFlow } from './plan-queue-item-flow';
import * as readiness from './plan-queue-readiness';
import { SET_ASIDE_FOLDER_METADATA } from './plan-queue-set-aside';
import { _setReportRequiredProvidersForTesting, recordWorkerReport } from './plan-queue-worker-report';
import { landing } from './plan-queue-coordinator.test-mocks';
import {
  repo,
  driver,
  store,
  fake,
  coordinator,
  git,
  FakeInstances,
  writeDoc,
  planDoc,
  implement,
  itemIdOf,
  pass,
  triageAllReady,
  waitForRun,
  startCoordinator,
  never,
  restart,
  waitForState,
  queueWorktrees,
  setFake,
  setCoordinator,
  setQuestionsToParent,
  type Script,
  type FakeInstance,
} from './plan-queue-coordinator.test-helpers';

// The stand-ins every coordinator spec installs, and the shared fixture: see the two modules imported below.
vi.mock('./plan-queue-gate-receipts', async (original) =>
  (await import('./plan-queue-coordinator.test-mocks')).withScriptedGates(await original()));
vi.mock('./plan-queue-landing', async (original) =>
  (await import('./plan-queue-coordinator.test-mocks')).withLandingHooks(await original()));
vi.mock('../workspace/git/worktree-integration', async (original) =>
  (await import('./plan-queue-coordinator.test-mocks')).withPromotionHook(await original()));

describe('PlanQueueCoordinator parent thread recovery and adoption', { timeout: 30_000 }, () => {
  // These cases exercise the explicit parent-chat destination across restored owners.
  beforeEach(() => { setQuestionsToParent(true); });
  async function pendingRun() {
    planDoc('2026-01-01-parent-recovery');
    const parent = fake.addParent();
    parent.historyThreadId = 'history-parent';
    fake.scripts.triage = never;
    fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await coordinator._whenSettledForTesting();
    return { parent, run };
  }

  it('records the parent history thread and rebinds summaries to its restored session', async () => {
    const { parent, run } = await pendingRun();
    expect(store.getRun(run.id)?.parentHistoryThreadId).toBe('history-parent');
    fake.live.delete(parent.id);
    const restored = fake.addParent();
    restored.historyThreadId = 'history-parent';
    coordinator.notifyParent(coordinator.getRun(run.id), 'Recovery summary');
    expect(fake.notes).toContainEqual({ instanceId: restored.id, message: 'Recovery summary' });
    expect(fake.inputs).toEqual([]);
    expect(store.getRun(run.id)?.parentInstanceId).toBe(restored.id);
  });

  it('lets the restored thread owner answer and owns its new worker', async () => {
    const { parent, run } = await pendingRun();
    const item = store.getItem(run.items[0].id)!;
    store.upsertItem({ ...item, state: 'needs-answer', question: {
      question: 'Which account should this work use?', options: [{ id: 'continue', label: 'Account A' }, { id: 'skip', label: 'Leave it' }],
    } });
    fake.live.delete(parent.id);
    const restored = fake.addParent(); restored.historyThreadId = 'history-parent';
    await coordinator.answer(item.id, 'continue', restored.id);
    await waitForState(0, run.id, 'working');
    await vi.waitFor(() => expect(fake.created.some((instance) => instance.role === 'worker')).toBe(true), { timeout: 15_000, interval: 25 });
    expect(store.getRun(run.id)?.parentInstanceId).toBe(restored.id);
    expect(fake.created.find((instance) => instance.role === 'worker')?.config.parentId).toBe(restored.id);
  });

  it.each(['scheduler', 'notification', 'control', 'answer', 'worker-nesting'] as const)(
    'replays waiting questions once when %s first resolves the restored parent', async (entry) => {
      const { parent, run } = await pendingRun();
      const item = store.getItem(run.items[0].id)!;
      store.upsertItem({ ...item, state: 'needs-answer', question: {
        question: 'Which owner should approve this work?', options: [{ id: 'continue', label: 'Owner A' }, { id: 'skip', label: 'Leave it' }],
      } });
      fake.live.delete(parent.id);
      const restored = fake.addParent(); restored.historyThreadId = 'history-parent';
      if (entry === 'notification') coordinator.notifyParent(coordinator.getRun(run.id), 'Unrelated progress update');
      else if (entry === 'control') await coordinator.control({ action: 'pause', runId: run.id }, restored.id);
      else if (entry === 'answer') await expect(coordinator.answer(item.id, 'invalid-option', restored.id)).rejects.toThrow(/no open question/);
      else if (entry === 'worker-nesting') expect(new PlanQueueItemFlow(coordinator).liveParentId(coordinator.getRun(run.id))).toBe(restored.id);
      coordinator.requestPump();
      await coordinator._whenSettledForTesting();
      expect(store.getRun(run.id)?.parentInstanceId).toBe(restored.id);
      expect(fake.inputs.filter((input) => input.instanceId === restored.id && input.message.includes('Which owner should approve this work?'))).toHaveLength(1);
      const messages = fake.inputs.filter((input) => input.instanceId === restored.id).length;
      coordinator.requestPump(); await coordinator._whenSettledForTesting();
      expect(fake.inputs.filter((input) => input.instanceId === restored.id)).toHaveLength(messages);
    });

  it('replays a pending question once after authenticated adoption', async () => {
    const { parent, run } = await pendingRun();
    const item = store.getItem(run.items[0].id)!;
    store.upsertItem({ ...item, state: 'needs-answer', question: {
      question: 'May this work expand its scope?', options: [{ id: 'continue', label: 'Approve' }, { id: 'skip', label: 'Leave it' }],
    } });
    fake.live.delete(parent.id);
    const adopter = fake.addParent();
    await coordinator.control({ action: 'adopt', runId: run.id }, adopter.id);
    await coordinator._whenSettledForTesting();
    expect(fake.inputs.filter((input) => input.instanceId === adopter.id && input.message.includes('May this work expand its scope?'))).toHaveLength(1);
    coordinator.requestPump(); await coordinator._whenSettledForTesting();
    expect(fake.inputs.filter((input) => input.instanceId === adopter.id && input.message.includes('May this work expand its scope?'))).toHaveLength(1);
  });

  it('delivers a new readiness question once when its notification restores ownership', async () => {
    const { parent, run } = await pendingRun();
    const triage = fake.created.find((instance) => instance.role === 'triage')!;
    fake.live.delete(parent.id);
    const restored = fake.addParent(); restored.historyThreadId = 'history-parent';
    coordinator.reportTriage(triage.id, { run_id: run.id, records: [{
      documentPath: run.items[0].sourceRef, disposition: 'needs-answer', question: {
        question: 'May this work expand its scope?', options: [{ id: 'continue', label: 'Approve' }, { id: 'skip', label: 'Leave it' }],
        decision: { kind: 'human-authority', reason: 'Scope requires human authority.' },
      },
    }] });
    await coordinator._whenSettledForTesting();
    expect(store.getRun(run.id)?.parentInstanceId).toBe(restored.id);
    expect(fake.inputs.filter((input) => input.instanceId === restored.id && input.message.includes('May this work expand its scope?'))).toHaveLength(1);
  });

  it('retries a failed replay on the next scheduler pass without duplicating successful delivery', async () => {
    const { parent, run } = await pendingRun();
    const item = store.getItem(run.items[0].id)!;
    store.upsertItem({ ...item, state: 'needs-answer', question: {
      question: 'Which owner should approve this work?', options: [{ id: 'continue', label: 'Owner A' }],
    } });
    fake.live.delete(parent.id);
    const restored = fake.addParent(); restored.historyThreadId = 'history-parent';
    vi.spyOn(fake, 'sendInput').mockRejectedValueOnce(new Error('Parent temporarily unavailable'));
    coordinator.notifyParent(coordinator.getRun(run.id), 'Unrelated progress update');
    await coordinator._whenSettledForTesting();
    expect(fake.inputs.filter((input) => input.message.includes('Which owner should approve this work?'))).toHaveLength(0);
    coordinator.requestPump(); await coordinator._whenSettledForTesting();
    expect(fake.inputs.filter((input) => input.instanceId === restored.id && input.message.includes('Which owner should approve this work?'))).toHaveLength(1);
    coordinator.requestPump(); await coordinator._whenSettledForTesting();
    expect(fake.inputs.filter((input) => input.message.includes('Which owner should approve this work?'))).toHaveLength(1);
  });

  it('keeps one replay in flight while multiple resolver paths inspect the restored owner', async () => {
    const { parent, run } = await pendingRun();
    const item = store.getItem(run.items[0].id)!;
    store.upsertItem({ ...item, state: 'needs-answer', question: {
      question: 'Which owner should approve this work?', options: [{ id: 'continue', label: 'Owner A' }],
    } });
    fake.live.delete(parent.id);
    const restored = fake.addParent(); restored.historyThreadId = 'history-parent';
    let release!: () => void;
    const sending = new Promise<void>((resolve) => { release = resolve; });
    const send = fake.sendInput.bind(fake);
    let attempts = 0;
    vi.spyOn(fake, 'sendInput').mockImplementation(async (...args) => {
      if (args[1].includes('Which owner should approve this work?')) { attempts += 1; await sending; }
      await send(...args);
    });
    coordinator.notifyParent(coordinator.getRun(run.id), 'Unrelated progress update');
    await coordinator.control({ action: 'pause', runId: run.id }, restored.id);
    coordinator.requestPump(); await coordinator._whenSettledForTesting();
    expect(attempts).toBe(1);
    release(); await coordinator._whenSettledForTesting();
    coordinator.requestPump(); await coordinator._whenSettledForTesting();
    expect(fake.inputs.filter((input) => input.message.includes('Which owner should approve this work?'))).toHaveLength(1);
  });

  it('does not let a failed old-owner send reset delivery to a newer restored owner', async () => {
    const { parent, run } = await pendingRun();
    const item = store.getItem(run.items[0].id)!;
    store.upsertItem({ ...item, state: 'needs-answer', question: {
      question: 'Which owner should approve this work?', options: [{ id: 'continue', label: 'Owner A' }],
    } });
    fake.live.delete(parent.id);
    const first = fake.addParent(); first.historyThreadId = 'history-parent';
    let reject!: (error: Error) => void;
    const sending = new Promise<void>((_resolve, rejectSend) => { reject = rejectSend; });
    const send = fake.sendInput.bind(fake);
    vi.spyOn(fake, 'sendInput').mockImplementation(async (...args) => {
      if (args[0] === first.id && args[1].includes('Which owner should approve this work?')) return sending;
      await send(...args);
    });
    coordinator.resolveRunParent(coordinator.getRun(run.id));
    fake.live.delete(first.id);
    const second = fake.addParent(); second.historyThreadId = 'history-parent';
    coordinator.resolveRunParent(coordinator.getRun(run.id));
    await coordinator._whenSettledForTesting();
    reject(new Error('Old owner disappeared')); await coordinator._whenSettledForTesting();
    coordinator.requestPump(); await coordinator._whenSettledForTesting();
    expect(fake.inputs.filter((input) => input.instanceId === second.id && input.message.includes('Which owner should approve this work?'))).toHaveLength(1);
  });

  it('delivers a new worker question once when its notification restores ownership', async () => {
    planDoc('2026-01-01-worker-question-recovery');
    const parent = fake.addParent(); parent.historyThreadId = 'history-parent';
    fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForState(0, run.id, 'working');
    const worker = fake.created.find((instance) => instance.role === 'worker')!;
    await vi.waitFor(() => expect(worker.status).toBe('busy'), { timeout: 15_000, interval: 25 });
    fake.live.delete(parent.id);
    const restored = fake.addParent(); restored.historyThreadId = 'history-parent';
    fake.say(worker, 'Which retention period has James approved?');
    fake.setStatus(worker, 'waiting_for_input');
    await coordinator._whenSettledForTesting();
    expect(store.getItem(run.items[0].id)?.question?.question).toBe('Which retention period has James approved?');
    const messages = fake.inputs.filter((input) => input.instanceId === restored.id && input.message.includes('Which retention period has James approved?'));
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toContain('the worker for');
    coordinator.requestPump(); await coordinator._whenSettledForTesting();
    expect(fake.inputs.filter((input) => input.instanceId === restored.id && input.message.includes('Which retention period has James approved?'))).toHaveLength(1);
  });

  it('does not replay questions when an in-flight resolver discovers a restored parent after shutdown', async () => {
    const { parent, run } = await pendingRun();
    const item = store.getItem(run.items[0].id)!;
    store.upsertItem({ ...item, state: 'needs-answer', question: {
      question: 'Which owner should approve this work?', options: [{ id: 'continue', label: 'Owner A' }],
    } });
    coordinator.shutdown();
    fake.live.delete(parent.id);
    const restored = fake.addParent(); restored.historyThreadId = 'history-parent';
    coordinator.resolveRunParent(coordinator.getRun(run.id));
    coordinator.notifyParent(coordinator.getRun(run.id), 'Late progress update');
    coordinator.requestPump(); await coordinator._whenSettledForTesting();
    expect(fake.inputs.filter((input) => input.instanceId === restored.id)).toHaveLength(0);
  });

  it('adopts a stranded run and keeps its queued item moving', async () => {
    const { parent, run } = await pendingRun();
    const item = store.getItem(run.items[0].id)!;
    fake.live.delete(parent.id);
    const adopter = fake.addParent(); adopter.historyThreadId = 'adopter-thread';
    await coordinator.control({ action: 'adopt', runId: run.id }, adopter.id);
    expect(store.getRun(run.id)).toMatchObject({ parentInstanceId: adopter.id, parentHistoryThreadId: 'adopter-thread', status: 'running' });
    expect(fake.notes.some((input) => input.instanceId === adopter.id && input.message.includes('You now own Plan Queue run')
      && input.message.includes('1 items waiting, 0 in progress'))).toBe(true);
    store.upsertItem({ ...item, state: 'queued' });
    coordinator.requestPump();
    await waitForState(0, run.id, 'working');
    await vi.waitFor(() => expect(fake.created.find((instance) => instance.role === 'worker')?.config.parentId).toBe(adopter.id), { timeout: 15_000, interval: 25 });
  });

  it('moves a live owner\'s run for James (Move and aio-mcp plan-queue move) only once its work has stopped', async () => {
    const { parent, run } = await pendingRun();
    const taker = fake.addParent();
    const move = () => coordinator.control({ action: 'handover', runId: run.id, targetInstanceId: taker.id });
    await expect(move()).rejects.toThrow('Pause this run');
    expect(store.getRun(run.id)?.parentInstanceId).toBe(parent.id);

    await coordinator.control({ action: 'pause', runId: run.id });
    await move();
    expect(store.getRun(run.id)).toMatchObject({ parentInstanceId: taker.id, status: 'paused' });
    expect(fake.notes.some(input => input.instanceId === taker.id && input.message.includes('You now own Plan Queue run'))).toBe(true);
    await vi.waitFor(() => expect(fake.inputs.some(input => input.instanceId === parent.id && input.message.includes('You no longer own it'))).toBe(true), { timeout: 15_000, interval: 25 });
  });

  it('refuses a move queued behind a cancel that leaves the run with no set-aside work', async () => {
    const { parent, run } = await pendingRun();
    await coordinator.control({ action: 'pause', runId: run.id });
    const taker = fake.addParent();
    // The move is checked and queued while the run is still paused; the cancel finishes first.
    const cancel = coordinator.control({ action: 'cancel', runId: run.id });
    const move = coordinator.control({ action: 'handover', runId: run.id, targetInstanceId: taker.id });
    await cancel;
    await expect(move).rejects.toThrow('holds no set-aside work; there is nothing to move');
    expect(store.listItems(run.id).some(item => item.state === 'parked')).toBe(false);
    expect(store.getRun(run.id)).toMatchObject({ parentInstanceId: parent.id, status: 'cancelled' });
  });

  it('never makes a Set aside agent the owner of a run', async () => {
    const { parent, run } = await pendingRun();
    await coordinator.control({ action: 'pause', runId: run.id });
    const setAside = fake.addParent(); setAside.metadata = { [SET_ASIDE_FOLDER_METADATA]: repo };
    await expect(coordinator.control({ action: 'handover', runId: run.id, targetInstanceId: setAside.id }))
      .rejects.toThrow('A Set aside agent cannot own a Plan Queue run.');
    expect(store.getRun(run.id)?.parentInstanceId).toBe(parent.id);
  });

  it.each(['original', 'restored'] as const)('refuses adoption while the %s parent is live', async (kind) => {
    const { parent, run } = await pendingRun();
    const adopter = fake.addParent();
    if (kind === 'restored') {
      fake.live.delete(parent.id);
      const restored = fake.addParent(); restored.historyThreadId = 'history-parent';
    }
    await expect(coordinator.control({ action: 'adopt', runId: run.id }, adopter.id)).rejects.toThrow(/live parent|still exists/);
    expect(store.getRun(run.id)?.parentInstanceId).not.toBe(adopter.id);
  });

  it('refuses queue-spawned sessions and absent callers as adopters', async () => {
    const { parent, run } = await pendingRun();
    fake.live.delete(parent.id);
    const worker = fake.addParent(); worker.metadata = { planQueueRole: 'worker' }; worker.historyThreadId = 'history-parent';
    await expect(coordinator.control({ action: 'adopt', runId: run.id }, worker.id)).rejects.toThrow();
    await expect(coordinator.control({ action: 'adopt', runId: run.id }, 'missing-caller')).rejects.toThrow();
    await expect(coordinator.control({ action: 'adopt', runId: run.id })).rejects.toThrow();
    expect(store.getRun(run.id)?.parentInstanceId).toBe(parent.id);
  });
});

describe('PlanQueueCoordinator — autonomous readiness and current documents', { timeout: 30_000 }, () => {
  it('does not report settlement while a filesystem-backed scheduler pass is pending', async () => {
    planDoc('2026-01-01-alpha');
    fake.scripts.triage = never;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reconcile = readiness.reconcileWaitingDocuments;
    const inspection = vi.spyOn(readiness, 'reconcileWaitingDocuments').mockImplementationOnce(async (...args) => {
      await gate;
      await reconcile(...args);
    });
    let settled = false;
    let settling: Promise<void> | undefined;
    try {
      await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
      settling = coordinator._whenSettledForTesting().then(() => { settled = true; });
      // A pending disk operation can outlive any fixed number of event-loop turns.
      for (let turn = 0; turn < 50; turn += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(settled).toBe(false);
    } finally {
      release();
      await settling;
      inspection.mockRestore();
      await coordinator._whenSettledForTesting();
    }
    expect(settled).toBe(true);
  });

  it('classifies 29 documents in four batches while work on reported documents starts', async () => {
    for (let index = 0; index < 29; index += 1) planDoc(`2026-01-01-${String(index).padStart(2, '0')}`);
    fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans', config: { workerSlots: 1 } });
    await vi.waitFor(() => expect(store.listItems(run.id).some((item) => item.state === 'discovered')).toBe(false), { timeout: 10_000 });
    const sessions = fake.created.filter((instance) => instance.role === 'triage');
    expect(sessions).toHaveLength(4);
    expect(sessions.map((instance) => instance.config.initialPrompt!.match(/<documents>\n([\s\S]*?)\n<\/documents>/)![1].split('\n').length)).toEqual([8, 8, 8, 5]);
    await waitForState(0, run.id, 'working');
  });

  const question = {
    question: 'Which existing service should implement this check?',
    options: [{ id: 'existing', label: 'Use the existing service' }, { id: 'skip', label: 'Leave this document' }],
  };

  it('answers an evidenced technical choice and passes the agent decision to the worker', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.triage = (instance) => {
      const runId = instance.config.metadata!['planQueueRunId'] as string;
      const doc = coordinator.getRunDto(runId)!.items[0].sourceRef;
      coordinator.reportTriage(instance.id, { run_id: runId, records: [{
        documentPath: doc, disposition: 'needs-answer', question: { ...question, decision: {
          kind: 'technical', recommendedOptionId: 'existing', reason: 'The existing service owns the runtime path.',
          evidence: 'src/service.ts:10 exposes the required operation.',
        } },
      }] });
    };
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await vi.waitFor(() => expect(fake.created.some((i) => i.role === 'worker')).toBe(true), { timeout: 5_000 });
    await waitForRun(run.id);
    const final = coordinator.getRunDto(run.id)!.items[0];
    expect(final.state).toBe('landed');
    expect(final.question).toBeNull();
    expect(final.answer).toContain('Automatic technical decision');
    expect(final.answer).toContain('Use the existing service');
    expect(final.answer).toContain('src/service.ts:10');
    expect(fake.created.find((i) => i.role === 'worker')!.config.initialPrompt).toContain(final.answer!);
    expect(final.answer).toContain(question.question);
    expect(fake.created.find((i) => i.role === 'worker')!.config.initialPrompt).toContain(question.question);
    expect(fake.inputs.filter((i) => i.instanceId === parent.id).some((i) => i.message.includes('needs James to decide'))).toBe(false);
  });

  it.each(['human-authority', 'human-input', undefined] as const)('keeps %s questions pending', async (kind) => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.triage = (instance) => {
      const runId = instance.config.metadata!['planQueueRunId'] as string;
      coordinator.reportTriage(instance.id, { run_id: runId, records: [{
        sourceRef: coordinator.getRunDto(runId)!.items[0].sourceRef,
        disposition: 'needs-answer', question: { ...question, ...(kind ? { decision: { kind, reason: 'A real human boundary remains.' } } : {}) },
      }] });
    };
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForState(0, run.id, 'needs-answer');
    expect(fake.created.some((i) => i.role === 'worker')).toBe(false);
    expect(coordinator.getRunDto(run.id)!.items[0].answer).toBeNull();
  });

  it('recovers a persisted technical question automatically after a restart', async () => {
    planDoc('2026-01-01-alpha');
    fake.scripts.triage = never;
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await coordinator._whenSettledForTesting();
    store.upsertItem({ ...store.getItem(run.items[0].id)!, state: 'needs-answer', question: {
      ...question, decision: { kind: 'technical', recommendedOptionId: 'existing',
        reason: 'Use the existing runtime owner.', evidence: 'src/service.ts:10' },
    } });
    const next = await restart();
    await waitForRun(run.id);
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'landed', question: null });
    expect(next.created.find((i) => i.role === 'worker')!.config.initialPrompt).toContain('Automatic technical decision');
    expect(next.created.some((i) => i.role === 'triage')).toBe(false);
  });

  it('reconciles a completed replacement before a recovered queued item starts', async () => {
    const doc = planDoc('2026-01-01-alpha');
    fake.scripts.triage = never;
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await coordinator._whenSettledForTesting();
    store.upsertItem({ ...store.getItem(run.items[0].id)!, state: 'queued' });
    renameSync(doc, doc.replace('_plan.md', '_plan_completed.md'));
    const next = await restart();
    await waitForRun(run.id);
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'skipped', question: null, verdict: null });
    expect(next.created.some((i) => i.role === 'worker')).toBe(false);
  });

  it('parks repeated triage failure without inventing an answer for James', async () => {
    planDoc('2026-01-01-alpha');
    fake.scripts.triage = () => undefined;
    const parent = fake.addParent();
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'parked', parkReason: 'triage-failed', question: null });
    expect(fake.created.filter((i) => i.role === 'triage')).toHaveLength(2);
    expect(fake.created.some((i) => i.role === 'worker')).toBe(false);
    expect(fake.inputs.some((i) => i.instanceId === parent.id && i.message.includes('needs James to decide'))).toBe(false);
  });

  it('sends missing-spec investigation to triage rather than inventing a human question', async () => {
    writeDoc('docs/plans/2026-01-01-orphan_plan.md', '**Spec:** [spec](./missing_spec_planned.md)\n');
    fake.scripts.triage = never;
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    expect(run.items[0].state).toBe('discovered');
    expect(run.items[0].question).toBeNull();
    expect(run.items[0].detail).toContain('missing_spec_planned.md');
  });

  it('leaves an unplanned spec open without queueing a worker against an obsolete planning path', async () => {
    const doc = writeDoc('docs/plans/2026-01-01-new_spec.md', '# Open scope needing an implementation plan\n');
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await waitForRun(run.id);
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'skipped', question: null, answer: null, verdict: null });
    expect(coordinator.getRunDto(run.id)!.items[0].detail).toContain('spec remains open');
    expect(readFileSync(doc, 'utf8')).toBe('# Open scope needing an implementation plan\n');
    expect(existsSync(doc.replace('_spec.md', '_spec_completed.md'))).toBe(false);
    expect(fake.created.some((i) => i.role === 'worker' || i.role === 'triage')).toBe(false);
  });

  it('retires a stale readiness question when its document has an exact completed replacement', async () => {
    const doc = planDoc('2026-01-01-alpha');
    fake.scripts.triage = never;
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await coordinator._whenSettledForTesting();
    const item = store.getItem(run.items[0].id)!;
    store.upsertItem({ ...item, state: 'needs-answer', question });
    renameSync(doc, doc.replace('_plan.md', '_plan_completed.md'));
    coordinator.requestPump();
    await vi.waitFor(() => expect(store.getItem(item.id)?.state).toBe('skipped'), { timeout: 5_000 });
    const final = store.getItem(item.id)!;
    expect(final.question).toBeNull();
    expect(final.verdict).toBeNull();
    expect(final.detail).toContain('completed replacement');
    expect(fake.created.some((i) => i.role === 'worker')).toBe(false);
    expect(readFileSync(doc.replace('_plan.md', '_plan_completed.md'), 'utf8')).not.toContain('As built');
  });

  it('parks a disappeared document without a replacement as an error, not a question', async () => {
    const doc = planDoc('2026-01-01-alpha');
    fake.scripts.triage = never;
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await coordinator._whenSettledForTesting();
    rmSync(doc);
    coordinator.requestPump();
    await vi.waitFor(() => expect(store.getItem(run.items[0].id)?.state).toBe('parked'), { timeout: 5_000 });
    expect(store.getItem(run.items[0].id)).toMatchObject({ parkReason: 'missing-document', question: null, verdict: null });
    expect(store.getItem(run.items[0].id)!.detail).toContain('missing');
    expect(fake.created.some((i) => i.role === 'worker')).toBe(false);
  });

  it('keeps an active source when a completed filename also exists', async () => {
    const doc = planDoc('2026-01-01-alpha');
    writeFileSync(doc.replace('_plan.md', '_plan_completed.md'), '# Earlier campaign\n');
    fake.scripts.triage = never;
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await coordinator._whenSettledForTesting();
    expect(store.getItem(run.items[0].id)!.state).toBe('discovered');
  });
});


describe('PlanQueueCoordinator — whole run against a temp repo', { timeout: 30_000 }, () => {
  it('does not spawn a readiness session when tools become ready after shutdown', async () => {
    planDoc('2026-01-01-alpha');
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    PlanQueueCoordinator._resetForTesting();
    setCoordinator(startCoordinator(fake, null, { whenOrchestratorToolsListening: () => ready }));
    await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await coordinator._whenSettledForTesting();
    coordinator.shutdown();
    release();
    await coordinator._whenSettledForTesting();
    expect(fake.created.filter((instance) => instance.role === 'triage')).toHaveLength(0);
  });

  it('does not spawn triage when tools become ready after Close all', async () => {
    planDoc('2026-01-01-alpha');
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    PlanQueueCoordinator._resetForTesting();
    setCoordinator(startCoordinator(fake, null, { whenOrchestratorToolsListening: () => ready }));
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await coordinator._whenSettledForTesting();
    coordinator.noteUserClosing([], 'all');
    release();
    await coordinator._whenSettledForTesting();
    expect(store.getRun(run.id)?.status).toBe('paused');
    expect(fake.created.filter(instance => instance.role === 'triage')).toHaveLength(0);
    expect(store.listItems(run.id)[0].state).toBe('discovered');
  });

  it('pauses every running run before a user close and parks the closed worker without refilling', async () => {
    planDoc('2026-01-01-alpha'); planDoc('2026-01-02-beta');
    fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans', config: { workerSlots: 1 } });
    await waitForState(0, run.id, 'working');
    const worker = fake.created.find(instance => instance.role === 'worker')!;
    expect(coordinator.noteUserClosing([worker.id], 'all')).toBe(1);
    await fake.terminateInstance(worker.id);
    await waitForState(0, run.id, 'parked');
    await coordinator._whenSettledForTesting();
    expect(store.getRun(run.id)?.status).toBe('paused');
    expect(store.getItem(run.items[0].id)).toMatchObject({ parkReason: 'cancelled', detail: expect.stringContaining('you closed its session') });
    expect(fake.created.filter(instance => instance.role === 'worker')).toHaveLength(1);
  });

  it('a single user close cancels that worker while the run continues', async () => {
    planDoc('2026-01-01-alpha'); fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await waitForState(0, run.id, 'working');
    const worker = fake.created.find(instance => instance.role === 'worker')!;
    expect(coordinator.noteUserClosing([worker.id], 'one')).toBe(0);
    expect(store.getRun(run.id)?.status).toBe('running');
    await fake.terminateInstance(worker.id); await waitForState(0, run.id, 'parked');
    expect(store.getItem(run.items[0].id)?.parkReason).toBe('cancelled');
  });

  it('a user-closed verifier consumes no errored round and waits for resume', async () => {
    planDoc('2026-01-01-alpha'); fake.scripts.verifier = never;
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await waitForState(0, run.id, 'verifying');
    // The item shows as verifying before its checker exists; a busy host needs more than vi.waitFor's 1 s default.
    await vi.waitFor(() => expect(fake.created.some(instance => instance.role === 'verifier')).toBe(true), { timeout: 15_000, interval: 25 });
    const verifier = fake.created.find(instance => instance.role === 'verifier')!;
    coordinator.noteUserClosing([verifier.id], 'all');
    await fake.terminateInstance(verifier.id); await waitForState(0, run.id, 'awaiting-slot');
    expect(store.getItem(run.items[0].id)).toMatchObject({ erroredRounds: 0, round: 0, detail: 'Its checker was closed; it will be checked again.' });
  });

  it('leaves a removed worker working during app shutdown and starts no further item', async () => {
    planDoc('2026-01-01-alpha');
    planDoc('2026-01-02-beta');
    fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans', config: { workerSlots: 1 } });
    await waitForState(0, run.id, 'working');
    await vi.waitFor(() => expect(fake.created.filter((instance) => instance.role === 'worker')).toHaveLength(1), { timeout: 15_000, interval: 25 });
    coordinator.shutdown();
    await fake.terminateInstance(fake.created.find((instance) => instance.role === 'worker')!.id);
    coordinator.requestPump();
    await coordinator._whenSettledForTesting();
    expect(store.getItem(run.items[0].id)?.state).toBe('working');
    expect(store.getRun(run.id)?.status).toBe('running');
    expect(fake.created.filter((instance) => instance.role === 'worker')).toHaveLength(1);
  });

  it('lands one verified plan as a squash commit, closes its documents and leaves no worktree', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    expect(run.items.map((i) => i.state)).toEqual(['discovered']);
    await waitForRun(run.id);

    const final = coordinator.getRunDto(run.id)!;
    expect(final.items[0]).toMatchObject({ state: 'landed', round: 1, worktreePath: null, branchName: null });
    // One commit, made with hooks, carries the code AND the closed documents.
    const log = git(['log', '--format=%s', 'main']).split('\n');
    expect(log).toEqual(['Plan: 2026-01-01-alpha_plan', 'base']);
    expect(git(['show', '--name-only', '--format=', 'main']).split('\n').sort()).toEqual([
      '2026-01-01-alpha_plan.feature.txt',
      'docs/plans/2026-01-01-alpha_plan_closure_completed.json',
      'docs/plans/2026-01-01-alpha_plan_completed.md',
      'docs/plans/2026-01-01-alpha_spec_completed.md',
    ]);
    expect(git(['show', 'main:docs/plans/2026-01-01-alpha_spec_completed.md'])).toContain('2026-01-01-alpha_plan_completed.md');
    // Active names are retired; retain exactly the original inodes for late writers.
    expect(existsSync(join(repo, 'docs/plans/2026-01-01-alpha_plan.md'))).toBe(false);
    expect(existsSync(join(repo, 'docs/plans/2026-01-01-alpha_spec_planned.md'))).toBe(false);
    const retained = readdirSync(join(repo, 'docs/plans')).filter(name => name.includes('.aio-retained-')).sort();
    expect(retained).toEqual([
      expect.stringMatching(/^\.2026-01-01-alpha_plan\.md\.aio-retained-[0-9a-f-]{36}$/),
      expect.stringMatching(/^\.2026-01-01-alpha_spec_planned\.md\.aio-retained-[0-9a-f-]{36}$/),
    ]);
    expect(retained.map(name => readFileSync(join(repo, 'docs/plans', name), 'utf8'))).toEqual([
      '# Plan\n\n**Spec:** [spec](./2026-01-01-alpha_spec_planned.md)\n\n- [ ] build it\n\nAs built: done.\n',
      '# Spec\n\n**Plan:** [plan](./2026-01-01-alpha_plan.md)\n',
    ]);
    expect(git(['status', '--porcelain', '--untracked-files=all']).split('\n').sort())
      .toEqual(retained.map(name => `?? docs/plans/${name}`));
    expect(readFileSync(join(repo, 'docs/plans/2026-01-01-alpha_plan_completed.md'), 'utf8'))
      .toBe('# Plan\n\n**Spec:** [spec](./2026-01-01-alpha_spec_completed.md)\n\n- [ ] build it\n\nAs built: done.\n');
    expect(queueWorktrees()).toEqual([]);
    expect(git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/queue/'])).toBe('');

    const worker = fake.created.find((i) => i.role === 'worker')!;
    expect(worker.config).toMatchObject({ parentId: parent.id, provider: 'claude', modelOverride: 'claude-sonnet-5', yoloMode: true });
    const verifier = fake.created.find((i) => i.role === 'verifier')!;
    expect(verifier.config).toMatchObject({ parentId: parent.id, provider: 'codex' });
    // The parent got the end-of-run summary.
    expect(fake.inputs.some((m) => m.instanceId === parent.id && m.message.includes('Landed 1'))).toBe(true);

    // What Queue health is computed from: both sessions' start and end with provider and model, and the landing's steps.
    const timings = (reason: string) => driver.prepare('SELECT detail_head AS detail FROM plan_queue_item_events WHERE reason = ? ORDER BY rowid')
      .all<{ detail: string }>(reason).map((row) => JSON.parse(row.detail) as Record<string, unknown>);
    expect(timings('session-start')).toEqual([
      { role: 'worker', instanceId: worker.id, provider: 'claude', model: 'claude-sonnet-5' },
      { role: 'checker', instanceId: verifier.id, provider: 'codex', model: null },
    ]);
    expect(timings('session-end')).toEqual([{ role: 'checker', instanceId: verifier.id }, { role: 'worker', instanceId: worker.id }]);
    expect(timings('landing-timing')).toEqual([expect.objectContaining({ outcome: 'landed', commitCheckMs: expect.any(Number),
      publishMs: expect.any(Number), totalMs: expect.any(Number), loadStart: expect.any(Number), loadEnd: expect.any(Number) })]);
    expect(coordinator.getQueueHealth()).toMatchObject({ attemptsLanded: { count: 1, of: 1 }, firstCheckPassed: { count: 1, of: 1 },
      landingTime: { count: 1 }, checkTime: { count: 1 } });

    // Where full test runs went comes from the remote checks folder, when there is one.
    const machine = join(repo, 'remote-checks-folder');
    mkdirSync(machine);
    writeFileSync(join(machine, 'config.json'), '{"host":"pc","label":"the PC"}');
    try {
      vi.stubEnv('AIO_REMOTE_CHECKS_DIR', machine);
      expect(coordinator.getQueueHealth().testMachine).toMatchObject({ label: 'the PC', unreachable: false });
      vi.stubEnv('AIO_REMOTE_CHECKS_DIR', join(repo, 'no-such-folder'));
      expect(coordinator.getQueueHealth()).not.toHaveProperty('testMachine');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('runs three items with two worker slots, one verification and one landing at a time', async () => {
    for (const stem of ['2026-01-01-a', '2026-01-02-b', '2026-01-03-c']) planDoc(stem);
    const parent = fake.addParent();
    const slowWorker: Script = async (instance, message, f) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await implement(instance, message, f);
    };
    fake.scripts.worker = slowWorker;

    const { run } = await coordinator.startRun({
      parentInstanceId: parent.id,
      kind: 'plans',
      config: { workerSlots: 2, verificationSlots: 1, postMergeGate: [] },
    });
    await waitForRun(run.id, 60_000);

    expect(coordinator.getRunDto(run.id)!.items.map((i) => i.state)).toEqual(['landed', 'landed', 'landed']);
    expect(fake.maxLive.worker).toBeLessThanOrEqual(2);
    expect(fake.maxLive.verifier).toBe(1);
    expect(landing.max).toBe(1);
    expect(git(['log', '--format=%s', 'main']).split('\n').filter((s) => s.startsWith('Plan: '))).toHaveLength(3);
  }, 60_000);

  it('shares verification slots across runs without starving a run whose own cap is smaller', async () => {
    planDoc('2026-01-01-alpha');
    writeDoc('docs/plans/2026-01-02-beta_livetest.md', '# L\n');
    const parent = fake.addParent();
    const hold: Script = never;
    fake.scripts.verifier = hold;
    // plans run (2 shared slots) with one verification in flight...
    const plans = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForState(0, plans.run.id, 'verifying');
    // ...then a livetests run (its own cap is 1) must still get a verifier.
    const livetests = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'livetests' });
    await waitForState(0, livetests.run.id, 'verifying');
    // The state flips first; the verifier session is spawned a few awaits later.
    await vi.waitFor(() => {
      if (fake.created.filter((i) => i.role === 'verifier').length < 2) throw new Error('livetest verifier not spawned');
    }, { timeout: 15_000, interval: 25 });
    expect(fake.maxLive.verifier).toBe(2);
  });

  it('sends FAIL findings back to the same worker and lands after a later PASS', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    let verifications = 0;
    fake.scripts.verifier = (instance) => {
      verifications += 1;
      coordinator.reportVerdict(instance.id, {
        item_id: itemIdOf(instance),
        verdict: verifications === 1 ? 'FAIL' : 'PASS',
        findings: verifications === 1 ? [{ severity: 'high', confidence: 85, summary: 'Missing retry test.', file: 'a.txt:1' }] : [],
        gates_run: [], document_complete: true, need_james: [], not_checked: [],
      });
    };

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);

    const item = coordinator.getRunDto(run.id)!.items[0];
    expect(item).toMatchObject({ state: 'landed', round: 2 });
    const workers = fake.created.filter((i) => i.role === 'worker');
    expect(workers).toHaveLength(1);
    const fix = fake.inputs.find((m) => m.instanceId === workers[0].id);
    expect(fix?.message).toContain('Missing retry test.');
    expect(fix?.message).toContain('verification round 1 of 3');
    // LT-657: queue-authored worker and parent messages are Harness input, never the user's.
    expect(fix?.internalSource).toBe('plan-queue');
    const parentMessages = fake.inputs.filter((m) => m.instanceId === parent.id);
    expect(parentMessages.length).toBeGreaterThan(0);
    expect(parentMessages.every((m) => m.internalSource === 'plan-queue')).toBe(true);
  });

  it('parks at the round limit, keeps the branch and names it in the document', async () => {
    const doc = planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.verifier = (instance) => {
      coordinator.reportVerdict(instance.id, {
        item_id: itemIdOf(instance), verdict: 'FAIL',
        findings: [{ severity: 'medium', confidence: 70, summary: 'Still wrong.' }], gates_run: [], document_complete: true, need_james: [], not_checked: [],
      });
    };

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { maxRounds: 2 } });
    await waitForRun(run.id);

    const item = coordinator.getRunDto(run.id)!.items[0];
    expect(item).toMatchObject({ state: 'parked', parkReason: 'round-limit', round: 2, worktreePath: null });
    expect(item.branchName).toMatch(/^queue\//);
    expect(git(['rev-list', '--count', `main..${item.branchName}`])).not.toBe('0');
    expect(readFileSync(doc, 'utf8')).toContain(`Plan Queue parked work: \`${item.branchName}\``);
    expect(queueWorktrees().flatMap((d) => readdirSync(join(repo, '.worktrees', 'queue', d)))).toEqual([]);
    expect(git(['log', '--format=%s', 'main'])).toBe('base');
  });

  it('parks as verifier-unreliable after two verifiers end without a verdict', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.verifier = () => undefined;

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);

    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'parked', parkReason: 'verifier-unreliable', erroredRounds: 2 });
    const verifiers = fake.created.filter((i) => i.role === 'verifier');
    expect(verifiers).toHaveLength(2);
    // Each silent verifier was reminded before its round counted as unusable.
    for (const verifier of verifiers) {
      expect(fake.inputs.filter((m) => m.instanceId === verifier.id).map((m) => m.message.split(':')[0]))
        .toEqual(['Plan Queue reminder 1 of 2', 'Plan Queue reminder 2 of 2']);
    }
  });

  it('reminds a verifier that ended its turn without a verdict and accepts its verdict from the same session', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.verifier = (instance, message) => {
      if (message.startsWith('Plan Queue reminder 1 of 2')) pass(instance, message, fake);
    };

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);

    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'landed', erroredRounds: 0 });
    const verifiers = fake.created.filter((i) => i.role === 'verifier');
    expect(verifiers).toHaveLength(1);
    const reminders = fake.inputs.filter((m) => m.instanceId === verifiers[0].id);
    expect(reminders).toHaveLength(1);
    expect(reminders[0].internalSource).toBe('plan-queue');
    expect(reminders[0].message).toContain('orchestrator.tool_search');
    expect(reminders[0].message).toContain('never end your turn while a gate is still running');
  });

  it('does not remind a verifier that changed the tree or failed', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    let verifications = 0;
    fake.scripts.verifier = (instance) => {
      verifications += 1;
      if (verifications === 1) writeFileSync(join(instance.workingDirectory!, 'a.txt'), 'verifier edit\n');
      else fake.setStatus(instance, 'error');
    };

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);

    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'parked', parkReason: 'verifier-unreliable', erroredRounds: 2 });
    const verifiers = fake.created.filter((i) => i.role === 'verifier');
    expect(verifiers).toHaveLength(2);
    expect(fake.inputs.filter((m) => verifiers.some((v) => v.id === m.instanceId))).toEqual([]);
    expect(git(['show', 'main:a.txt'])).toBe('base');
  });

  it('refuses a verdict from anyone but the assigned verifier', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    const attempts: string[] = [];
    fake.scripts.verifier = (instance) => {
      // While the item is verifying, its worker and the parent both try to report.
      const worker = fake.created.find((i) => i.role === 'worker')!;
      for (const caller of [worker.id, parent.id]) {
        try {
          coordinator.reportVerdict(caller, {
            item_id: itemIdOf(instance), verdict: 'PASS', findings: [], gates_run: [], document_complete: true, need_james: [], not_checked: [],
          });
          attempts.push('accepted');
        } catch (error) {
          attempts.push(String(error));
        }
      }
      coordinator.reportVerdict(instance.id, {
        item_id: itemIdOf(instance), verdict: 'FAIL', findings: [], gates_run: [], document_complete: true, need_james: [], not_checked: [],
      });
    };

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { maxRounds: 1 } });
    await waitForRun(run.id);
    expect(attempts).toHaveLength(2);
    expect(attempts.every((a) => a.includes('Only the verifier currently assigned'))).toBe(true);
    // Only the real verifier's FAIL counted.
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'parked', parkReason: 'round-limit' });
    expect(() => coordinator.reportTriage(parent.id, { run_id: run.id, records: [{ documentPath: 'x', disposition: 'ready' }] }))
      .toThrow(/Only the triage agent/);
  });

  it('discards a verdict from a verifier that changed the tree, reverts it, and verifies again', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    let verifications = 0;
    fake.scripts.verifier = (instance) => {
      verifications += 1;
      if (verifications === 1) writeFileSync(join(instance.workingDirectory!, 'a.txt'), 'verifier edit\n');
      pass(instance, '', fake);
    };

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);

    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'landed', erroredRounds: 1 });
    expect(git(['show', 'main:a.txt'])).toBe('base');
  });

  it('asks James about a genuine authority boundary and starts it after his answer', async () => {
    setQuestionsToParent(true);
    writeDoc('docs/plans/2026-01-01-orphan_plan.md', '# Plan\n\n**Spec:** [spec](./2026-01-01-orphan_spec_planned.md)\n');
    fake.scripts.triage = (instance) => {
      const runId = instance.config.metadata!['planQueueRunId'] as string;
      coordinator.reportTriage(instance.id, { run_id: runId, records: [{
        sourceRef: coordinator.getRunDto(runId)!.items[0].sourceRef,
        disposition: 'needs-answer', question: {
          question: 'May this work expand the approved scope?',
          options: [{ id: 'proceed', label: 'Approve the scope' }, { id: 'skip', label: 'Leave it' }],
          decision: { kind: 'human-authority', reason: 'This changes the approved scope.' },
        },
      }] });
    };
    const parent = fake.addParent();

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForState(0, run.id, 'needs-answer');
    const item = coordinator.getRunDto(run.id)!.items[0];
    expect(item.state).toBe('needs-answer');
    expect(fake.inputs.find((m) => m.instanceId === parent.id)?.message).toContain(`item_id "${item.id}"`);

    await expect(coordinator.answer(item.id, 'proceed', 'someone-else')).rejects.toThrow(/Only the session that started/);
    await coordinator.answer(item.id, 'proceed', parent.id);
    await waitForRun(run.id);
    expect(coordinator.getRunDto(run.id)!.items[0].state).toBe('landed');
  });

  it('parks in-flight work and skips the rest when James cancels', async () => {
    planDoc('2026-01-01-alpha');
    planDoc('2026-01-02-beta');
    const parent = fake.addParent();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let built = false;
    fake.scripts.worker = async (instance, message, f) => {
      await implement(instance, message, f);
      built = true;
      await blocked;
    };

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { workerSlots: 1 } });
    // An item shows as working before its worker has run, so cancel only once the worker has written its file:
    // cancelling earlier leaves nothing to checkpoint. The budget matches waitForState, as a busy host needs it.
    await vi.waitFor(() => { if (!built) throw new Error('the worker has not written its file yet'); }, { timeout: 15_000, interval: 25 });
    expect(coordinator.getRunDto(run.id)!.items.some((i) => i.state === 'working')).toBe(true);
    await coordinator.control({ action: 'cancel', runId: run.id });
    release();

    const items = coordinator.getRunDto(run.id)!.items;
    expect(coordinator.getRunDto(run.id)!.status).toBe('cancelled');
    expect(items.map((i) => [i.state, i.parkReason])).toEqual([['parked', 'cancelled'], ['skipped', null]]);
    // The parked item's work was checkpointed onto its branch before teardown.
    expect(git(['show', `${items[0].branchName}:2026-01-01-alpha_plan.feature.txt`])).toBe('built 2026-01-01-alpha_plan');
    expect(queueWorktrees().flatMap((d) => readdirSync(join(repo, '.worktrees', 'queue', d)))).toEqual([]);
  });
});


describe('PlanQueueCoordinator — livetest mode', { timeout: 30_000 }, () => {
  function livetestVerdict(documentComplete: boolean): Script {
    return (instance) => {
      coordinator.reportVerdict(instance.id, {
        item_id: itemIdOf(instance),
        verdict: 'PASS',
        findings: [],
        gates_run: [{ command: 'npx tsc --noEmit', exitCode: 0 }],
        document_complete: documentComplete,
        not_checked: [],
        need_james: [
          { check: 'Check 2: Face ID unlock', classification: 'real', reason: 'Needs a physical iPhone.' },
          { check: 'Check 3: Computer Use click', classification: 'policy-gated', reason: 'Blocked by computerUseAutonomyLevel.' },
          { check: 'Check 4: worker offline', classification: 'stale', reason: 'The worker is back online.' },
        ],
      });
    };
  }

  it('lands honest evidence but leaves a document with open checks under its active name', async () => {
    const doc = writeDoc('docs/plans/2026-01-01-alpha_livetest.md', '# Livetest\n\n- [ ] check 1\n');
    const parent = fake.addParent();
    fake.scripts.verifier = livetestVerdict(false);

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'livetests' });
    await waitForRun(run.id);

    expect(coordinator.getRunDto(run.id)!.items[0].state).toBe('landed');
    expect(existsSync(doc)).toBe(true);
    expect(existsSync(doc.replace('_livetest.md', '_livetest_completed.md'))).toBe(false);
    const worker = fake.created.find((i) => i.role === 'worker')!;
    expect(worker.config.initialPrompt).toContain('AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-');
    expect(worker.config.initialPrompt).toContain('livetest-campaign-runbook.md');
    // The dev app's port is one the queue checked free and recorded on the item.
    const recorded = store.getItem(coordinator.getRunDto(run.id)!.items[0].id)!.livetestPort;
    expect(recorded).toBeGreaterThanOrEqual(9500);
    expect(recorded).toBeLessThan(9900);
    expect(worker.config.initialPrompt).toContain(`--remote-debugging-port=${recorded}`);

    const summary = fake.inputs.filter((m) => m.instanceId === parent.id).at(-1)!.message;
    expect(summary).toContain('Checks that genuinely need James:');
    expect(summary).toContain('Check 2: Face ID unlock — Needs a physical iPhone.');
    expect(summary).not.toContain('Check 4');
    expect(summary).toContain('1 further check(s) are policy-gated');
  });

  it('renames a livetest whose every check passed to _livetest_completed and commits the rename', async () => {
    const doc = writeDoc('docs/plans/2026-01-01-alpha_livetest.md', '# Livetest\n');
    const parent = fake.addParent();
    fake.scripts.verifier = livetestVerdict(true);

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'livetests' });
    await waitForRun(run.id);

    expect(existsSync(doc)).toBe(false);
    expect(existsSync(doc.replace('_livetest.md', '_livetest_completed.md'))).toBe(true);
    expect(git(['log', '-1', '--format=%s', 'main'])).toBe('Livetest: 2026-01-01-alpha_livetest');
    expect(git(['show', '--name-only', '--format=', 'main']).split('\n').sort()).toEqual([
      '2026-01-01-alpha_livetest.feature.txt',
      'docs/plans/2026-01-01-alpha_livetest_closure_completed.json',
      'docs/plans/2026-01-01-alpha_livetest_completed.md',
    ]);
  });

  it('refuses to start a run whose checks would use a different Node than the project pins, before creating any work', async () => {
    writeFileSync(join(repo, '.nvmrc'), 'v1.0.0\n');
    writeDoc('docs/plans/2026-01-01-alpha_livetest.md', '# L\n');
    const parent = fake.addParent();

    await expect(coordinator.startRun({ parentInstanceId: parent.id, kind: 'livetests' })).rejects.toThrow(/This run cannot start: the project's checks would run on Node v\d+.*asks for Node v1\.0\.0/);
    expect(coordinator.listRunDtos()).toEqual([]);
  });

  it('starts a project that lacks the default scripts with no checklist, so the verifier uses its documented checks', async () => {
    writeDoc('docs/plans/2026-01-01-alpha_livetest.md', '# L\n');
    const parent = fake.addParent();
    fake.scripts.verifier = livetestVerdict(false);

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'livetests' });
    expect(run.config).toMatchObject({ verifierGates: [], postMergeGate: [] });
    // A caller who names its own gates still gets them.
    const named = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'livetests', config: { verifierGates: ['make check'] } });
    expect(named.run.config.verifierGates).toEqual(['make check']);
  });

  it('uses the livetest defaults: one worker at a time and the light verifier gate list', async () => {
    // This temporary repository stands in for this repository: its first commit is the one that earns the built-in checklists.
    PlanQueueCoordinator._resetForTesting();
    setCoordinator(startCoordinator(fake, null, { thisRepositoryRootCommit: git(['rev-list', '--max-parents=0', 'HEAD']) }));
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { lint: 'true', typecheck: 'true', 'typecheck:spec': 'true' } }));
    writeFileSync(join(repo, 'tsconfig.json'), '{}');
    git(['add', 'package.json', 'tsconfig.json']);
    git(['commit', '-qm', 'project scripts']);
    writeDoc('docs/plans/2026-01-01-alpha_livetest.md', '# L\n');
    writeDoc('docs/plans/2026-01-02-beta_livetest.md', '# L\n');
    const parent = fake.addParent();
    fake.scripts.verifier = livetestVerdict(false);

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'livetests' });
    expect(run.config).toMatchObject({ workerSlots: 1, verificationSlots: 1, verifierGates: ['npx tsc --noEmit', 'npm run lint'] });
    await waitForRun(run.id);
    expect(fake.maxLive.worker).toBe(1);
  });

  it('gives a different project no checklist, even one that copies this repository\'s package name, scripts and tsconfig', async () => {
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'harness', scripts: { lint: 'true', typecheck: 'true', 'typecheck:spec': 'true' } }));
    writeFileSync(join(repo, 'tsconfig.json'), '{}');
    git(['add', 'package.json', 'tsconfig.json']);
    git(['commit', '-qm', 'project scripts']);
    writeDoc('docs/plans/2026-01-01-alpha_livetest.md', '# L\n');
    const parent = fake.addParent();
    fake.scripts.verifier = livetestVerdict(false);

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'livetests' });
    expect(run.config).toMatchObject({ verifierGates: [], postMergeGate: [] });
  });
});


describe('PlanQueueCoordinator worker completion report', { timeout: 30_000 }, () => {
  const REPORT_ARGS = { summary: 'Built it.', as_built: 'Edited the feature file.', checks_run: [{ command: 'npm run lint', exitCode: 0 }], deferred_checks: [], follow_ups: [] };
  const report = (instance: FakeInstance, summary = REPORT_ARGS.summary) =>
    recordWorkerReport(coordinator, instance.id, { item_id: itemIdOf(instance), ...REPORT_ARGS, summary });
  const worker = () => fake.created.filter((i) => i.role === 'worker').at(-1)!;
  const workerInputs = () => fake.inputs.filter((m) => m.instanceId === worker().id).map((m) => m.message);
  const reportOf = (itemId: string) => store.getItem(itemId)!.workerReport ?? null;

  /** A fresh coordinator whose workers on `claude` (the fake's default provider) must report. */
  function requireReports(providers: string[] = ['claude']): void {
    PlanQueueCoordinator._resetForTesting();
    _setReportRequiredProvidersForTesting(new Set(providers));
    setFake(new FakeInstances());
    fake.scripts.triage = triageAllReady;
    fake.scripts.worker = implement;
    fake.scripts.verifier = pass;
    setCoordinator(startCoordinator(fake));
  }

  it('accepts a report only from the item\'s current worker, while it works', async () => {
    requireReports();
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    const refused: string[] = [];
    let seenOnRow: unknown = null;
    fake.scripts.worker = (instance, message, f) => {
      implement(instance, message, f);
      for (const caller of [parent.id, 'someone-else']) {
        try { recordWorkerReport(coordinator, caller, { item_id: itemIdOf(instance), ...REPORT_ARGS }); } catch (error) { refused.push((error as Error).message); }
      }
      expect(reportOf(itemIdOf(instance))).toBeNull();
      report(instance);
    };
    fake.scripts.verifier = (instance, message, f) => {
      // The report is on the item row while the checker works, and neither checker nor worker can add another then.
      seenOnRow = coordinator.getRunDto(store.getItem(itemIdOf(instance))!.runId)!.items[0].workerReport;
      expect(() => report(worker())).toThrow(/Only the worker currently assigned/);
      expect(() => recordWorkerReport(coordinator, instance.id, { item_id: itemIdOf(instance), ...REPORT_ARGS })).toThrow(/Only the worker currently assigned/);
      pass(instance, message, f);
    };
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);
    expect(refused).toHaveLength(2);
    expect(refused.every((message) => /Only the worker currently assigned/.test(message))).toBe(true);
    expect(seenOnRow).toEqual({ summary: 'Built it.', asBuilt: 'Edited the feature file.', checksRun: [{ command: 'npm run lint', exitCode: 0 }], deferredChecks: [], followUps: [] });
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'landed', erroredRounds: 0 });
    // The worker reported, so it was never reminded.
    expect(workerInputs().filter((message) => message.startsWith('Plan Queue reminder'))).toEqual([]);
  });

  it('reminds a worker whose turn ends without a report, then counts the turn as failed', async () => {
    requireReports();
    planDoc('2026-01-01-alpha');
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await waitForRun(run.id);
    expect(workerInputs().map((message) => message.split(':')[0])).toEqual(['Plan Queue reminder 1 of 2', 'Plan Queue reminder 2 of 2']);
    expect(workerInputs()[0]).toContain('orchestrator.tool_search');
    expect(workerInputs()[0]).toContain('plan_queue_report_ready');
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'parked', parkReason: 'worker-error' });
    expect(coordinator.getRunDto(run.id)!.items[0].detail).toContain('without reporting its work ready, after 2 reminders');
    expect(fake.created.some((i) => i.role === 'verifier')).toBe(false);
  });

  it('hands the work over once a reminder is answered with a report, from the same session', async () => {
    requireReports();
    planDoc('2026-01-01-alpha');
    fake.scripts.worker = (instance, message, f) => {
      implement(instance, message, f);
      if (message.startsWith('Plan Queue reminder 1 of 2')) report(instance);
    };
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await waitForRun(run.id);
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'landed' });
    expect(fake.created.filter((i) => i.role === 'worker')).toHaveLength(1);
    expect(workerInputs()).toHaveLength(1);
  });

  it('reminds, and does not check, a worker whose background job was still running when its turn ended', async () => {
    requireReports();
    planDoc('2026-01-01-alpha');
    const observed: { state: string; verifiers: number; reminder: string }[] = [];
    fake.scripts.worker = (instance, message, f) => {
      implement(instance, message, f);
      if (!message.startsWith('Plan Queue reminder')) { f.say(instance, 'The tests are still running in the background; I will check them next.'); return; }
      observed.push({ state: coordinator.getRunDto(store.getItem(itemIdOf(instance))!.runId)!.items[0].state, verifiers: f.created.filter((i) => i.role === 'verifier').length, reminder: message });
      report(instance);
    };
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await waitForRun(run.id);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ state: 'working', verifiers: 0 });
    expect(observed[0].reminder).toContain('A command you start in the background');
    expect(observed[0].reminder).toContain('Background commands may have stopped when your turn ended');
    expect(coordinator.getRunDto(run.id)!.items[0].state).toBe('landed');
  });

  it('clears the report when a worker turn starts, so a fix round never reuses the last one', async () => {
    requireReports();
    planDoc('2026-01-01-alpha');
    let verifications = 0;
    const atFixStart: unknown[] = [];
    fake.scripts.worker = (instance, message, f) => {
      implement(instance, message, f);
      if (message.includes('An independent verifier failed your work')) atFixStart.push(reportOf(itemIdOf(instance)));
      // The fix round never reports, so only a reused old report could satisfy the requirement.
      if (!message.includes('An independent verifier failed your work') && !message.startsWith('Plan Queue reminder')) report(instance, 'Round one.');
    };
    fake.scripts.verifier = (instance) => {
      verifications += 1;
      coordinator.reportVerdict(instance.id, { item_id: itemIdOf(instance), verdict: 'FAIL', findings: [{ severity: 'high', confidence: 85, summary: 'Missing retry test.' }], gates_run: [], document_complete: true, need_james: [], not_checked: [] });
    };
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await waitForRun(run.id);
    expect(verifications).toBe(1);
    expect(atFixStart).toEqual([null]);
    expect(workerInputs().filter((message) => message.startsWith('Plan Queue reminder')).map((message) => message.split(':')[0])).toEqual(['Plan Queue reminder 1 of 2', 'Plan Queue reminder 2 of 2']);
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'parked', parkReason: 'worker-error' });
  });

  it('gives the fix round its own full set of reminders', async () => {
    requireReports();
    planDoc('2026-01-01-alpha');
    let verifications = 0;
    fake.scripts.worker = (instance, message, f) => {
      implement(instance, message, f);
      const fix = message.includes('An independent verifier failed your work');
      // First turn: report after the second reminder. Fix turn: report only after its own first reminder.
      if (message.startsWith('Plan Queue reminder 2 of 2') || (fix === false && message.startsWith('Plan Queue reminder 1 of 2') && verifications > 0)) report(instance, 'Fix round.');
    };
    fake.scripts.verifier = (instance, message, f) => {
      verifications += 1;
      if (verifications === 1) coordinator.reportVerdict(instance.id, { item_id: itemIdOf(instance), verdict: 'FAIL', findings: [{ severity: 'high', confidence: 85, summary: 'Missing retry test.' }], gates_run: [], document_complete: true, need_james: [], not_checked: [] });
      else pass(instance, message, f);
    };
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await waitForRun(run.id);
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'landed' });
    expect(workerInputs().filter((message) => message.startsWith('Plan Queue reminder 1 of 2'))).toHaveLength(2);
  });

  it('keeps the turn ending as the signal for a provider that has not passed its live check', async () => {
    requireReports(['codex']);
    planDoc('2026-01-01-alpha');
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await waitForRun(run.id);
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'landed' });
    expect(workerInputs()).toEqual([]);
  });

  it('keeps every provider on the turn-ending signal until one is added to the list in code', async () => {
    planDoc('2026-01-01-alpha');
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await waitForRun(run.id);
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'landed' });
  });

  it('crash window: a report stored before a restart is cleared for the worker that resumes, which must report again', async () => {
    requireReports();
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.worker = (instance, message, f) => { implement(instance, message, f); report(instance, 'Before the crash.'); return never(instance, message, f); };
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await vi.waitFor(() => expect(reportOf(run.items[0].id)?.summary).toBe('Before the crash.'), { timeout: 15_000, interval: 25 });
    const seenAtResume: unknown[] = [];
    await restart(null, { scripts: { worker: (instance, message, f) => {
      implement(instance, message, f);
      seenAtResume.push(reportOf(itemIdOf(instance)));
      report(instance, 'After the crash.');
    } } });
    await waitForRun(run.id);
    expect(seenAtResume).toEqual([null]);
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'landed' });
    expect(reportOf(run.items[0].id)?.summary).toBe('After the crash.');
  });

  it('clears a stored report when a resumed item gets a new worker session', async () => {
    requireReports();
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);
    const itemId = run.items[0].id;
    expect(coordinator.getRunDto(run.id)!.items[0].state).toBe('parked');
    store.upsertItem({ ...store.getItem(itemId)!, workerReport: { summary: 'Old.', asBuilt: 'Old.', checksRun: [], deferredChecks: [], followUps: [] } });
    const seen: unknown[] = [];
    fake.scripts.worker = (instance, message, f) => { implement(instance, message, f); seen.push(reportOf(itemIdOf(instance))); report(instance); };
    await coordinator.control({ action: 'resume-item', itemId }, parent.id);
    await waitForRun(run.id);
    expect(seen).toEqual([null]);
  });
});

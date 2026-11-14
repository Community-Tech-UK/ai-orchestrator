import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG, PlanQueueControlArgsSchema, PlanQueueControlPayloadSchema, type PlanQueueQuestion } from '@contracts/schemas/plan-queue';
import { coordinator, fake, never, repo, restart, store, writeDoc } from './plan-queue-coordinator.test-helpers';
import { newPlanQueueItem } from './plan-queue-state';
import { rememberedOutcomeForPath, rememberJamesAnswer, rememberTriageRecord } from './plan-queue-triage-memory';
import { createPlanQueueToolOperations } from './plan-queue-tool-operations';
import { PLAN_QUEUE_TOOL_SPECS } from '../mcp/plan-queue-tools';
import { runPlanQueueCli } from '../mcp/plan-queue-cli';

const question: PlanQueueQuestion = {
  question: 'Can you start a disposable session for this check?',
  options: [{ id: 'started', label: 'I started it' }, { id: 'skip', label: 'Leave it pending' }],
  decision: { kind: 'human-input', reason: 'The old runtime could not create a session.' },
};

function waiting(kind: 'plans' | 'livetests' = 'livetests', status: 'paused' | 'running' = 'paused') {
  const parent = fake.addParent();
  const document = writeDoc(`docs/plans/check_${kind === 'plans' ? 'plan' : 'livetest'}.md`, '# Check\n- [ ] Create a disposable session.\n');
  store.upsertRun({ id: 'run', parentInstanceId: parent.id, parentHistoryThreadId: null, kind,
    workspaceCwd: repo, status, config: DEFAULT_PLAN_QUEUE_CONFIG[kind], relaxation: null,
    workerProvider: 'claude', workerModel: null, startedAt: 1, endedAt: null });
  const item = newPlanQueueItem('item', 'run', document, 1, { state: 'needs-answer', question });
  store.upsertItem(item);
  rememberTriageRecord(store.history, document, repo, { disposition: 'needs-answer', question }, 1);
  fake.scripts.triage = never;
  return { parent, item };
}

const recheck = (caller?: string) => coordinator.control({ action: 'recheck-readiness', itemId: 'item' }, caller);

describe('readiness investigation without answering', () => {
  it('accepts the item control through both schemas and the authenticated tool mapping', async () => {
    const { parent } = waiting();
    const args = PlanQueueControlArgsSchema.parse({ action: 'recheck-readiness', item_id: 'item' });
    expect(PlanQueueControlPayloadSchema.parse({ action: 'recheck-readiness', itemId: 'item' })).toEqual({ action: 'recheck-readiness', itemId: 'item' });
    expect(PLAN_QUEUE_TOOL_SPECS.plan_queue_control.inputSchema.properties.action.enum).toContain('recheck-readiness');
    await createPlanQueueToolOperations(() => coordinator).control(parent.id, args);
    expect(store.getItem('item')).toMatchObject({ state: 'discovered', question: null, answer: null, branchName: null });
    expect(store.getRun('run')?.status).toBe('paused');
    expect(fake.created.filter(instance => instance.role !== 'parent')).toEqual([]);
  });

  it('starts fresh triage on a running run, rather than a worker or automatic answer', async () => {
    const { parent } = waiting('livetests', 'running');
    await recheck(parent.id);
    await vi.waitFor(() => expect(fake.created.filter(instance => instance.role === 'triage')).toHaveLength(1));
    expect(fake.created.some(instance => instance.role === 'worker')).toBe(false);
    expect(store.getItem('item')).toMatchObject({ state: 'discovered', question: null, answer: null });
  });

  it('preserves the recheck across restart while the run remains paused', async () => {
    const { parent } = waiting();
    await recheck(parent.id);
    await restart();
    expect(store.getRun('run')?.status).toBe('paused');
    expect(store.getItem('item')).toMatchObject({ state: 'discovered', question: null, answer: null });
    expect(fake.created.some(instance => instance.role !== 'parent')).toBe(false);
  });

  it.each(['other', 'queue-worker'])('refuses the %s caller', async caller => {
    waiting();
    if (caller === 'queue-worker') coordinator.registerRole(caller, { role: 'worker', runId: 'run', itemId: 'other' });
    await expect(recheck(caller)).rejects.toThrow(/Only the session/);
    expect(store.getItem('item')).toMatchObject({ state: 'needs-answer', question });
  });

  it.each(['cancelled', 'completed'] as const)('does not reopen a %s run', async status => {
    const { parent } = waiting();
    store.upsertRun({ ...coordinator.getRun('run'), status });
    await expect(recheck(parent.id)).rejects.toThrow(/running or paused/);
    expect(store.getItem('item')?.state).toBe('needs-answer');
  });

  it.each([
    { state: 'working' as const }, { state: 'landed' as const }, { branchName: 'retained' },
    { worktreePath: '/retained' }, { workerInstanceId: 'worker' }, { checkpointCommit: 'saved' },
    { answer: 'An earlier answer' }, { question: null },
  ])('refuses a question whose item has already progressed: %j', async patch => {
    const { parent, item } = waiting();
    store.upsertItem({ ...item, ...patch });
    await expect(recheck(parent.id)).rejects.toThrow(/untouched.*question/);
    expect(store.getItem('item')).toMatchObject(patch);
  });

  it('does not bypass the choice about an earlier retained branch', async () => {
    const { parent, item } = waiting();
    store.upsertItem({ ...item, question: { ...question, options: [{ id: 'resume-set-aside', label: 'Resume the retained work' }, { id: 'skip', label: 'Leave it' }] } });
    await expect(recheck(parent.id)).rejects.toThrow(/retained work/);
  });

  it('does not erase an answer being applied, even before its promise settles', async () => {
    const { parent } = waiting();
    const answering = coordinator.answer('item', 'started', parent.id);
    await expect(recheck(parent.id)).rejects.toThrow(/applying an answer/);
    await answering;
    expect(store.getItem('item')).toMatchObject({ state: 'queued', answer: expect.stringContaining('I started it') });
  });

  it('rejects a stale answer after recheck without remembering it', async () => {
    const { parent } = waiting();
    await recheck(parent.id);
    await expect(coordinator.answer('item', 'started', parent.id)).rejects.toThrow(/no open question/);
    expect(store.getItem('item')?.answer).toBeNull();
  });

  it('does not reopen an item while cancellation is being applied', async () => {
    const { parent } = waiting();
    const cancelling = coordinator.control({ action: 'cancel', runId: 'run' }, parent.id);
    await expect(recheck(parent.id)).rejects.toThrow(/applying another control/);
    await cancelling;
    expect(store.getRun('run')?.status).toBe('cancelled');
    expect(store.getItem('item')?.state).not.toBe('discovered');
  });

  it('accepts persisted questions that predate decision classification', async () => {
    const { parent, item } = waiting();
    const oldQuestion = { question: question.question, options: question.options };
    store.upsertItem({ ...item, question: oldQuestion });
    await recheck(parent.id);
    expect(store.getItem('item')).toMatchObject({ state: 'discovered', question: null, answer: null });
  });

  it('invalidates a still-running triage batch before an old report can restore the question', async () => {
    const { parent, item } = waiting('livetests', 'running');
    store.upsertItem({ ...item, state: 'discovered', question: null });
    coordinator.requestPump();
    await vi.waitFor(() => expect(fake.created.filter(instance => instance.role === 'triage')).toHaveLength(1));
    const triage = fake.created.find(instance => instance.role === 'triage')!;
    const report = { run_id: 'run', records: [{ documentPath: item.sourceRef, disposition: 'needs-answer' as const, question }] };
    coordinator.reportTriage(triage.id, report);
    await recheck(parent.id);
    await vi.waitFor(() => expect(fake.created.filter(instance => instance.role === 'triage')).toHaveLength(2));
    expect(() => coordinator.reportTriage(triage.id, report)).toThrow(/Only the triage agent/);
    expect(store.getItem('item')).toMatchObject({ state: 'discovered', question: null, answer: null });
  });
});

describe('remembered readiness', () => {
  it('investigates an unanswered live-test question again even when the document did not change', () => {
    const { item } = waiting();
    expect(rememberedOutcomeForPath(store.history, item.sourceRef, repo)).toEqual({ kind: 'none', detail: '' });
  });

  it('preserves an unanswered plan question', () => {
    const { item } = waiting('plans');
    expect(rememberedOutcomeForPath(store.history, item.sourceRef, repo)).toMatchObject({ kind: 'ask', question });
  });

  it.each(['started', 'skip'])('preserves the actual human answer %s', optionId => {
    const { item } = waiting();
    rememberJamesAnswer(store.history, item, repo, question.question, question.options.find(option => option.id === optionId)!, 2);
    expect(rememberedOutcomeForPath(store.history, item.sourceRef, repo)).toMatchObject({ kind: 'answered', optionId });
  });

  it('preserves a skip disposition', () => {
    const { item } = waiting();
    rememberTriageRecord(store.history, item.sourceRef, repo, { disposition: 'skip', reason: 'Superseded.' }, 2);
    expect(rememberedOutcomeForPath(store.history, item.sourceRef, repo)).toMatchObject({ kind: 'skip' });
  });
});

it('exposes readiness recheck through the CLI using the same authenticated control', async () => {
  const call = vi.fn(async () => ({ done: true }));
  const stdout = vi.fn();
  await runPlanQueueCli(['recheck-readiness', 'item'], { client: { call }, stdout });
  expect(call).toHaveBeenCalledExactlyOnceWith('orchestrator_tools.plan_queue_control', { action: 'recheck-readiness', item_id: 'item' });
  expect(stdout).toHaveBeenCalledWith(expect.stringContaining('no answer or permission'));
});

it.each([{ args: [] }, { args: ['item', 'extra'] }, { args: ['--unsafe'] }])('refuses malformed readiness CLI arguments $args before calling the app', async ({ args }) => {
  const call = vi.fn();
  await expect(runPlanQueueCli(['recheck-readiness', ...args], { client: { call }, stdout: vi.fn() })).rejects.toThrow(/requires one/);
  expect(call).not.toHaveBeenCalled();
});

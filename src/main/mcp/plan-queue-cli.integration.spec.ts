import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG, type PlanQueueRunDto } from '@contracts/schemas/plan-queue';
import { PlanQueueCoordinator } from '../plan-queue/plan-queue-coordinator';
import type { PlanQueueItem } from '../plan-queue/plan-queue.types';
import { createPlanQueueToolOperations } from '../plan-queue/plan-queue-tool-operations';
import { OrchestratorToolsRpcServer } from './orchestrator-tools-rpc-server';
import { runPlanQueueCli } from './plan-queue-cli';
import { createPlanQueueToolDefinitions } from './plan-queue-tools';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));
vi.mock('../core/config/settings-manager', () => ({
  // The status summary's account-rules line reads these; none are set here.
  getSettingsManager: () => ({
    getAll: () => ({ planQueueAccountRules: { never: [], last: [] }, providerAccountProfiles: [], copilotAccountProfiles: [] }),
  }),
}));

const RUN: PlanQueueRunDto = { id: 'run-1', parentInstanceId: 'owner', kind: 'plans', workspaceCwd: '/repo', status: 'paused',
  config: DEFAULT_PLAN_QUEUE_CONFIG.plans, workerProvider: 'claude', relaxedSettings: [], startedAt: 1, endedAt: null, items: [] };

function harness(queueSessions: string[] = [], setAsideSessions: string[] = []) {
  const coordinator = new PlanQueueCoordinator();
  const control = vi.spyOn(coordinator, 'control').mockResolvedValue();
  const runs = new Map<string, PlanQueueRunDto>([[RUN.id, RUN], ['run-done', { ...RUN, id: 'run-done', status: 'completed' }],
    ['run-cancelled', { ...RUN, id: 'run-cancelled', status: 'cancelled' }],
    ['run-set-aside', { ...RUN, id: 'run-set-aside', status: 'completed', items: [{ id: 'item', runId: 'run-set-aside', documentPath: 'docs/plans/a_plan.md',
      state: 'parked', round: 3, erroredRounds: 0, branchName: 'queue/a', worktreePath: null, baseCommit: null, checkpointCommit: null, landedCommit: null,
      workerInstanceId: null, verifierInstanceId: null, question: null, answer: null, parkReason: 'round-limit', detail: null, verdict: null, createdAt: 1, updatedAt: 1 }] }]]);
  vi.spyOn(coordinator, 'getRunDto').mockImplementation(id => runs.get(id) ?? null);
  const getItem = vi.spyOn(coordinator, 'getItem').mockReturnValue({ branchName: null, worktreePath: null } as PlanQueueItem);
  vi.spyOn(coordinator, 'isQueueInstance').mockImplementation(id => queueSessions.includes(id));
  vi.spyOn(coordinator, 'setAsideAgents', 'get').mockReturnValue(
    { folderOf: (id: string) => (setAsideSessions.includes(id) ? '/repo' : undefined) } as unknown as PlanQueueCoordinator['setAsideAgents']);
  const server = new OrchestratorToolsRpcServer({ userDataPath: '/tmp', operatorDbPath: '/tmp/unused-plan-queue-cli-tests.db',
    isKnownLocalInstance: id => ['caller', 'worker', 'set-aside'].includes(id), registerCleanup: () => undefined,
    planQueueTools: createPlanQueueToolOperations(() => coordinator), toolFactory: context => createPlanQueueToolDefinitions(context) });
  const cli = async (argv: string[], instanceId = 'caller') => {
    const output: string[] = [];
    await runPlanQueueCli(argv, {
      env: { AI_ORCHESTRATOR_INSTANCE_ID: instanceId },
      stdout: text => { output.push(text); },
      client: { call: (method, payload) => server.handleRequest({ jsonrpc: '2.0', id: 1, method, params: { instanceId, payload } }) },
    });
    return output.join('');
  };
  return { coordinator, control, getItem, cli };
}

describe('aio-mcp plan-queue move through the parent dispatcher', () => {
  it('lists runs from the real status tool output', async () => {
    const { coordinator, cli } = harness();
    const NOTHING = { count: 0, of: 0, share: null };
    vi.spyOn(coordinator, 'listRunDtos').mockReturnValue([RUN, { ...RUN, id: 'run-2', parentInstanceId: 'caller', status: 'running' }]);
    vi.spyOn(coordinator, 'getAlerts').mockReturnValue([]);
    vi.spyOn(coordinator, 'getQueueHealth').mockReturnValue({
      windowDays: 14, since: 0, attemptsLanded: NOTHING, documentsLanded: NOTHING, passesNotLanded: NOTHING, firstCheckPassed: NOTHING,
      freeSlotToStart: { count: 0, medianMs: null }, checkTime: { count: 0, medianMs: null },
      landingTime: { count: 0, medianMs: null, syncMs: null, mergeCheckMs: null, commitCheckMs: null, publishMs: null },
      waiting: { waitingMs: 0, workingMs: 0, share: null }, setAsideRounds: { items: 0, rounds: 0 },
    });
    const text = await cli(['list']);
    expect(text).toContain('run-1 | paused | plans | 0 document(s) | owner: session owner');
    expect(text).toContain('run-2 | running | plans | 0 document(s) | owner: this session');
    expect(text).not.toContain('caller');
  });

  it('hands the run to the calling session with James\'s authority, as the Plan Queue page does', async () => {
    const { control, cli } = harness();
    await expect(cli(['move', 'run-1'])).resolves.toBe('Moved Plan Queue run run-1 to this session.\n');
    expect(control).toHaveBeenCalledWith({ action: 'handover', runId: 'run-1', targetInstanceId: 'caller' }, undefined);
  });

  it('moves the run to another named session', async () => {
    const { control, cli } = harness();
    await cli(['move', 'run-1', '--to', 'elsewhere']);
    expect(control).toHaveBeenCalledWith({ action: 'handover', runId: 'run-1', targetInstanceId: 'elsewhere' }, undefined);
  });

  it('refuses a session the queue started, and an unknown run, before any change', async () => {
    const { control, cli } = harness(['worker']);
    await expect(cli(['move', 'run-1'], 'worker')).rejects.toThrow('Plan Queue workers, checkers, triage and Set aside agents cannot move a run.');
    await expect(cli(['move', 'missing'])).rejects.toThrow('Plan queue run not found: missing');
    expect(control).not.toHaveBeenCalled();
  });

  it('refuses a Set aside agent as the mover before any change (the handover refuses one as the new owner)', async () => {
    const { control, cli } = harness([], ['set-aside']);
    await expect(cli(['move', 'run-1'], 'set-aside')).rejects.toThrow('Plan Queue workers, checkers, triage and Set aside agents cannot move a run.');
    expect(control).not.toHaveBeenCalled();
  });

  it('refuses a finished or cancelled run with nothing set aside, but moves one that still holds set-aside work', async () => {
    const { control, cli } = harness();
    await expect(cli(['move', 'run-done'])).rejects.toThrow('has finished and holds no set-aside work; there is nothing to move');
    await expect(cli(['move', 'run-cancelled'])).rejects.toThrow('has finished and holds no set-aside work; there is nothing to move');
    expect(control).not.toHaveBeenCalled();
    await cli(['move', 'run-set-aside']);
    expect(control).toHaveBeenCalledWith({ action: 'handover', runId: 'run-set-aside', targetInstanceId: 'caller' }, undefined);
  });

  it('refuses a caller Harness does not know', async () => {
    const { control, cli } = harness();
    await expect(cli(['move', 'run-1'], 'stranger')).rejects.toThrow('unknown orchestrator-tools instance');
    expect(control).not.toHaveBeenCalled();
  });

  it('discards a job through the control path as the calling session, not as James', async () => {
    const { control, cli } = harness();
    await expect(cli(['discard', 'item'])).resolves.toBe('Discarded job item.\n');
    expect(control).toHaveBeenCalledWith({ action: 'discard-item', itemId: 'item' }, 'caller');
  });

  it('gets through a folder\'s worth of jobs without hitting the call limit', async () => {
    const { control, cli } = harness();
    const ids = Array.from({ length: 160 }, (_, index) => `job-${index}`);
    const text = await cli(['discard', ...ids, '--json']);
    expect(JSON.parse(text)).toMatchObject({ failed: [] });
    expect(control).toHaveBeenCalledTimes(160);
  });

  it('reports a job the coordinator refuses and still discards the rest', async () => {
    const { control, cli } = harness();
    control.mockRejectedValueOnce(new Error('Only a parked item can be discarded'));
    await expect(cli(['discard', 'stuck', 'fine'])).rejects.toThrow('1 of 2 job(s) failed or timed out.');
    expect(control).toHaveBeenCalledTimes(2);
  });

  it('reports what git would not release', async () => {
    const { getItem, cli } = harness();
    getItem.mockReturnValue({ branchName: 'queue/a', worktreePath: null } as PlanQueueItem);
    await expect(cli(['discard', 'item'])).resolves.toBe('Discarded job item.\nLeft in place for job item: queue/a\n');
  });

  it('passes the coordinator\'s refusal back to the agent unchanged', async () => {
    const { control, cli } = harness();
    control.mockRejectedValue(new Error('Pause this run, or wait until none of its documents is being worked on or checked, before handing it over'));
    await expect(cli(['move', 'run-1'])).rejects.toThrow('Pause this run');
  });
});

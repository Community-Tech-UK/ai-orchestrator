import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));
vi.mock('../operator/operator-database', () => ({ defaultOperatorDbPath: () => '/tmp/never-opened.db' }));
import { OrchestratorToolsRpcServer } from './orchestrator-tools-rpc-server';
import {
  createPlanQueueToolDefinitions,
  isPlanQueueRpcMethod,
  PLAN_QUEUE_TOOL_NAMES,
  type PlanQueueToolOperations,
} from './plan-queue-tools';

const PARENT = 'parent-session';
const WORKER = 'queue-worker';

function fakeOps(): PlanQueueToolOperations & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const record = (name: string) => (...args: unknown[]) => {
    calls.push([name, ...args]);
    return { ok: name };
  };
  return {
    calls,
    start: vi.fn(async (...args: unknown[]) => record('start')(...args)),
    status: record('status'),
    answer: vi.fn(async (...args: unknown[]) => record('answer')(...args)),
    control: vi.fn(async (...args: unknown[]) => record('control')(...args)),
    reportVerdict: record('reportVerdict'),
    reportTriage: record('reportTriage'),
    reportReady: record('reportReady'),
    setAside: vi.fn(async (...args: unknown[]) => record('setAside')(...args)),
    clearSetAside: vi.fn(async (...args: unknown[]) => record('clearSetAside')(...args)),
    discardItems: vi.fn(async () => ({ discarded: [], leftInPlace: [], failed: [] })),
    moveRun: vi.fn(async (_caller: string, _runId: string, targetInstanceId: string) => ({ ownerInstanceId: targetInstanceId })),
    isQueueInstance: (id) => id === WORKER,
  };
}

function server(ops: PlanQueueToolOperations): OrchestratorToolsRpcServer {
  return new OrchestratorToolsRpcServer({
    userDataPath: fs.mkdtempSync(path.join(os.tmpdir(), 'pq-rpc-test-')),
    isKnownLocalInstance: (id) => id === PARENT || id === WORKER,
    planQueueTools: ops,
    toolFactory: (deps) => createPlanQueueToolDefinitions(deps),
    registerCleanup: () => undefined,
  });
}

const call = (s: OrchestratorToolsRpcServer, instanceId: string, tool: string, payload: Record<string, unknown>) =>
  s.handleRequest({ jsonrpc: '2.0', id: 1, method: `orchestrator_tools.${tool}`, params: { instanceId, payload } });

describe('plan queue MCP tools', () => {
  it('passes the Set aside tools to the coordinator and hides them from queue sessions', async () => {
    const ops = fakeOps();
    const tools = createPlanQueueToolDefinitions({ instanceId: PARENT, planQueueTools: ops });
    await tools.find((tool) => tool.name === 'plan_queue_set_aside')!.handler({ offset: 40 });
    await tools.find((tool) => tool.name === 'plan_queue_set_aside')!.handler({});
    await tools.find((tool) => tool.name === 'plan_queue_set_aside_clear')!.handler({});
    expect(ops.calls).toEqual([['setAside', PARENT, 40], ['setAside', PARENT, 0], ['clearSetAside', PARENT]]);
    const queueTools = createPlanQueueToolDefinitions({ instanceId: WORKER, planQueueTools: ops }).map((tool) => tool.name);
    expect(queueTools).not.toContain('plan_queue_set_aside');
    expect(queueTools).not.toContain('plan_queue_set_aside_clear');
  });

  it('advertises batch limits and forwards a validated batch size from the authenticated caller', async () => {
    const ops = fakeOps();
    const start = createPlanQueueToolDefinitions({ instanceId: PARENT, planQueueTools: ops }).find(tool => tool.name === 'plan_queue_start')!;
    const properties = start.inputSchema['properties'] as Record<string, unknown>;
    expect(properties['check_batch_size']).toMatchObject({ type: 'integer', minimum: 1, maximum: 8 });
    const rpc = server(ops);
    await call(rpc, PARENT, 'plan_queue_start', { kind: 'plans', check_batch_size: 3 });
    expect(ops.calls).toEqual([['start', PARENT, { kind: 'plans', check_batch_size: 3 }]]);
    await expect(call(rpc, PARENT, 'plan_queue_start', { kind: 'plans', check_batch_size: 9 })).rejects.toThrow();
    expect(ops.start).toHaveBeenCalledTimes(1);
  });

  it('returns a small unchanged status only while the current scoped result matches', async () => {
    const ops = fakeOps();
    let state = 'working';
    ops.status = (_caller, runId) => ({ runId: runId ?? 'all', state });
    const s = server(ops);
    const first = await call(s, PARENT, 'plan_queue_status', { run_id: 'r1' }) as { version: string };
    expect(first).toMatchObject({ version: expect.any(String), state: 'working' });
    expect(await call(s, PARENT, 'plan_queue_status', { run_id: 'r1', sinceVersion: first.version }))
      .toEqual({ unchanged: true, version: first.version });
    expect(await call(s, PARENT, 'plan_queue_status', { run_id: 'r2', sinceVersion: first.version }))
      .toMatchObject({ runId: 'r2', state: 'working' });
    state = 'verifying';
    const changed = await call(s, PARENT, 'plan_queue_status', { run_id: 'r1', sinceVersion: first.version }) as { version: string };
    expect(changed).toMatchObject({ state: 'verifying' });
    expect(changed.version).not.toBe(first.version);
    await expect(call(s, PARENT, 'plan_queue_status', { sinceVersion: 12 })).rejects.toThrow();
    const schema = createPlanQueueToolDefinitions({ instanceId: PARENT, planQueueTools: ops })
      .find(tool => tool.name === 'plan_queue_status')!.inputSchema;
    expect(JSON.stringify(schema)).toContain('sinceVersion');
  });
  it('advertises and accepts authenticated adoption of a stranded run', async () => {
    const ops = fakeOps();
    const tool = createPlanQueueToolDefinitions({ instanceId: PARENT, planQueueTools: ops }).find((tool) => tool.name === 'plan_queue_control')!;
    expect(tool.description).toContain('Adopt when the work should continue; cancel only when James asked.');
    expect(JSON.stringify(tool.inputSchema)).toContain('adopt');
    await call(server(ops), PARENT, 'plan_queue_control', { action: 'adopt', run_id: 'run-1' });
    expect(ops.calls).toEqual([['control', PARENT, { action: 'adopt', run_id: 'run-1' }]]);
  });
  it('accepts retry-landing as an authenticated item control action', async () => {
    const ops = fakeOps();
    await call(server(ops), PARENT, 'plan_queue_control', { action: 'retry-landing', item_id: 'item-1' });
    expect(ops.calls).toEqual([['control', PARENT, { action: 'retry-landing', item_id: 'item-1' }]]);
  });
  it('recognises exactly its own RPC methods', () => {
    expect(PLAN_QUEUE_TOOL_NAMES.every((name) => isPlanQueueRpcMethod(`orchestrator_tools.${name}`))).toBe(true);
    expect(isPlanQueueRpcMethod('orchestrator_tools.request_doc_review')).toBe(false);
    expect(isPlanQueueRpcMethod('plan_queue_start')).toBe(false);
  });

  it('hides plan_queue_start from queue-spawned instances and keeps the role tools', () => {
    const ops = fakeOps();
    const forWorker = createPlanQueueToolDefinitions({ instanceId: WORKER, planQueueTools: ops }).map((t) => t.name);
    expect(forWorker).not.toContain('plan_queue_start');
    expect(forWorker).toContain('plan_queue_report_verdict');
    expect(forWorker).toContain('plan_queue_report_ready');
    expect(createPlanQueueToolDefinitions({ instanceId: PARENT, planQueueTools: ops }).map((t) => t.name)).toEqual(PLAN_QUEUE_TOOL_NAMES);
    expect(createPlanQueueToolDefinitions({ instanceId: PARENT, planQueueTools: null })).toEqual([]);
  });

  it('passes the RPC-authenticated caller, never an argument, as the caller identity', async () => {
    const ops = fakeOps();
    const s = server(ops);
    await call(s, WORKER, 'plan_queue_report_verdict', { item_id: 'item-1', verdict: 'PASS', instanceId: PARENT, not_checked: [] });
    expect(ops.calls[0]).toEqual(['reportVerdict', WORKER, {
      item_id: 'item-1', verdict: 'PASS', findings: [], gates_run: [], document_complete: true, need_james: [], not_checked: [],
    }]);
  });

  it('passes a worker\'s report to the coordinator under the authenticated caller, and rejects an incomplete one', async () => {
    const ops = fakeOps();
    const s = server(ops);
    const report = { item_id: 'item-1', summary: 'Done.', as_built: 'Built it.', checks_run: [{ command: 'npm run lint', exitCode: 0 }], deferred_checks: [], follow_ups: [] };
    await call(s, WORKER, 'plan_queue_report_ready', { ...report, instanceId: PARENT });
    expect(ops.calls).toEqual([['reportReady', WORKER, report]]);
    await expect(call(s, WORKER, 'plan_queue_report_ready', { ...report, as_built: undefined })).rejects.toThrow();
    await expect(call(s, WORKER, 'plan_queue_report_ready', { ...report, summary: '  ' })).rejects.toThrow();
    expect(ops.calls).toHaveLength(1);
    const tool = createPlanQueueToolDefinitions({ instanceId: WORKER, planQueueTools: ops }).find((t) => t.name === 'plan_queue_report_ready')!;
    expect(tool.inputSchema['required']).toEqual(['item_id', 'summary', 'as_built', 'checks_run', 'deferred_checks', 'follow_ups']);
  });

  it('advertises finding kinds and deferred checks, and passes them to the coordinator', async () => {
    const ops = fakeOps();
    const s = server(ops);
    const tool = createPlanQueueToolDefinitions({ instanceId: WORKER, planQueueTools: ops }).find((t) => t.name === 'plan_queue_report_verdict')!;
    const properties = tool.inputSchema['properties'] as Record<string, { items?: { properties?: Record<string, { enum?: string[] }> } }>;
    expect(properties['findings'].items!.properties!['kind'].enum).toEqual(['code', 'environment', 'needs-human']);
    expect(properties['findings'].items!.properties).toHaveProperty('missing');
    expect(properties).toHaveProperty('deferred_checks');
    expect(properties).toHaveProperty('criteria_total');
    await call(s, WORKER, 'plan_queue_report_verdict', {
      item_id: 'item-1', verdict: 'PASS', not_checked: [], criteria_total: 4,
      findings: [{ severity: 'low', confidence: 80, summary: 'No Node 22 here.', kind: 'environment', missing: 'Node 22 on the PATH' }],
      deferred_checks: [{ title: 'Each provider calls the tool', whyDeferred: 'Needs a rebuilt app.' }],
    });
    expect(ops.calls[0][2]).toMatchObject({ criteria_total: 4, deferred_checks: [{ title: 'Each provider calls the tool' }], findings: [{ kind: 'environment', missing: 'Node 22 on the PATH' }] });
    await expect(call(s, WORKER, 'plan_queue_report_verdict', { item_id: 'item-1', verdict: 'PASS', not_checked: [], findings: [{ severity: 'low', confidence: 80, summary: 'x', kind: 'maybe' }] })).rejects.toThrow();
  });

  it('refuses plan_queue_start from a queue-spawned instance at dispatch', async () => {
    const ops = fakeOps();
    await expect(call(server(ops), WORKER, 'plan_queue_start', { kind: 'plans' })).rejects.toThrow(/plan_queue_start tool unavailable/);
    expect(ops.start).not.toHaveBeenCalled();
  });

  it('validates arguments before reaching the coordinator', async () => {
    const ops = fakeOps();
    const s = server(ops);
    await expect(call(s, PARENT, 'plan_queue_start', { kind: 'everything' })).rejects.toThrow();
    await expect(call(s, PARENT, 'plan_queue_answer', { item_id: 'x' })).rejects.toThrow();
    await expect(call(s, WORKER, 'plan_queue_report_verdict', { item_id: 'x', verdict: 'MAYBE' })).rejects.toThrow();
    expect(ops.calls).toEqual([]);
    await call(s, PARENT, 'plan_queue_start', { kind: 'livetests', glob: 'docs/plans/*', relax_settings: true });
    expect(ops.calls[0]).toEqual(['start', PARENT, { kind: 'livetests', glob: 'docs/plans/*', relax_settings: true }]);
  });

  it('advertises decision metadata and forwards validated technical evidence to the coordinator', async () => {
    const ops = fakeOps();
    const definitions = createPlanQueueToolDefinitions({ instanceId: WORKER, planQueueTools: ops });
    const triage = definitions.find((tool) => tool.name === 'plan_queue_report_triage')!;
    const decision = { kind: 'technical', recommendedOptionId: 'quiet', reason: 'Use project conventions.', evidence: 'AGENTS.md specifies the quiet runner.' };
    await triage.handler({
      run_id: 'run-1', records: [{ documentPath: '/repo/a_plan.md', disposition: 'needs-answer', question: {
        question: 'Which runner?', options: [{ id: 'quiet', label: 'Use the quiet runner' }, { id: 'skip', label: 'Leave it alone' }], decision,
      } }],
    });
    expect(ops.calls[0]).toMatchObject(['reportTriage', WORKER, { records: [{ question: { decision } }] }]);
    expect(JSON.stringify(triage.inputSchema)).toContain('recommendedOptionId');
    expect(JSON.stringify(triage.inputSchema)).toContain('human-authority');
    expect(JSON.stringify(triage.inputSchema)).toContain('human-input');
    expect(definitions.find((tool) => tool.name === 'plan_queue_answer')!.description).not.toContain('Ask James first');
  });

  it('rejects invalid automatic recommendations before invoking triage operations', async () => {
    const ops = fakeOps();
    const triage = createPlanQueueToolDefinitions({ instanceId: WORKER, planQueueTools: ops }).find((tool) => tool.name === 'plan_queue_report_triage')!;
    await expect(triage.handler({ run_id: 'run-1', records: [{ documentPath: '/repo/a_plan.md', disposition: 'needs-answer', question: {
      question: 'Which runner?', options: [{ id: 'quiet', label: 'Use quiet' }, { id: 'skip', label: 'Leave it alone' }],
      decision: { kind: 'technical', recommendedOptionId: 'skip', reason: 'Routine choice.', evidence: 'Some evidence.' },
    } }] })).rejects.toThrow();
    expect(ops.calls).toEqual([]);
  });
});


it('advertises routing edits, validates them, and keeps bulk controls off MCP', async () => {
  const ops = fakeOps();
  const tool = createPlanQueueToolDefinitions({ instanceId: PARENT, planQueueTools: ops }).find((tool) => tool.name === 'plan_queue_control')!;
  expect(JSON.stringify(tool.inputSchema)).toContain('set-routing');
  expect(JSON.stringify(tool.inputSchema)).toContain('move_in_progress');
  await tool.handler({ action: 'set-routing', run_id: 'run', routing: { workers: [{ provider: 'claude', account_ids: ['account'] }], verifiers: [] }, move_in_progress: false });
  expect(ops.calls[0]).toMatchObject(['control', PARENT, { action: 'set-routing', move_in_progress: false }]);
  await expect(tool.handler({ action: 'pause-all' })).rejects.toThrow();
  await expect(tool.handler({ action: 'set-routing', run_id: 'run', routing: { workers: [{ provider: 'claude', accountIds: ['typo'] }], verifiers: [] } })).rejects.toThrow();
  expect(ops.calls).toHaveLength(1);
});

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
    expect(createPlanQueueToolDefinitions({ instanceId: PARENT, planQueueTools: ops }).map((t) => t.name)).toEqual(PLAN_QUEUE_TOOL_NAMES);
    expect(createPlanQueueToolDefinitions({ instanceId: PARENT, planQueueTools: null })).toEqual([]);
  });

  it('passes the RPC-authenticated caller, never an argument, as the caller identity', async () => {
    const ops = fakeOps();
    const s = server(ops);
    await call(s, WORKER, 'plan_queue_report_verdict', { item_id: 'item-1', verdict: 'PASS', instanceId: PARENT });
    expect(ops.calls[0]).toEqual(['reportVerdict', WORKER, {
      item_id: 'item-1', verdict: 'PASS', findings: [], gates_run: [], document_complete: true, need_james: [],
    }]);
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
});

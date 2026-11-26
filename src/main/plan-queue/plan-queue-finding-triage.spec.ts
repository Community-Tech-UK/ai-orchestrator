import { describe, expect, it, vi } from 'vitest';
import type { PlanQueueFinding } from '@contracts/schemas/plan-queue';
import { splitFindings } from './plan-queue-finding-triage';
import { buildFixPrompt } from './plan-queue-prompts';
import { PlanQueueItemFlow } from './plan-queue-item-flow';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';
import type { PlanQueueFlowHost } from './plan-queue-host';
import { PlanQueueVerification } from './plan-queue-verification';

// Gate receipts and document fingerprints have their own spec; triage only needs the reported verdict to stand.
vi.mock('./plan-queue-planning-files', async original => ({
  ...await original<typeof import('./plan-queue-planning-files')>(), describePlanningMoves: vi.fn(async () => null),
}));

const low: PlanQueueFinding = { severity: 'low', confidence: 90, summary: 'Optional naming suggestion' };
const high: PlanQueueFinding = { severity: 'high', confidence: 95, summary: 'Broken acceptance criterion' };
function harness(maxRounds = 3) {
  let item = { id: 'item', runId: 'run', state: 'verifying', round: 0, erroredRounds: 0, verifierInstanceId: 'verifier', workerInstanceId: 'worker', worktreePath: null, branchName: null } as PlanQueueItem;
  const sendInput = vi.fn().mockResolvedValue(undefined);
  const host = {
    getItem: () => item, getRun: () => ({ config: { maxRounds } } as PlanQueueRun),
    save: (next: PlanQueueItem) => { item = next; return next; },
    transition: (current: PlanQueueItem, state: PlanQueueItem['state'], patch: Partial<PlanQueueItem> = {}) => { item = { ...current, ...patch, state }; return item; },
    roleOf: () => ({ role: 'verifier', itemId: 'item', runId: 'run' }), unregisterRole: vi.fn(), registerRole: vi.fn(), requestPump: vi.fn(),
    instances: { terminateInstance: vi.fn().mockResolvedValue(undefined), getInstance: (id: string) => id === 'worker' ? { id, status: 'idle' } : undefined, sendInput },
    tracker: { untrack: vi.fn(), beginTurn: vi.fn() },
    history: { listVerdicts: () => [], recordEvent: vi.fn() },
  } as unknown as PlanQueueFlowHost;
  vi.spyOn(PlanQueueVerification.prototype, 'record').mockImplementation(async (_item, reported) => reported);
  const flow = new PlanQueueItemFlow(host); vi.spyOn(flow, 'enqueueLanding').mockResolvedValue(undefined);
  return { flow, sendInput, getItem: () => item };
}
async function verdict(findings: PlanQueueFinding[], outcome: 'PASS' | 'FAIL' = 'FAIL', maxRounds = 3) {
  const h = harness(maxRounds);
  h.flow.recordVerdict(h.getItem(), 'verifier', { verdict: outcome, findings, gatesRun: [], documentComplete: outcome === 'PASS', needJames: [] });
  await h.flow.onVerifierOutcome('verifier', { kind: 'turn-complete', lastAssistantOutput: null });
  return h;
}
// recordVerdict tags each finding with its kind, so retained findings are matched, not compared exactly.
describe('plan queue finding triage', () => {
  it('splits severities without changing order or the original findings', () => {
    const findings = [low, high];
    expect(splitFindings(findings)).toEqual({ blocking: [high], optional: [low] }); expect(findings).toEqual([low, high]);
  });
  it('mentions optional suggestions outside the fix payload', () => {
    const prompt = buildFixPrompt(1, 3, [high, low, low]);
    expect(prompt).toContain('2 lower-severity suggestions'); expect(prompt).not.toContain(low.summary);
  });
  it('sends only blocking findings for a mixed FAIL, retaining every finding on the item', async () => {
    const h = await verdict([low, high]);
    const prompt = h.sendInput.mock.calls[0][1] as string;
    expect(prompt).toContain(high.summary); expect(prompt).not.toContain(low.summary); expect(prompt).toContain('1 lower-severity');
    expect(h.getItem().verdict?.findings).toMatchObject([low, high]); expect(h.getItem().state).toBe('fixing');
  });
  it('keeps an all-low FAIL failing and sends every finding back', async () => {
    const h = await verdict([low]);
    expect(h.sendInput.mock.calls[0][1]).toContain(low.summary); expect(h.getItem().state).toBe('fixing');
  });
  it('retains optional PASS findings while proceeding to landing', async () => {
    const h = await verdict([low], 'PASS');
    expect(h.sendInput).not.toHaveBeenCalled(); expect(h.getItem().state).toBe('landing'); expect(h.getItem().verdict?.findings).toMatchObject([low]);
  });
  it('puts blocking findings first in the round-limit summary', async () => {
    const h = await verdict([low, low, low, low, low, high], 'FAIL', 1);
    expect(h.getItem().state).toBe('parked'); expect(h.getItem().detail).toContain(high.summary);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LoopFinalAuditResult, LoopState } from '../../shared/types/loop.types';
import { defaultLoopConfig } from '../../shared/types/loop.types';
import { applyLoopPhaseRecovery } from './loop-phase-recovery';
import { LoopStageMachine } from './loop-stage-machine';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, mkdir: vi.fn(actual.mkdir) };
});

const RUN_ID = 'phase-recovery-loop';

let tmpDir: string;
let stageMachine: LoopStageMachine;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-phase-recovery-'));
  stageMachine = new LoopStageMachine(tmpDir, RUN_ID);
  await stageMachine.bootstrap(defaultLoopConfig(tmpDir, 'finish phase one'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(fsp.mkdir).mockReset();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('applyLoopPhaseRecovery', () => {
  it('updates OUTSTANDING.md as a single three-section document on handoff', async () => {
    fs.writeFileSync(
      stageMachine.paths.tasks,
      '- [ ] Phase 1: prove the audit blocks completion\n',
      'utf8',
    );
    fs.writeFileSync(
      stageMachine.paths.outstanding,
      [
        '## Needs human',
        '- (none)',
        '',
        '## Decisions applied',
        '- Use existing helper naming.',
        '  - Applied: Keep the local naming style.',
        '',
        '## For information',
        '- Should audit gate mode be default?',
        '  - Recommendation: Keep observe mode until smoke-tested.',
        '',
      ].join('\n'),
      'utf8',
    );
    const state = minimalLoopState();
    const finalAudit = failedAudit();

    await applyLoopPhaseRecovery({ state, iteration: undefined, finalAudit, stageMachine });
    await applyLoopPhaseRecovery({ state, iteration: undefined, finalAudit, stageMachine });
    const decision = await applyLoopPhaseRecovery({ state, iteration: undefined, finalAudit, stageMachine });

    expect(decision.status).toBe('handoff');
    const outstanding = fs.readFileSync(stageMachine.paths.outstanding, 'utf8');
    expect(outstanding.match(/^## Needs human$/gm)).toHaveLength(1);
    expect(outstanding.match(/^## For information$/gm)).toHaveLength(1);
    expect(outstanding).toContain('Phase recovery handoff for phase-1');
    expect(outstanding).toContain('- Recommendation: Review');
    expect(outstanding.match(/^## Decisions applied$/gm)).toHaveLength(1);
    expect(outstanding).toContain('Use existing helper naming.');
    expect(outstanding).toContain('Keep the local naming style.');
    expect(outstanding).toContain('Should audit gate mode be default?');
    expect(outstanding).toContain('Keep observe mode until smoke-tested.');
  });

  it('does not attribute a global open-ledger blocker to a phase whose packet is complete', async () => {
    fs.mkdirSync(stageMachine.paths.phasesDir, { recursive: true });
    fs.writeFileSync(
      path.join(stageMachine.paths.phasesDir, 'phase-2.md'),
      [
        '## Phase 2: WS2',
        '',
        'Acceptance Criteria:',
        '- Shared resilience is runtime-wired.',
        '',
        'Required Commands:',
        '- npm run test:quiet',
        '',
        'Evidence:',
        '- src/main/util/backoff.spec.ts:1',
        '',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      stageMachine.paths.tasks,
      ['- [x] WS2 — shared resilience kit.', '- [ ] WS3 — redaction egress completion.', ''].join('\n'),
      'utf8',
    );
    const state = minimalLoopState();
    const finalAudit = failedAudit();

    const decisions = [];
    decisions.push(await applyLoopPhaseRecovery({ state, iteration: undefined, finalAudit, stageMachine }));
    decisions.push(await applyLoopPhaseRecovery({ state, iteration: undefined, finalAudit, stageMachine }));
    decisions.push(await applyLoopPhaseRecovery({ state, iteration: undefined, finalAudit, stageMachine }));

    expect(decisions).toEqual([
      { status: 'continue' },
      { status: 'continue' },
      { status: 'continue' },
    ]);
    expect(state.phaseRecovery).toBeUndefined();
  });
});

function minimalLoopState(): LoopState {
  const config = defaultLoopConfig(tmpDir, 'finish phase one');
  return {
    id: RUN_ID,
    chatId: 'chat-1',
    config,
    status: 'running',
    startedAt: Date.now(),
    endedAt: null,
    totalIterations: 0,
    totalTokens: 0,
    totalCostCents: 0,
    currentStage: 'IMPLEMENT',
    pendingInterventions: [],
    completedFileRenameObserved: false,
    doneSentinelPresentAtStart: false,
    planChecklistFullyCheckedAtStart: false,
    uncompletedPlanFilesAtStart: [],
    manualReviewOnly: false,
    tokensSinceLastTestImprovement: 0,
    highestTestPassCount: 0,
    iterationsOnCurrentStage: 0,
    recentWarnIterationSeqs: [],
    completionAttempts: 0,
    loopTasksLedgerResolvedAtStart: false,
  };
}

function failedAudit(): LoopFinalAuditResult {
  return {
    status: 'failed',
    ranAt: Date.now(),
    coverage: {
      criteriaTotal: 1,
      criteriaVerified: 0,
      criteriaUnverified: 1,
      verifyCommandRan: true,
      repoComparisonRan: true,
      cleanlinessScanRan: true,
    },
    findings: [
      {
        severity: 'blocking',
        code: 'ledger-open',
        message: 'LOOP_TASKS.md still has 1 open item.',
      },
    ],
    changedFiles: ['src/main/orchestration/loop-phase-recovery.ts'],
  };
}

it.each(['paused', 'cancelled'] as const)('does not recover after %s during the phase read', async status => {
  const state = minimalLoopState();
  vi.spyOn(stageMachine, 'readTaskLedger').mockImplementation(async () => {
    state.status = status;
    return { nextTodo: 'Phase 1: pending', raw: '', total: 1, items: [], resolved: 0, complete: false, duplicateIds: [], malformedIds: [] };
  });
  const decision = await applyLoopPhaseRecovery({ state, iteration: undefined, finalAudit: failedAudit(), stageMachine });
  expect(decision).toEqual({ status: 'continue' });
  expect(state.phaseRecovery).toBeUndefined();
  expect(state.pendingInterventions).toEqual([]);
});

it('does not write a recovery handoff if paused during directory creation', async () => {
  fs.writeFileSync(stageMachine.paths.tasks, '- [ ] Phase 1: pending\n');
  const state = minimalLoopState(); const finalAudit = failedAudit();
  await applyLoopPhaseRecovery({ state, iteration: undefined, finalAudit, stageMachine });
  const second = await applyLoopPhaseRecovery({ state, iteration: undefined, finalAudit, stageMachine });
  fs.writeFileSync(second.fixSpecPath!, 'existing fix spec');
  const outstanding = fs.readFileSync(stageMachine.paths.outstanding, 'utf8');
  const mkdir = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).mkdir;
  vi.mocked(fsp.mkdir).mockImplementation(async (...args: Parameters<typeof fsp.mkdir>) => {
    const result = await mkdir(...args);
    state.status = 'paused';
    return result;
  });
  const result = await applyLoopPhaseRecovery({ state, iteration: undefined, finalAudit, stageMachine });
  expect(result).toEqual({ status: 'continue' }); expect(state.status).toBe('paused');
  expect(fs.readFileSync(second.fixSpecPath!, 'utf8')).toBe('existing fix spec');
  expect(fs.readFileSync(stageMachine.paths.outstanding, 'utf8')).toBe(outstanding);
});

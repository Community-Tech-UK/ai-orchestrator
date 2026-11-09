import { describe, expect, it } from 'vitest';
import {
  PlanQueueAlertSchema, PlanQueueQuestionSchema, PlanQueueReportTriageArgsSchema, PlanQueueControlPayloadSchema, PlanQueueControlArgsSchema,
  PlanQueueItemDtoSchema, PlanQueueRoutingSchema, PlanQueueStartArgsSchema,
  PlanQueueReportVerdictArgsSchema, PlanQueueParkReasonSchema,
  PlanQueueFolderChecklistsSchema, normalizeChecklistFolder, isAbsoluteChecklistFolder,
  PlanQueueFoldersSchema, PlanQueueSourceKindSchema, triageRecordRef,
  DEFAULT_PLAN_QUEUE_CONFIG, PlanQueueRunConfigSchema, PlanQueueGateRunSchema, PlanQueueRunDtoSchema,
} from '../plan-queue.schemas';

const question = {
  question: 'Which existing verification command should the worker use?',
  options: [{ id: 'quiet', label: 'Use the documented quiet runner' }, { id: 'skip', label: 'Leave the document alone' }],
};
const technical = {
  kind: 'technical', recommendedOptionId: 'quiet', reason: 'The project requires this runner.', evidence: 'AGENTS.md documents npm run test:quiet.',
};

describe('Plan Queue check batch size', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('preserves a batch size of %s at the run and tool boundaries', checkBatchSize => {
    expect(PlanQueueRunConfigSchema.parse({ ...DEFAULT_PLAN_QUEUE_CONFIG.plans, checkBatchSize }))
      .toMatchObject({ checkBatchSize });
    expect(PlanQueueStartArgsSchema.parse({ kind: 'plans', check_batch_size: checkBatchSize }))
      .toEqual({ kind: 'plans', check_batch_size: checkBatchSize });
  });

  it.each([0, 9, 1.5])('rejects an invalid batch size of %s at both boundaries', checkBatchSize => {
    expect(PlanQueueRunConfigSchema.safeParse({ ...DEFAULT_PLAN_QUEUE_CONFIG.plans, checkBatchSize }).success).toBe(false);
    expect(PlanQueueStartArgsSchema.safeParse({ kind: 'plans', check_batch_size: checkBatchSize }).success).toBe(false);
  });
});

describe('Plan Queue verification coverage', () => {
  it('preserves combined evidence while accepting legacy receipts and absent summaries', () => {
    const receipt = { command: 'check', exitCode: 0, head: 'member-head', testedTree: 'tested-tree',
      checkGroup: { id: 'group', baseTip: 'base', memberItemIds: ['first', 'second'] } };
    expect(PlanQueueGateRunSchema.parse(receipt)).toEqual(receipt);
    expect(PlanQueueGateRunSchema.parse({ command: 'check', exitCode: 0 })).toEqual({ command: 'check', exitCode: 0 });
    const run = { id: 'run', parentInstanceId: 'parent', kind: 'plans', workspaceCwd: '/repo', status: 'running',
      config: DEFAULT_PLAN_QUEUE_CONFIG.plans, workerProvider: null, relaxedSettings: [], startedAt: 1, endedAt: null, items: [] };
    expect(PlanQueueRunDtoSchema.parse({ ...run, checks: { runs: 3, jobs: 10 } })).toMatchObject({ checks: { runs: 3, jobs: 10 } });
    expect(PlanQueueRunDtoSchema.parse(run)).not.toHaveProperty('checks');
  });
  it('requires explicit coverage and rejects meaningless entries', () => {
    const args = { item_id: 'item', verdict: 'PASS' };
    expect(PlanQueueReportVerdictArgsSchema.safeParse(args).success).toBe(false);
    expect(PlanQueueReportVerdictArgsSchema.safeParse({ ...args, not_checked: [] }).success).toBe(true);
    for (const entry of ['TODO', 'n/a', 'not run', '   ']) {
      expect(PlanQueueReportVerdictArgsSchema.safeParse({ ...args, not_checked: [entry] }).success).toBe(false);
    }
    expect(PlanQueueReportVerdictArgsSchema.parse({ ...args, not_checked: ['Windows sign-in requires an authenticated worker.'] }).not_checked)
      .toEqual(['Windows sign-in requires an authenticated worker.']);
  });
});

describe('Plan Queue finding kinds and deferred checks', () => {
  const base = { item_id: 'item', verdict: 'FAIL', not_checked: [] };
  const finding = { severity: 'high', confidence: 90, summary: 'The gate cannot run.' };

  it('accepts a finding with no kind (stored verdicts) and each of the three kinds', () => {
    expect(PlanQueueReportVerdictArgsSchema.safeParse({ ...base, findings: [finding] }).success).toBe(true);
    expect(PlanQueueReportVerdictArgsSchema.safeParse({ ...base, findings: [{ ...finding, kind: 'code' }] }).success).toBe(true);
    for (const kind of ['environment', 'needs-human']) {
      expect(PlanQueueReportVerdictArgsSchema.safeParse({ ...base, findings: [{ ...finding, kind, missing: 'The signing certificate' }] }).success).toBe(true);
    }
    expect(PlanQueueReportVerdictArgsSchema.safeParse({ ...base, findings: [{ ...finding, kind: 'unknown' }] }).success).toBe(false);
  });

  it('has a park reason for each way a non-code stop can end', () => {
    expect(PlanQueueParkReasonSchema.safeParse('needs-setup').success).toBe(true);
    expect(PlanQueueParkReasonSchema.safeParse('needs-james').success).toBe(true);
  });
});

describe('Plan Queue checkout alerts', () => {
  it('preserves bounded invalid-checkout advice and keeps legacy alerts valid', () => {
    const alert = {
      kind: 'invalid-worktree', path: '/repo/.worktrees/queue/item', itemId: 'item',
      reason: 'Saved checkout is unusable.', suggestedAction: 'Review the item details before explicitly approving Discard.',
    };
    expect(PlanQueueAlertSchema.parse(alert)).toEqual(alert);
    expect(PlanQueueAlertSchema.parse({ kind: 'missing-worktree', itemId: 'item' })).toEqual({ kind: 'missing-worktree', itemId: 'item' });
  });

  it.each(['reason', 'suggestedAction'])('rejects oversized %s instead of exposing raw diagnostics', (field) => {
    expect(PlanQueueAlertSchema.safeParse({ kind: 'invalid-worktree', [field]: 'x'.repeat(1001) }).success).toBe(false);
  });
});

describe('Plan Queue readiness decisions', () => {
  it('preserves evidence-backed technical metadata through triage parsing', () => {
    const parsed = PlanQueueReportTriageArgsSchema.parse({
      run_id: 'run-1', records: [{ documentPath: '/repo/a_plan.md', disposition: 'needs-answer', question: { ...question, decision: technical } }],
    });
    expect(parsed.records[0]).toMatchObject({ question: { decision: technical } });
  });

  it('keeps old unclassified questions valid without inventing a decision', () => {
    expect(PlanQueueQuestionSchema.parse(question)).toEqual(question);
  });

  it.each(['human-authority', 'human-input'])('preserves a %s boundary', (kind) => {
    const decision = { kind, reason: 'Requires a fact or authority only James can provide.' };
    expect(PlanQueueQuestionSchema.parse({ ...question, decision })).toMatchObject({ decision });
  });

  it.each([
    { ...technical, recommendedOptionId: 'missing' },
    { ...technical, recommendedOptionId: 'skip' },
    { ...technical, reason: '' },
    { ...technical, evidence: '' },
    { ...technical, reason: '   ' },
    { ...technical, evidence: '   ' },
    { ...technical, recommendedOptionId: 'x'.repeat(51) },
    { ...technical, reason: 'x'.repeat(4001) },
    { ...technical, evidence: 'x'.repeat(8001) },
    { kind: 'unknown', reason: 'Unsupported classification' },
    { kind: 'human-authority', reason: 'Requires approval', recommendedOptionId: 'quiet' },
  ])('rejects invalid decision metadata %#', (decision) => {
    expect(PlanQueueQuestionSchema.safeParse({ ...question, decision }).success).toBe(false);
  });

  it('rejects duplicate option identifiers', () => {
    expect(PlanQueueQuestionSchema.safeParse({
      ...question, options: [{ id: 'quiet', label: 'First' }, { id: 'quiet', label: 'Second' }], decision: technical,
    }).success).toBe(false);
  });
});


describe('Plan Queue routing controls', () => {
  it('accepts panel-only bulk actions and a complete per-run routing change', () => {
    expect(PlanQueueControlPayloadSchema.parse({ action: 'pause-all' })).toEqual({ action: 'pause-all' });
    expect(PlanQueueControlPayloadSchema.parse({ action: 'resume-all' })).toEqual({ action: 'resume-all' });
    expect(PlanQueueControlPayloadSchema.parse({ action: 'set-routing', runId: 'run', routing: { workers: [], verifiers: [] }, moveInProgress: true })).toMatchObject({ moveInProgress: true });
    expect(PlanQueueControlPayloadSchema.parse({ action: 'set-routing', runId: 'run', routing: { workers: [{ provider: 'codex' }, { provider: 'claude' }], verifiers: [] } }))
      .toMatchObject({ routing: { workers: [{ provider: 'codex' }, { provider: 'claude' }] } });
    // The old single-worker shape is refused at the boundary; stored values are upgraded on read.
    expect(PlanQueueControlPayloadSchema.safeParse({ action: 'set-routing', runId: 'run', routing: { worker: null, verifiers: [] } }).success).toBe(false);
  });
  it('uses snake_case routing choices over MCP and refuses bulk actions', () => {
    expect(PlanQueueControlArgsSchema.parse({ action: 'set-routing', run_id: 'run', routing: { workers: [{ provider: 'codex', account_ids: ['account'] }], verifiers: [] }, move_in_progress: true })).toMatchObject({ move_in_progress: true });
    expect(PlanQueueControlArgsSchema.safeParse({ action: 'set-routing', run_id: 'run', routing: { worker: { provider: 'codex' }, verifiers: [] } }).success).toBe(false);
    expect(PlanQueueControlArgsSchema.safeParse({ action: 'pause-all' }).success).toBe(false);
    expect(PlanQueueControlArgsSchema.safeParse({ action: 'set-routing', run_id: 'run' }).success).toBe(false);
  });
  it('carries an optional step-up choice in routing, start and set-routing, and still refuses unknown fields', () => {
    const stepUp = { provider: 'claude', model: 'opus' };
    expect(PlanQueueRoutingSchema.parse({ workers: [], verifiers: [] })).toEqual({ workers: [], verifiers: [] });
    expect(PlanQueueRoutingSchema.parse({ workers: [], verifiers: [], stepUp })).toEqual({ workers: [], verifiers: [], stepUp });
    expect(PlanQueueRoutingSchema.safeParse({ workers: [], verifiers: [], stepUp, fallback: stepUp }).success).toBe(false);
    expect(PlanQueueRoutingSchema.safeParse({ workers: [], verifiers: [], stepUp: { ...stepUp, accounts: [] } }).success).toBe(false);
    expect(PlanQueueStartArgsSchema.parse({ kind: 'plans', step_up: { provider: 'claude', model: 'opus' } }))
      .toMatchObject({ step_up: { provider: 'claude', model: 'opus' } });
    expect(PlanQueueControlArgsSchema.parse({ action: 'set-routing', run_id: 'run', routing: { workers: [], verifiers: [], step_up: { provider: 'claude' } } }))
      .toMatchObject({ routing: { step_up: { provider: 'claude' } } });
    expect(PlanQueueControlArgsSchema.safeParse({ action: 'set-routing', run_id: 'run', routing: { workers: [], verifiers: [], stepUp } }).success).toBe(false);
  });
  it('accepts an item with or without a recorded handover', () => {
    const item = {
      id: 'item', runId: 'run', sourceRef: '/repo/a_plan.md', state: 'fixing', round: 0, erroredRounds: 0, branchName: null, worktreePath: null,
      baseCommit: null, checkpointCommit: null, landedCommit: null, workerInstanceId: null, verifierInstanceId: null, question: null, answer: null,
      parkReason: null, detail: null, verdict: null, createdAt: 1, updatedAt: 1,
    };
    expect(PlanQueueItemDtoSchema.safeParse(item).success).toBe(true);
    expect(PlanQueueItemDtoSchema.parse({ ...item, steppedUpAt: 5 }).steppedUpAt).toBe(5);
    expect(PlanQueueItemDtoSchema.parse({ ...item, steppedUpAt: null }).steppedUpAt).toBeNull();
  });
});

describe('Plan Queue folder checklists: one entry per folder', () => {
  const entry = (folder: string) => ({ folder, verifierGates: ['make check'], postMergeGate: [] });
  it('writes every spelling of a folder the same way', () => {
    expect(normalizeChecklistFolder('/work/shop')).toBe('/work/shop');
    expect(normalizeChecklistFolder('/work/shop/')).toBe('/work/shop');
    expect(normalizeChecklistFolder('/work//shop/./')).toBe('/work/shop');
    expect(normalizeChecklistFolder('/work/base/../shop')).toBe('/work/shop');
    expect(normalizeChecklistFolder('/../work/shop')).toBe('/work/shop');
    expect(normalizeChecklistFolder('C:\\work\\shop\\')).toBe('C:/work/shop');
    expect(normalizeChecklistFolder('C:/work/shop/sub/..')).toBe('C:/work/shop');
    expect(normalizeChecklistFolder('/work/shop-two')).not.toBe('/work/shop');
    expect(normalizeChecklistFolder('/')).toBe('/');
  });
  it('refuses two spellings of the same folder and accepts different folders', () => {
    expect(PlanQueueFolderChecklistsSchema.safeParse([entry('/work/shop'), entry('/work/base/../shop')]).success).toBe(false);
    expect(PlanQueueFolderChecklistsSchema.safeParse([entry('/work/shop'), entry('/work/shop/')]).success).toBe(false);
    expect(PlanQueueFolderChecklistsSchema.safeParse([entry('/work/shop'), entry('/work/shop-two'), entry('/work/shop/sub')]).success).toBe(true);
  });
  it('refuses a folder that is not a full path, because no run could ever start in it', () => {
    expect(isAbsoluteChecklistFolder('/work/shop')).toBe(true);
    expect(isAbsoluteChecklistFolder('C:\\work\\shop')).toBe(true);
    expect(isAbsoluteChecklistFolder('//server/share/shop')).toBe(true);
    expect(isAbsoluteChecklistFolder('\\\\server\\share\\shop')).toBe(true);
    for (const relative of ['docs', './shop', '../shop', 'work/shop', '~/shop', 'C:shop', '\\shop', '\\']) {
      expect(isAbsoluteChecklistFolder(relative)).toBe(false);
      const result = PlanQueueFolderChecklistsSchema.safeParse([entry(relative)]);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toContain('full path');
    }
    expect(PlanQueueFolderChecklistsSchema.safeParse([entry('/work/shop'), entry('C:\\work\\shop')]).success).toBe(true);
  });
});

describe('Plan Queue folder list (step 6.4)', () => {
  it('accepts full paths and refuses a relative one in plain words', () => {
    expect(PlanQueueFoldersSchema.safeParse(['/work/shop', 'C:\\work\\blog']).success).toBe(true);
    const result = PlanQueueFoldersSchema.safeParse(['docs']);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('full path');
  });

  it('lists a folder once, whatever its spelling', () => {
    expect(PlanQueueFoldersSchema.safeParse(['/work/shop', '/work/base/../shop/']).success).toBe(false);
    expect(PlanQueueFoldersSchema.safeParse(['/work/shop', '/work/shop-two']).success).toBe(true);
  });

  it('is not part of the start arguments a session sends: only the workspace to start in is', () => {
    expect(PlanQueueStartArgsSchema.parse({ kind: 'plans', workspace: '/work/shop' })).toEqual({ kind: 'plans', workspace: '/work/shop' });
    expect(PlanQueueStartArgsSchema.safeParse({ kind: 'plans', planQueueFolders: ['/work/shop'] }).success).toBe(false);
    expect(PlanQueueStartArgsSchema.safeParse({ kind: 'plans', workspace: '' }).success).toBe(false);
  });
});

describe('Plan Queue work source fields (step 6.3)', () => {
  it('knows the markdown source and nothing else yet', () => {
    expect(PlanQueueSourceKindSchema.parse('markdown')).toBe('markdown');
    expect(PlanQueueSourceKindSchema.safeParse('linear').success).toBe(false);
  });

  it('names an item by its source reference, with the kind optional', () => {
    const item = { id: 'i', runId: 'r', sourceRef: '/repo/a_plan.md', state: 'queued', round: 0, erroredRounds: 0, branchName: null, worktreePath: null,
      baseCommit: null, checkpointCommit: null, landedCommit: null, workerInstanceId: null, verifierInstanceId: null, question: null, answer: null,
      parkReason: null, detail: null, verdict: null, createdAt: 1, updatedAt: 1 };
    expect(PlanQueueItemDtoSchema.parse(item)).toMatchObject({ sourceRef: '/repo/a_plan.md' });
    expect(PlanQueueItemDtoSchema.parse({ ...item, sourceKind: 'markdown' })).toMatchObject({ sourceKind: 'markdown' });
    expect(PlanQueueItemDtoSchema.safeParse({ ...item, sourceRef: undefined, documentPath: '/repo/a_plan.md' }).success).toBe(false);
  });

  it('lets a triage record name its work by sourceRef beside documentPath, and prefers sourceRef', () => {
    const record = { disposition: 'ready' as const };
    expect(PlanQueueReportTriageArgsSchema.safeParse({ run_id: 'r', records: [{ ...record, documentPath: '/repo/a_plan.md' }] }).success).toBe(true);
    expect(PlanQueueReportTriageArgsSchema.safeParse({ run_id: 'r', records: [{ ...record, sourceRef: '/repo/a_plan.md' }] }).success).toBe(true);
    expect(PlanQueueReportTriageArgsSchema.safeParse({ run_id: 'r', records: [record] }).success).toBe(false);
    expect(triageRecordRef({ documentPath: '/repo/old.md', sourceRef: '/repo/new.md' })).toBe('/repo/new.md');
    expect(triageRecordRef({ documentPath: '/repo/old.md' })).toBe('/repo/old.md');
    expect(() => triageRecordRef({})).toThrow(/documentPath or a sourceRef/);
  });
});

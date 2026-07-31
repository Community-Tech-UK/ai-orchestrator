import { describe, expect, it } from 'vitest';
import type { LoopRunSummary } from '../../shared/types/loop.types';
import type { LoopTerminalIntent } from '../../shared/types/loop-state.types';
import type { ProviderLimitEvent } from '../core/system/provider-limit-ledger';
import type { CompactionRecord } from '../context/compaction-epoch';
import type { AutomationRun } from '../../shared/types/automation.types';
import type { AdmissionRecord } from '../session/session-admission-store';
import {
  WORKBOARD_DECISIONS_MAX,
  buildAdmissionDecisions,
  buildAutomationDecisions,
  buildCompactionDecisions,
  buildLoopGateDecisions,
  buildProviderLimitDecisions,
  mergeOperationalDecisions,
} from './operational-decision-projection';

function loopRunSummary(overrides: Partial<LoopRunSummary> = {}): LoopRunSummary {
  return {
    id: 'loop-1',
    chatId: 'inst-1',
    status: 'running',
    totalIterations: 3,
    totalTokens: 100,
    totalCostCents: 10,
    startedAt: 1_000,
    endedAt: null,
    endReason: null,
    workspaceCwd: '/tmp/ws',
    initialPrompt: 'do the thing',
    iterationPrompt: null,
    ...overrides,
  };
}

function terminalIntent(overrides: Partial<LoopTerminalIntent> = {}): LoopTerminalIntent {
  return {
    id: 'intent-1',
    loopRunId: 'loop-1',
    iterationSeq: 2,
    kind: 'block',
    summary: 'Cannot proceed without a decision on X',
    evidence: [],
    source: 'loop-control-cli',
    createdAt: 2_000,
    receivedAt: 2_100,
    status: 'accepted',
    ...overrides,
  };
}

function providerLimitEvent(overrides: Partial<ProviderLimitEvent> = {}): ProviderLimitEvent {
  return {
    id: 'evt-1',
    provider: 'claude',
    model: null,
    detectedAt: 5_000,
    resumeAt: 9_000,
    source: 'loop-quota',
    instanceId: 'loop-1',
    ...overrides,
  };
}

function compactionRecord(overrides: Partial<CompactionRecord> = {}): CompactionRecord {
  return { epochId: 'epoch-1', turnsBeforeCompaction: 12, timestamp: 3_000, ...overrides };
}

function automationRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'automation-1',
    status: 'failed',
    trigger: 'manual',
    scheduledAt: 1_000,
    startedAt: 1_000,
    finishedAt: 1_500,
    instanceId: null,
    loopRunId: null,
    error: 'timed out talking to the provider',
    outputSummary: null,
    outputFullRef: null,
    idempotencyKey: null,
    triggerSource: null,
    deliveryMode: 'silent',
    seenAt: null,
    createdAt: 1_000,
    updatedAt: 1_500,
    configSnapshot: null,
    attempt: 1,
    maxAttempts: 3,
    ...overrides,
  };
}

function admissionRecord(overrides: Partial<AdmissionRecord> = {}): AdmissionRecord {
  return {
    admissionId: 'adm-1',
    instanceId: 'inst-1',
    origin: 'user',
    message: 'go ahead and do it',
    attachmentRefs: [],
    contextBlock: null,
    sourceMetadata: null,
    state: 'suppressed',
    suppressReason: 'duplicate of an already-queued send',
    createdAt: 4_000,
    updatedAt: 4_100,
    deliveredAt: null,
    errorText: null,
    queuePosition: null,
    attachmentFiles: [],
    ...overrides,
  };
}

describe('buildProviderLimitDecisions', () => {
  it('maps a ledger event to a plain-language paused entry with the raw resumeAt', () => {
    const [decision] = buildProviderLimitDecisions(
      [providerLimitEvent()],
      { activeEventId: null, loopRunId: undefined, loopResumable: false },
    );
    expect(decision).toMatchObject({
      id: 'pl:evt-1',
      at: 5_000,
      source: 'provider-limit',
      title: 'Paused: Claude hit its usage limit',
      resultingStatus: 'provider-limit',
      resumeAt: 9_000,
    });
    expect(decision.operatorAction).toBeUndefined();
  });

  it('attaches the resume-loop action only to the active event of a resumable loop', () => {
    const events = [
      providerLimitEvent({ id: 'evt-old', detectedAt: 1_000, resumeAt: 2_000 }),
      providerLimitEvent({ id: 'evt-active', detectedAt: 5_000, resumeAt: 9_000 }),
    ];
    const decisions = buildProviderLimitDecisions(events, {
      activeEventId: 'evt-active',
      loopRunId: 'loop-1',
      loopResumable: true,
    });
    const [old, active] = decisions;
    expect(old!.operatorAction).toBeUndefined();
    expect(active!.operatorAction).toEqual({ kind: 'resume-loop', label: 'Resume now', loopRunId: 'loop-1' });
  });

  it('never attaches the action when the loop is not currently resumable', () => {
    const [decision] = buildProviderLimitDecisions(
      [providerLimitEvent({ id: 'evt-active' })],
      { activeEventId: 'evt-active', loopRunId: 'loop-1', loopResumable: false },
    );
    expect(decision!.operatorAction).toBeUndefined();
  });

  it('never attaches the action for an instance-only item (no loopRunId)', () => {
    const [decision] = buildProviderLimitDecisions(
      [providerLimitEvent({ id: 'evt-active' })],
      { activeEventId: 'evt-active', loopRunId: undefined, loopResumable: true },
    );
    expect(decision!.operatorAction).toBeUndefined();
  });

  it('tolerates an empty event list', () => {
    expect(buildProviderLimitDecisions([], { activeEventId: null, loopResumable: false })).toEqual([]);
  });
});

describe('buildLoopGateDecisions — plain-language title mapping', () => {
  it.each([
    ['block', 'accepted', 'Needs you — the agent raised a blocker'],
    ['block', 'rejected', 'Blocker dismissed automatically (self-refuted on a liveness check)'],
    ['complete', 'accepted', 'Declared complete'],
    ['complete', 'rejected', 'Completion declined — needs another pass'],
    ['fail', 'accepted', 'Agent reported it could not proceed'],
    ['fail', 'rejected', 'Failure report dismissed'],
    ['wakeup', 'accepted', 'Scheduled to wake up and continue'],
    ['wakeup', 'rejected', 'Scheduled wake-up dismissed'],
  ] as const)('kind=%s status=%s -> %s', (kind, status, expectedTitle) => {
    const [decision] = buildLoopGateDecisions(
      [terminalIntent({ kind, status })],
      null,
    );
    expect(decision!.title).toBe(expectedTitle);
    expect(decision!.source).toBe('loop-gate');
  });

  it('skips pending, deferred, and superseded intents (not yet a resolved decision)', () => {
    for (const status of ['pending', 'deferred', 'superseded'] as const) {
      expect(buildLoopGateDecisions([terminalIntent({ status })], null)).toEqual([]);
    }
  });

  it('carries resumeAt for an accepted wakeup intent', () => {
    const [decision] = buildLoopGateDecisions(
      [terminalIntent({ kind: 'wakeup', status: 'accepted', resumeAt: 8_000 })],
      null,
    );
    expect(decision!.resumeAt).toBe(8_000);
  });

  it('uses statusReason over the summary when present', () => {
    const [decision] = buildLoopGateDecisions(
      [terminalIntent({ statusReason: 'the exact reason' })],
      null,
    );
    expect(decision!.detail).toBe('the exact reason');
  });

  it.each([
    ['completed-needs-review', 'Finished — flagged items for you to check'],
    ['failed', 'Stopped — the run failed'],
    ['error', 'Stopped — hit an error'],
    ['no-progress', 'Stopped — no progress across recent iterations'],
    ['cap-reached', 'Stopped — hit its iteration/cost cap without finishing'],
    ['cost-exceeded', 'Stopped — cost cap hit mid-review'],
    ['needs-human-arbitration', 'Needs you — builder and reviewer are deadlocked'],
    ['reviewer-unreliable', 'Needs you — the reviewer kept producing unusable output'],
    ['reviewer-unavailable', 'Needs you — no reviewer could be reached'],
    ['builder-unreliable', 'Needs you — the agent keeps declaring done without addressing findings'],
  ] as const)('final loop status %s -> %s', (status, expectedTitle) => {
    const summary = loopRunSummary({ status, endedAt: 6_000, endReason: 'raw internal reason' });
    const decisions = buildLoopGateDecisions([], summary);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ title: expectedTitle, detail: 'raw internal reason', at: 6_000 });
  });

  it.each(['completed', 'cancelled', 'running', 'paused', 'provider-limit'] as const)(
    'emits no final-outcome entry for %s (clean/self-explanatory/covered elsewhere)',
    (status) => {
      const decisions = buildLoopGateDecisions([], loopRunSummary({ status, endedAt: 6_000 }));
      expect(decisions).toEqual([]);
    },
  );

  it('tolerates a null summary and an empty intent list', () => {
    expect(buildLoopGateDecisions([], null)).toEqual([]);
  });
});

describe('buildCompactionDecisions', () => {
  it('maps compaction history to plain-language entries, singular/plural turn wording', () => {
    const decisions = buildCompactionDecisions(
      [compactionRecord({ turnsBeforeCompaction: 1 }), compactionRecord({ epochId: 'e2', turnsBeforeCompaction: 5 })],
      'inst-1',
    );
    expect(decisions[0]).toMatchObject({
      id: 'cx:inst-1:epoch-1',
      source: 'compaction',
      title: 'Context compacted after 1 turn',
    });
    expect(decisions[1]!.title).toBe('Context compacted after 5 turns');
  });

  it('tolerates no compaction history', () => {
    expect(buildCompactionDecisions([], 'inst-1')).toEqual([]);
  });
});

describe('buildAutomationDecisions', () => {
  it('tolerates a null run', () => {
    expect(buildAutomationDecisions(null)).toEqual([]);
  });

  it('emits nothing for a plain first-attempt success', () => {
    expect(buildAutomationDecisions(automationRun({ status: 'succeeded', attempt: 1 }))).toEqual([]);
  });

  it('describes a retry attempt', () => {
    const [decision] = buildAutomationDecisions(automationRun({ attempt: 2, maxAttempts: 3, status: 'running' }));
    expect(decision!.title).toBe('Retried automatically — attempt 2 of 3');
    expect(decision!.source).toBe('automation');
  });

  it('describes a failure with its error excerpt', () => {
    const [decision] = buildAutomationDecisions(
      automationRun({ attempt: 1, status: 'failed', error: 'connection reset' }),
    );
    expect(decision!.title).toBe('Automation failed — connection reset');
    expect(decision!.resultingStatus).toBe('failed');
  });

  it('never fabricates a resumeAt — the scheduler does not persist one', () => {
    const [decision] = buildAutomationDecisions(automationRun({ attempt: 2 }));
    expect(decision!.resumeAt).toBeUndefined();
  });
});

describe('buildAdmissionDecisions', () => {
  it('maps a suppressed row with its origin and reason', () => {
    const [decision] = buildAdmissionDecisions([admissionRecord()]);
    expect(decision).toMatchObject({
      id: 'ad:adm-1',
      source: 'admission',
      title: 'Message suppressed (from user) — duplicate of an already-queued send',
      resultingStatus: 'suppressed',
    });
  });

  it.each(['expired', 'cancelled', 'failed'] as const)('maps a %s row', (state) => {
    const [decision] = buildAdmissionDecisions([admissionRecord({ state, errorText: 'boom' })]);
    expect(decision!.resultingStatus).toBe(state);
    expect(decision!.title).toContain('user');
  });

  it('filters out non-decision states such as delivered/queued', () => {
    expect(buildAdmissionDecisions([
      admissionRecord({ state: 'delivered' }),
      admissionRecord({ state: 'queued' }),
      admissionRecord({ state: 'promoting' }),
    ])).toEqual([]);
  });

  it('tolerates an empty list', () => {
    expect(buildAdmissionDecisions([])).toEqual([]);
  });
});

describe('mergeOperationalDecisions', () => {
  it('flattens every group, newest first', () => {
    const merged = mergeOperationalDecisions([
      buildCompactionDecisions([compactionRecord({ timestamp: 1_000 })], 'inst-1'),
      buildCompactionDecisions([compactionRecord({ epochId: 'e2', timestamp: 3_000 })], 'inst-1'),
      buildCompactionDecisions([compactionRecord({ epochId: 'e3', timestamp: 2_000 })], 'inst-1'),
    ]);
    expect(merged.map((d) => d.at)).toEqual([3_000, 2_000, 1_000]);
  });

  it('bounds the result to WORKBOARD_DECISIONS_MAX', () => {
    const many = Array.from({ length: WORKBOARD_DECISIONS_MAX + 10 }, (_, i) =>
      compactionRecord({ epochId: `e${i}`, timestamp: i }));
    const merged = mergeOperationalDecisions([buildCompactionDecisions(many, 'inst-1')]);
    expect(merged).toHaveLength(WORKBOARD_DECISIONS_MAX);
    // Kept the newest, not the oldest.
    expect(merged[0]!.at).toBe(WORKBOARD_DECISIONS_MAX + 9);
  });

  it('tolerates every group being empty', () => {
    expect(mergeOperationalDecisions([[], [], []])).toEqual([]);
  });

  it('tolerates no groups at all', () => {
    expect(mergeOperationalDecisions([])).toEqual([]);
  });
});

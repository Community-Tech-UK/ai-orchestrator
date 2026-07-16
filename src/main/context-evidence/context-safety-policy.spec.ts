import { describe, expect, it, vi } from 'vitest';
import type { ProviderContextCapabilities } from '@contracts/types/context-evidence';
import {
  ContextSafetyPolicy,
  createInitialContextSafetyPolicyState,
  type ContextSafetyPolicyInput,
} from './context-safety-policy';
import { ProviderContextActionExecutor } from './provider-context-action-executor';

const managed: ProviderContextCapabilities = {
  toolResultControl: 'pre-retention',
  toolResultVisibility: 'full',
  transcriptControl: 'rebuild',
  occupancyReporting: 'current',
  cumulativeReporting: 'available',
  interruptProof: 'observed',
  compactionProof: 'observed',
  sameThreadContinuation: true,
};

const observed: ProviderContextCapabilities = {
  ...managed,
  toolResultControl: 'post-retention',
  transcriptControl: 'native-compaction',
};

function input(overrides: Partial<ContextSafetyPolicyInput> = {}): ContextSafetyPolicyInput {
  return {
    sample: {
      occupancy: { status: 'known', used: 0, total: 100 },
      cumulativeTokens: 0,
      outputBytesSinceCompaction: 0,
      providerRequestCount: 0,
      newEvidenceCount: 1,
      newValidatedFindingCount: 1,
      recoveryEpoch: 0,
    },
    capabilities: managed,
    state: createInitialContextSafetyPolicyState('outer-send-1'),
    now: 100,
    ...overrides,
  };
}

describe('ContextSafetyPolicy', () => {
  it.each([
    [60, 'rebuild-working-set'],
    [85, 'stop-broad-research'],
  ] as const)('emits the %s%% threshold action once', (used, kind) => {
    const policy = new ContextSafetyPolicy();
    const first = policy.decide(input({
      sample: { ...input().sample, occupancy: { status: 'known', used, total: 100 } },
    }));
    const repeated = policy.decide(input({
      sample: { ...input().sample, occupancy: { status: 'known', used, total: 100 } },
      state: first.nextState,
    }));

    expect(first.action.kind).toBe(kind);
    expect(repeated.action.kind).toBe('none');
  });

  it('pauses at 60% when the provider cannot rebuild a bounded working set', () => {
    const policy = new ContextSafetyPolicy();
    const decision = policy.decide(input({
      sample: {
        ...input().sample,
        occupancy: { status: 'known', used: 60, total: 100 },
      },
      capabilities: { ...managed, transcriptControl: 'none' },
    }));

    expect(decision.action.kind).toBe('pause');
    expect(decision.reasonCode).toBe('WORKING_SET_REBUILD_UNAVAILABLE');
  });

  it('uses native compaction at 75% only with observed proof capability', () => {
    const policy = new ContextSafetyPolicy();
    const pressure = { ...input().sample, occupancy: { status: 'known' as const, used: 75, total: 100 } };

    expect(policy.decide(input({ sample: pressure, capabilities: observed })).action.kind)
      .toBe('native-compaction');
    expect(policy.decide(input({
      sample: pressure,
      capabilities: { ...observed, compactionProof: 'acknowledged-only' },
    })).action.kind).toBe('pause');
  });

  it('requires observed interrupt, observed compaction, and same-thread continuation at 92%', () => {
    const policy = new ContextSafetyPolicy();
    const pressure = { ...input().sample, occupancy: { status: 'known' as const, used: 92, total: 100 } };
    const capable = policy.decide(input({ sample: pressure, capabilities: observed }));
    const incapable = policy.decide(input({
      sample: pressure,
      capabilities: { ...observed, interruptProof: 'acknowledged-only' },
    }));

    expect(capable.action.kind).toBe('controlled-interrupt');
    expect(capable.requiredSequence).toEqual([
      'controlled-interrupt',
      'observed-compaction',
      'same-thread-continuation',
    ]);
    expect(incapable.action.kind).toBe('pause');
  });

  it('uses cumulative 2x and 4x checkpoints without treating them as occupancy', () => {
    const policy = new ContextSafetyPolicy();
    const atTwo = policy.decide(input({
      sample: {
        ...input().sample,
        occupancy: { status: 'unknown', reason: 'opaque provider' },
        cumulativeTokens: 200,
      },
      effectiveWindowTokens: 100,
    }));
    const atFour = policy.decide(input({
      sample: {
        ...input().sample,
        occupancy: { status: 'unknown', reason: 'opaque provider' },
        cumulativeTokens: 400,
      },
      effectiveWindowTokens: 100,
      capabilities: observed,
    }));

    expect(atTwo.action).toMatchObject({ kind: 'convergence-review', trigger: 'cumulative-2x' });
    expect(atTwo.occupancyPercent).toBeUndefined();
    expect(atFour.action).toMatchObject({ kind: 'controlled-recovery', trigger: 'cumulative-4x' });
    expect(atFour.occupancyPercent).toBeUndefined();
  });

  it('enforces the three-recovery ceiling per epoch and outer send', () => {
    const policy = new ContextSafetyPolicy();
    const recoveryInput = input({
      sample: { ...input().sample, cumulativeTokens: 400 },
      effectiveWindowTokens: 100,
      capabilities: observed,
      state: {
        ...createInitialContextSafetyPolicyState('outer-send-1'),
        recoveriesInEpoch: 3,
        recoveriesInOuterSend: 2,
      },
    });
    const epochLimited = policy.decide(recoveryInput);
    const outerLimited = policy.decide({
      ...recoveryInput,
      state: { ...recoveryInput.state, recoveriesInEpoch: 2, recoveriesInOuterSend: 3 },
    });

    expect(epochLimited.action.kind).toBe('pause');
    expect(epochLimited.reasonCode).toBe('RECOVERY_CEILING_REACHED');
    expect(outerLimited.action.kind).toBe('pause');
  });

  it('resets an epoch only on observed compaction/counter reset and never resets the outer-send ceiling', () => {
    const policy = new ContextSafetyPolicy();
    const state = {
      ...createInitialContextSafetyPolicyState('outer-send-1'),
      epoch: 4,
      recoveriesInEpoch: 2,
      recoveriesInOuterSend: 3,
      emittedTriggers: ['known-occupancy-60' as const],
    };

    expect(policy.advanceEpoch(state, 'compaction-acknowledged')).toBe(state);
    expect(policy.advanceEpoch(state, 'compaction-observed')).toMatchObject({
      epoch: 5,
      recoveriesInEpoch: 0,
      recoveriesInOuterSend: 3,
      emittedTriggers: [],
    });
    expect(policy.advanceEpoch(state, 'provider-counter-reset-observed').epoch).toBe(5);
  });

  it('uses explicit request/output budgets when occupancy is unknown', () => {
    const policy = new ContextSafetyPolicy({ unknownOutputByteBudget: 10, unknownRequestBudget: 3 });
    const decision = policy.decide(input({
      sample: {
        ...input().sample,
        occupancy: { status: 'unknown', reason: 'not reported' },
        cumulativeTokens: 99_999,
        outputBytesSinceCompaction: 10,
        providerRequestCount: 3,
      },
    }));

    expect(decision.action).toMatchObject({ kind: 'pause', trigger: 'unknown-occupancy-budget' });
    expect(decision.occupancyPercent).toBeUndefined();
  });

  it('does not trust a current-occupancy sample from an aggregate-only provider', () => {
    const policy = new ContextSafetyPolicy();
    const decision = policy.decide(input({
      sample: {
        ...input().sample,
        occupancy: { status: 'known', used: 99, total: 100 },
      },
      capabilities: { ...managed, occupancyReporting: 'aggregate-only' },
    }));

    expect(decision.action.kind).toBe('none');
    expect(decision.occupancyPercent).toBeUndefined();
  });

  it('does not consume cumulative checkpoints without cumulative-reporting capability', () => {
    const policy = new ContextSafetyPolicy();
    const decision = policy.decide(input({
      sample: {
        ...input().sample,
        occupancy: { status: 'unknown', reason: 'not reported' },
        cumulativeTokens: 400,
      },
      capabilities: { ...observed, cumulativeReporting: 'none' },
      effectiveWindowTokens: 100,
    }));

    expect(decision.action.kind).toBe('none');
    expect(decision.occupancyPercent).toBeUndefined();
  });

  it('externalizes oversized results pre-retention or defers post-retention pressure to a safe boundary', () => {
    const policy = new ContextSafetyPolicy();
    const preRetention = policy.decide(input({ oversizedResult: true }));
    const deferred = policy.decide(input({
      oversizedResult: true,
      capabilities: observed,
      atSafeProviderBoundary: false,
    }));
    const boundary = policy.decide(input({
      oversizedResult: true,
      capabilities: observed,
      atSafeProviderBoundary: true,
    }));

    expect(preRetention).toMatchObject({
      action: { kind: 'externalize-result', trigger: 'oversized-result' },
      captureDisposition: 'pre-retention',
    });
    expect(deferred).toMatchObject({
      action: { kind: 'none', trigger: 'oversized-result' },
      captureDisposition: 'post-retention',
      deferredUntilSafeBoundary: true,
    });
    expect(boundary.action.kind).toBe('native-compaction');
  });

  it('pauses when oversized-result control is unsupported instead of claiming a capture boundary', () => {
    const policy = new ContextSafetyPolicy();
    const decision = policy.decide(input({
      oversizedResult: true,
      capabilities: {
        ...managed,
        toolResultControl: 'none',
      },
      atSafeProviderBoundary: false,
    }));

    expect(decision.action.kind).toBe('pause');
    expect(decision.reasonCode).toBe('RESULT_CONTROL_UNAVAILABLE');
    expect(decision.captureDisposition).toBeUndefined();
  });

  it('triggers convergence review after repeated requests without evidence progress', () => {
    const policy = new ContextSafetyPolicy({ noProgressRequestThreshold: 3 });
    const decision = policy.decide(input({
      consecutiveNoProgressRequests: 3,
      sample: {
        ...input().sample,
        newEvidenceCount: 0,
        newValidatedFindingCount: 0,
      },
    }));

    expect(decision.action).toMatchObject({ kind: 'convergence-review', trigger: 'no-evidence-progress' });
  });

  it('blocks duplicate interrupted-turn replay and treats disconnect as a proof boundary', () => {
    const policy = new ContextSafetyPolicy();

    expect(policy.decide(input({ duplicateInterruptedTurnReplay: true })).reasonCode)
      .toBe('DUPLICATE_REPLAY_PROHIBITED');
    expect(policy.decide(input({ providerDisconnected: true })).reasonCode)
      .toBe('PROVIDER_CONTINUATION_PROOF_REQUIRED');
    expect(policy.decide(input({
      providerDisconnected: true,
      continuationProofObserved: true,
      capabilities: observed,
    })).action.kind).toBe('same-thread-continuation');
  });
});

describe('ProviderContextActionExecutor', () => {
  it('returns structured unavailable without inferring proof', async () => {
    const executor = new ProviderContextActionExecutor({});

    await expect(executor.execute('native-compaction')).resolves.toEqual({
      status: 'unavailable',
      action: 'native-compaction',
      proof: 'none',
      errorCode: 'ACTION_UNAVAILABLE',
    });
  });

  it('passes through only the handler proof stage and maps failures content-free', async () => {
    const executed = new ProviderContextActionExecutor({
      'native-compaction': vi.fn(async () => ({ proof: 'acknowledged' as const })),
    });
    const failed = new ProviderContextActionExecutor({
      'controlled-interrupt': vi.fn(async () => { throw new Error('secret fixture detail'); }),
    });

    await expect(executed.execute('native-compaction')).resolves.toEqual({
      status: 'executed',
      action: 'native-compaction',
      proof: 'acknowledged',
    });
    await expect(failed.execute('controlled-interrupt')).resolves.toEqual({
      status: 'failed',
      action: 'controlled-interrupt',
      proof: 'none',
      errorCode: 'ACTION_FAILED',
    });
  });

  it('does not upgrade requested or acknowledged execution into observed proof', async () => {
    const requested = new ProviderContextActionExecutor({
      'controlled-interrupt': vi.fn(async () => ({ proof: 'requested' as const })),
    });
    const acknowledged = new ProviderContextActionExecutor({
      'same-thread-continuation': vi.fn(async () => ({ proof: 'acknowledged' as const })),
    });

    await expect(requested.execute('controlled-interrupt')).resolves.toMatchObject({
      status: 'executed',
      proof: 'requested',
    });
    await expect(acknowledged.execute('same-thread-continuation')).resolves.toMatchObject({
      status: 'executed',
      proof: 'acknowledged',
    });
  });
});

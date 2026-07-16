import { describe, expect, it } from 'vitest';
import { buildLoopOutputEvidenceOptions } from './default-invokers';

describe('loop output evidence identity', () => {
  it('uses canonical AIO ownership and deterministic iteration identity', () => {
    expect(buildLoopOutputEvidenceOptions({
      provider: 'codex',
      loopRunId: 'loop-1',
      seq: 4,
      idempotencyKey: 'loop-1:4:output',
      delegateInspectionHint: true,
      instance: {
        contextEvidence: { conversationId: 'conversation-1' },
        providerSessionId: 'provider-thread-1',
      },
    })).toEqual({
      delegateInspectionHint: true,
      captureContext: {
        provider: 'codex',
        conversationId: 'conversation-1',
        providerThreadRef: 'provider-thread-1',
        turnRef: 'loop:loop-1:iteration:4',
        logicalCallId: 'loop-1:4:output',
        sourceKind: 'other',
        captureMode: 'post-retention',
        captureCompleteness: 'complete',
        observedBoundary: 'after-provider-retention',
      },
    });
  });

  it('keeps an unresolved canonical owner explicit instead of substituting provider identity', () => {
    const options = buildLoopOutputEvidenceOptions({
      provider: 'claude',
      loopRunId: 'loop-2',
      seq: 1,
      idempotencyKey: 'loop-2:1:output',
      delegateInspectionHint: false,
      instance: { providerSessionId: 'not-a-conversation-owner' },
    });

    expect(options.captureContext.conversationId).toBeUndefined();
    expect(options.captureContext.providerThreadRef).toBe('not-a-conversation-owner');
  });
});

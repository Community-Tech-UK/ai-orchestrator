import { describe, expect, it } from 'vitest';
import { NotificationDeltaEventSchema, NotificationMarkSeenPayloadSchema,
  NotificationOpenTargetEventSchema, InstanceSubagentUsageEventSchema } from '../observability.schemas';
import { CostEntryEventSchema } from '../session.schemas';

describe('notification lifecycle contracts', () => {
  it('keeps full cost updates valid when provider credits and helper models arrive', () => {
    expect(CostEntryEventSchema.safeParse({ id: 'entry', timestamp: 1, instanceId: 'session',
      sessionId: 'provider-session', model: 'test-model', provider: 'copilot', inputTokens: 10,
      outputTokens: 2, cost: 0, aiCreditsNano: 1500.5, premiumRequests: 1,
      creditCheckpointId: 'checkpoint', creditCheckpointTotalNano: 1500.5, creditCheckpointPremiumTotal: 1,
      byModel: [{ model: 'test-model', inputTokens: 10, outputTokens: 2,
        cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }],
    }).success).toBe(true);
  });
  it('accepts lifecycle updates in the strict notification delta', () => {
    expect(NotificationDeltaEventSchema.safeParse({
      id: 'notice', kind: 'input-required', instanceId: 'session', title: 'Needs your answer',
      body: '', urgency: 'normal', fingerprint: 'request', createdAt: 1, delivery: 'desktop',
      seenAt: 2, resolvedAt: 3, updatedAt: 3, repeatCount: 2, resolveKey: 'input:request',
    }).success).toBe(true);
  });

  it('requires a nonempty selection to mark notices seen', () => {
    expect(NotificationMarkSeenPayloadSchema.safeParse({}).success).toBe(false);
    expect(NotificationMarkSeenPayloadSchema.safeParse({ ids: [] }).success).toBe(false);
    expect(NotificationMarkSeenPayloadSchema.safeParse({ ids: ['notice'] }).success).toBe(true);
    expect(NotificationMarkSeenPayloadSchema.safeParse({ instanceId: 'session' }).success).toBe(true);
    expect(NotificationMarkSeenPayloadSchema.safeParse({ ids: Array(101).fill('notice') }).success).toBe(false);
  });

  it('bounds and validates the notification click target', () => {
    expect(NotificationOpenTargetEventSchema.safeParse({ instanceId: 'session' }).success).toBe(true);
    expect(NotificationOpenTargetEventSchema.safeParse({ instanceId: '' }).success).toBe(false);
    expect(NotificationOpenTargetEventSchema.safeParse({ instanceId: 'session', extra: true }).success).toBe(false);
  });

  it('validates helper samples without accepting malformed counts', () => {
    const sample = { instanceId: 'session', toolUseId: 'helper', finalContextTokens: 100,
      toolUses: 2, durationMs: 1500, final: true };
    expect(InstanceSubagentUsageEventSchema.safeParse(sample).success).toBe(true);
    expect(InstanceSubagentUsageEventSchema.safeParse({ ...sample, toolUses: -1 }).success).toBe(false);
  });
});

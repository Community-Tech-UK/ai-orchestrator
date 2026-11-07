import { describe, expect, it } from 'vitest';
import { validateRendererEventPayload, isRendererEventSchemaRegistered } from '../event-bus/renderer-event-validation';
import { NotificationMarkSeenPayloadSchema } from '@contracts/schemas/observability';

describe('notification renderer contracts', () => {
  it('registers and validates the open-session push and rejects unbounded or extra payloads', () => {
    expect(isRendererEventSchemaRegistered('notification:open-target')).toBe(true);
    expect(validateRendererEventPayload('notification:open-target', { instanceId: 'a' })).toBe(true);
    expect(validateRendererEventPayload('notification:open-target', { instanceId: '' })).toBe(false);
    expect(validateRendererEventPayload('notification:open-target', { instanceId: 'a', prompt: 'Not allowed' })).toBe(false);
  });
  it('accepts notification lifecycle deltas rather than silently dropping them', () => {
    expect(validateRendererEventPayload('notification:delta', {
      id: 'n', kind: 'input-required', instanceId: 'a', title: 'Fix login needs your approval', body: 'Wants to use Bash',
      urgency: 'normal', fingerprint: 'f', createdAt: 1, seenAt: 2, resolvedAt: 3, updatedAt: 3,
      repeatCount: 2, resolveKey: 'input:r', delivery: 'desktop',
    })).toBe(true);
    expect(NotificationMarkSeenPayloadSchema.safeParse({}).success).toBe(false);
    expect(NotificationMarkSeenPayloadSchema.safeParse({ ids: ['n'] }).success).toBe(true);
  });
});

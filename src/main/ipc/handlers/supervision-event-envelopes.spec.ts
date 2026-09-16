import { describe, it, expect } from 'vitest';
import {
  SupervisionHealthGlobalEventSchema,
  SupervisionTreeUpdatedEventSchema,
  SupervisionWorkerEventSchema,
} from '@contracts/schemas/orchestration';

describe('supervision renderer event envelopes', () => {
  it('accepts worker events with extra passthrough fields', () => {
    expect(SupervisionWorkerEventSchema.parse({
      instanceId: 'inst-1',
      tree: { id: 'root' },
    })).toMatchObject({ instanceId: 'inst-1' });
  });

  it('rejects a global health event missing required counts', () => {
    expect(SupervisionHealthGlobalEventSchema.safeParse({ timestamp: 1 }).success).toBe(false);
  });

  it('accepts a tree-updated envelope with type and instanceId', () => {
    expect(SupervisionTreeUpdatedEventSchema.parse({
      type: 'instance-registered',
      instanceId: 'inst-1',
      extra: true,
    })).toMatchObject({
      type: 'instance-registered',
      instanceId: 'inst-1',
    });
  });
});

import { describe, it, expect } from 'vitest';
import { SpawnChildPayloadSchema } from '../schemas/orchestration.schemas';

describe('SpawnChildPayloadSchema — cursor', () => {
  it('accepts provider: cursor', () => {
    const result = SpawnChildPayloadSchema.safeParse({
      parentInstanceId: 'i-abc',
      task: 'hi',
      provider: 'cursor',
    });
    expect(result.success).toBe(true);
  });
});

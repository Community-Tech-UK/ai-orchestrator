import { describe, it, expect } from 'vitest';
import {
  InstanceCreatePayloadSchema,
  InstanceCreateWithMessagePayloadSchema,
} from '../schemas/instance.schemas';

describe('Instance payload schemas — cursor', () => {
  it('InstanceCreatePayloadSchema accepts provider: cursor', () => {
    const result = InstanceCreatePayloadSchema.safeParse({
      workingDirectory: '/tmp',
      provider: 'cursor',
    });
    expect(result.success).toBe(true);
  });
  it('InstanceCreateWithMessagePayloadSchema accepts provider: cursor', () => {
    const result = InstanceCreateWithMessagePayloadSchema.safeParse({
      workingDirectory: '/tmp',
      provider: 'cursor',
      message: 'hi',
    });
    expect(result.success).toBe(true);
  });
});

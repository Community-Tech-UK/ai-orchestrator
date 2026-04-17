import { describe, expect, it } from 'vitest';
import {
  InstanceCreatePayloadSchema,
  InstanceCreateWithMessagePayloadSchema,
} from '@contracts/schemas/instance';

describe('InstanceCreatePayloadSchema forceNodeId', () => {
  const validUuid = '123e4567-e89b-12d3-a456-426614174000';

  it('accepts an optional forceNodeId as a valid UUID', () => {
    const result = InstanceCreatePayloadSchema.safeParse({
      workingDirectory: '/tmp/project',
      forceNodeId: validUuid,
    });
    expect(result.success).toBe(true);
  });

  it('rejects forceNodeId that is not a UUID', () => {
    const result = InstanceCreatePayloadSchema.safeParse({
      workingDirectory: '/tmp/project',
      forceNodeId: 'not-a-uuid',
    });
    expect(result.success).toBe(false);
  });

  it('accepts payload without forceNodeId', () => {
    const result = InstanceCreatePayloadSchema.safeParse({
      workingDirectory: '/tmp/project',
    });
    expect(result.success).toBe(true);
  });
});

describe('IPC provider schema parity', () => {
  const canonicalProviders = ['auto', 'claude', 'codex', 'gemini', 'copilot'] as const;

  it('accepts the same canonical provider set for create and create-with-message', () => {
    for (const provider of canonicalProviders) {
      const createResult = InstanceCreatePayloadSchema.safeParse({
        workingDirectory: '/tmp/project',
        provider,
      });
      const createWithMessageResult = InstanceCreateWithMessagePayloadSchema.safeParse({
        workingDirectory: '/tmp/project',
        message: 'hello',
        provider,
      });

      expect(createResult.success).toBe(true);
      expect(createWithMessageResult.success).toBe(true);
    }
  });

  it('rejects legacy openai provider alias at runtime IPC boundaries', () => {
    const createResult = InstanceCreatePayloadSchema.safeParse({
      workingDirectory: '/tmp/project',
      provider: 'openai',
    });
    const createWithMessageResult = InstanceCreateWithMessagePayloadSchema.safeParse({
      workingDirectory: '/tmp/project',
      message: 'hello',
      provider: 'openai',
    });

    expect(createResult.success).toBe(false);
    expect(createWithMessageResult.success).toBe(false);
  });
});

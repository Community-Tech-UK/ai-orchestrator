import { describe, expect, it } from 'vitest';
import {
  InstanceChangeModelPayloadSchema,
  InstanceCreatePayloadSchema,
  InstanceCreateWithMessagePayloadSchema,
} from '../instance.schemas';

describe('instance.schemas', () => {
  it('accepts reasoning effort when changing a model', () => {
    expect(InstanceChangeModelPayloadSchema.parse({
      instanceId: 'instance-1',
      model: 'sonnet[1m]',
      reasoningEffort: 'max',
    })).toEqual({
      instanceId: 'instance-1',
      model: 'sonnet[1m]',
      reasoningEffort: 'max',
    });
  });

  it('accepts null reasoning effort to restore provider defaults', () => {
    expect(InstanceChangeModelPayloadSchema.parse({
      instanceId: 'instance-1',
      model: 'sonnet',
      reasoningEffort: null,
    }).reasoningEffort).toBeNull();
  });

  it('accepts bare mode on instance creation payloads', () => {
    expect(InstanceCreatePayloadSchema.parse({
      workingDirectory: '/repo',
      provider: 'claude',
      bareMode: true,
    }).bareMode).toBe(true);
  });

  it('accepts bare mode on create-with-message payloads', () => {
    expect(InstanceCreateWithMessagePayloadSchema.parse({
      workingDirectory: '/repo',
      message: 'hello',
      provider: 'claude',
      bareMode: true,
    }).bareMode).toBe(true);
  });

  it('accepts yolo mode on create-with-message payloads', () => {
    expect(InstanceCreateWithMessagePayloadSchema.parse({
      workingDirectory: '/repo',
      message: 'delete the stale copy',
      provider: 'codex',
      yoloMode: true,
    }).yoloMode).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { InstanceChangeModelPayloadSchema } from '../instance.schemas';

describe('instance.schemas', () => {
  it('accepts reasoning effort when changing a model', () => {
    expect(InstanceChangeModelPayloadSchema.parse({
      instanceId: 'instance-1',
      model: 'sonnet[1m]',
      reasoningEffort: 'high',
    })).toEqual({
      instanceId: 'instance-1',
      model: 'sonnet[1m]',
      reasoningEffort: 'high',
    });
  });

  it('accepts null reasoning effort to restore provider defaults', () => {
    expect(InstanceChangeModelPayloadSchema.parse({
      instanceId: 'instance-1',
      model: 'sonnet',
      reasoningEffort: null,
    }).reasoningEffort).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { normalizeRecoveryExecutionLocation } from './session-recovery-execution-location';

describe('recovery execution location', () => {
  it('keeps legacy records unspecified and clones local provenance', () => {
    expect(normalizeRecoveryExecutionLocation(undefined)).toBeUndefined();
    const location = { type: 'local' };
    expect(normalizeRecoveryExecutionLocation(location)).toEqual({ type: 'local' });
    expect(normalizeRecoveryExecutionLocation(location)).not.toBe(location);
  });

  it('retains a bounded remote worker identity without adopting other saved properties', () => {
    const location = { type: 'remote', nodeId: 'worker-placeholder', unexpected: 'ignored-placeholder' };
    const normalized = normalizeRecoveryExecutionLocation(location);
    location.nodeId = 'changed-placeholder';
    expect(normalized).toEqual({ type: 'remote', nodeId: 'worker-placeholder' });
    expect(normalizeRecoveryExecutionLocation({ type: 'remote', nodeId: 'a'.repeat(200) }))
      .toEqual({ type: 'remote', nodeId: 'a'.repeat(200) });
  });

  it.each([null, [], 'remote', {}, { type: 'unknown' }, { type: 'remote' },
    { type: 'remote', nodeId: '' }, { type: 'remote', nodeId: ' worker-placeholder' },
    { type: 'remote', nodeId: 'worker-placeholder ' }, { type: 'remote', nodeId: 'worker\nplaceholder' },
    { type: 'remote', nodeId: 'worker\0placeholder' }, { type: 'remote', nodeId: 42 },
    { type: 'remote', nodeId: 'a'.repeat(201) }, { type: 'local', nodeId: 'worker-placeholder' },
  ])('refuses malformed supplied provenance %j', value => {
    expect(() => normalizeRecoveryExecutionLocation(value)).toThrow(/execution location/i);
  });
});

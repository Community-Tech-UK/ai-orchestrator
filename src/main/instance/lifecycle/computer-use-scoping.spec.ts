import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetComputerUseModeRegistryForTesting,
  getInstanceComputerUseMode,
  removeInstanceComputerUseMode,
  resolveComputerUseAutonomy,
  setInstanceComputerUseMode,
} from './computer-use-scoping';

describe('computer-use session scoping', () => {
  beforeEach(() => {
    _resetComputerUseModeRegistryForTesting();
  });

  it('resolves a session override ahead of the global level', () => {
    expect(resolveComputerUseAutonomy('unrestricted', 'trusted')).toEqual({
      level: 'unrestricted',
      source: 'session',
    });
  });

  it('falls back to the global level when the session has no override', () => {
    expect(resolveComputerUseAutonomy(undefined, 'guarded')).toEqual({
      level: 'guarded',
      source: 'global',
    });
  });

  it('sets, clears, and removes an instance override', () => {
    setInstanceComputerUseMode('instance-a', 'unrestricted');
    expect(getInstanceComputerUseMode('instance-a')).toBe('unrestricted');

    setInstanceComputerUseMode('instance-a', undefined);
    expect(getInstanceComputerUseMode('instance-a')).toBeUndefined();

    setInstanceComputerUseMode('instance-a', 'guarded');
    removeInstanceComputerUseMode('instance-a');
    expect(getInstanceComputerUseMode('instance-a')).toBeUndefined();
  });

  it('drops every override on a process-registry reset', () => {
    setInstanceComputerUseMode('instance-a', 'unrestricted');
    setInstanceComputerUseMode('instance-b', 'guarded');

    _resetComputerUseModeRegistryForTesting();

    expect(getInstanceComputerUseMode('instance-a')).toBeUndefined();
    expect(getInstanceComputerUseMode('instance-b')).toBeUndefined();
    expect(resolveComputerUseAutonomy(undefined, 'trusted')).toEqual({
      level: 'trusted',
      source: 'global',
    });
  });

  it('evicts the oldest entry when the registry reaches its bound', () => {
    setInstanceComputerUseMode('oldest', 'unrestricted');
    for (let index = 0; index < 1_000; index += 1) {
      setInstanceComputerUseMode(`instance-${index}`, 'trusted');
    }

    expect(getInstanceComputerUseMode('oldest')).toBeUndefined();
    expect(getInstanceComputerUseMode('instance-999')).toBe('trusted');
  });
});

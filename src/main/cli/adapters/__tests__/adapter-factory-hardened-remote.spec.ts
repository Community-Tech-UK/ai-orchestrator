import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliAdapter } from '../adapter-factory';
import {
  _resetHardenedModeScopingForTesting,
  setInstanceHardened,
} from '../../../instance/lifecycle/hardened-mode-scoping';

describe('adapter factory — hardened remote execution', () => {
  beforeEach(() => _resetHardenedModeScopingForTesting());
  afterEach(() => _resetHardenedModeScopingForTesting());

  it('fails closed before constructing a remote adapter for a hardened instance', () => {
    setInstanceHardened('hardened-remote', true);

    expect(() => createCliAdapter(
      'claude',
      {
        instanceId: 'hardened-remote',
        workingDirectory: '/tmp',
      },
      {
        type: 'remote',
        nodeId: 'worker-node',
      },
    )).toThrow('Hardened mode is not supported for remote instances');
  });
});

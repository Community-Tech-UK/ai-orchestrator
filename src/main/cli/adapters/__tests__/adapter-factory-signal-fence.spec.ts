import { afterEach, describe, expect, it } from 'vitest';
import { createCliAdapter } from '../adapter-factory';
import { BaseCliAdapter } from '../base-cli-adapter';
import {
  _resetSignalFenceScopingForTesting,
  setInstanceSignalFence,
} from '../../../instance/lifecycle/signal-fence-scoping';

describe('adapter factory — per-session signal fence', () => {
  afterEach(() => _resetSignalFenceScopingForTesting());

  it.each(['claude', 'codex', 'copilot'] as const)(
    'lifts the fence only on a %s adapter whose session turned it off',
    (cliType) => {
      setInstanceSignalFence(`unfenced-${cliType}`, false);

      const unfenced = createCliAdapter(cliType, {
        instanceId: `unfenced-${cliType}`,
        workingDirectory: '/tmp',
        copilotAccountRoute: { profileId: 'legacy', source: 'legacy', executionNodeId: 'local' },
      } as never);
      const fenced = createCliAdapter(cliType, {
        instanceId: `fenced-${cliType}`,
        workingDirectory: '/tmp',
        copilotAccountRoute: { profileId: 'legacy', source: 'legacy', executionNodeId: 'local' },
      } as never);

      expect(unfenced).toBeInstanceOf(BaseCliAdapter);
      expect((unfenced as BaseCliAdapter).isSignalFenceWanted()).toBe(false);
      expect((fenced as BaseCliAdapter).isSignalFenceWanted()).toBe(true);
    },
  );
});

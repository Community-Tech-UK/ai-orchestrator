/**
 * A phone-app member's agent can write orchestration commands into its reply (spawn a helper on another computer, call
 * a connector tool, create an automation). None of them may run: each would act as the owner, outside her computer,
 * account limits and instructions.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import { InstanceOrchestrationManager } from './instance-orchestration';

vi.mock('../learning/preference-store', () => ({ getPreferenceStore: () => ({ get: () => undefined }) }));
vi.mock('../learning/strategy-learner', () => ({ StrategyLearner: { getInstance: () => ({ getRecommendation: () => ({ confidence: 0 }) }) } }));

function setup() {
  const instances = new Map<string, Instance>([
    ['hers', { id: 'hers', metadata: { mobileProfileId: 'member-1' } } as unknown as Instance],
    ['his', { id: 'his', metadata: {} } as unknown as Instance],
    ['his-from-phone', { id: 'his-from-phone', metadata: { mobileProfileId: 'owner' } } as unknown as Instance],
  ]);
  const manager = new InstanceOrchestrationManager({
    getInstance: (id) => instances.get(id), getInstanceCount: () => instances.size, getAdapter: () => undefined, sendInput: vi.fn(),
    recordTaskOutcome: vi.fn(), terminateInstance: vi.fn(), createChildInstance: vi.fn(),
  });
  const processOutput = vi.spyOn(manager.getOrchestrationHandler(), 'processOutput').mockImplementation(() => undefined);
  return { manager, processOutput };
}

describe('InstanceOrchestrationManager.processOrchestrationOutput for a phone-app member', () => {
  it("ignores everything a member's agent writes", () => {
    const { manager, processOutput } = setup();

    manager.processOrchestrationOutput('hers', '<orchestrator_command>{"action":"spawn_child"}</orchestrator_command>');

    expect(processOutput).not.toHaveBeenCalled();
  });

  it("still runs commands for the owner's sessions, including one started from the owner's phone", () => {
    const { manager, processOutput } = setup();

    manager.processOrchestrationOutput('his', 'text');
    manager.processOrchestrationOutput('his-from-phone', 'text');

    expect(processOutput).toHaveBeenCalledTimes(2);
  });
});

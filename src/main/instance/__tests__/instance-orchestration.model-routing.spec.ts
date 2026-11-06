import { describe, expect, it, vi } from 'vitest';

import { COPILOT_MODELS } from '../../../shared/types/provider.types';
import { InstanceOrchestrationManager } from '../instance-orchestration';
import { routeSpawnCommand } from '../../orchestration/scout-defaults';
import type { SpawnChildCommand } from '../../orchestration/orchestration-protocol.types';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../memory', () => ({
  getUnifiedMemory: () => ({
    recordTaskOutcome: vi.fn(),
  }),
}));

vi.mock('../../learning/outcome-tracker', () => ({
  OutcomeTracker: {
    getInstance: () => ({
      recordOutcome: vi.fn(),
    }),
  },
}));

vi.mock('../../learning/strategy-learner', () => ({
  StrategyLearner: {
    getInstance: () => ({
      getRecommendation: vi.fn(() => null),
    }),
  },
}));

vi.mock('../../learning/preference-store', () => ({
  getPreferenceStore: () => ({
    get: vi.fn(() => undefined),
  }),
}));

function createManager(): InstanceOrchestrationManager {
  return new InstanceOrchestrationManager({
    getInstance: vi.fn(),
    getInstanceCount: vi.fn(() => 0),
    createChildInstance: vi.fn(),
    sendInput: vi.fn(),
    terminateInstance: vi.fn(),
    getAdapter: vi.fn(),
    recordTaskOutcome: vi.fn(),
  });
}

describe('InstanceOrchestrationManager model routing', () => {
  it('preserves explicit Copilot concrete models instead of remapping them by tier', () => {
    const manager = createManager();

    const decision = manager.routeChildModel(
      'Check this plan and report risks',
      'Gemini 3.1 Pro',
      undefined,
      'copilot',
    );

    expect(decision.model).toBe(COPILOT_MODELS.GEMINI_3_1_PRO);
  });
});

describe('InstanceOrchestrationManager scout routing (Oct-2 Phase D Step 4)', () => {
  const spawn = (extra: Partial<SpawnChildCommand> = {}): SpawnChildCommand => ({ action: 'spawn_child', task: 'Read the auth routes and list the permission checks', ...extra });
  /** The real router, as the spawn handler passes it to `routeSpawnCommand`. */
  const route = (manager: InstanceOrchestrationManager, command: SpawnChildCommand) =>
    routeSpawnCommand(command, undefined, (model) => manager.routeChildModel(command.task, model, undefined, command.provider));

  it('runs a scout on the balanced tier and says why', () => {
    const decision = route(createManager(), spawn({ role: 'scout' }));
    expect(decision.model).toBe('sonnet');
    expect(decision.tier).toBe('balanced');
    expect(decision.reason).toBe('Scout default: balanced tier at high effort');
  });

  it('maps the scout tier onto another provider\'s balanced model', () => {
    const decision = route(createManager(), spawn({ role: 'scout', provider: 'copilot' }));
    expect(decision.tier).toBe('balanced');
    expect(decision.model).not.toBe('sonnet');
    expect(decision.model).not.toBe('');
  });

  it('lets a model the lead named win over the scout default', () => {
    const decision = route(createManager(), spawn({ role: 'scout', model: 'opus' }));
    expect(decision.model).toBe('opus');
    expect(decision.reason).not.toBe('Scout default: balanced tier at high effort');
  });

  it('leaves an ordinary spawn on automatic routing', () => {
    const manager = createManager();
    expect(route(manager, spawn()).reason).not.toBe('Scout default: balanced tier at high effort');
    expect(route(manager, spawn({ role: 'worker' as never })).reason).not.toBe('Scout default: balanced tier at high effort');
  });
});

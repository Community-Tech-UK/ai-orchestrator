import { describe, expect, it, vi } from 'vitest';

import { COPILOT_MODELS } from '../../../shared/types/provider.types';
import { InstanceOrchestrationManager } from '../instance-orchestration';

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

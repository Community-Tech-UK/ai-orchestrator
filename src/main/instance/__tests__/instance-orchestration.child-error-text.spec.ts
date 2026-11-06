import { describe, expect, it, vi } from 'vitest';

import type { Instance, OutputMessage } from '../../../shared/types/instance.types';
import { InstanceOrchestrationManager } from '../instance-orchestration';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../memory', () => ({ getUnifiedMemory: () => ({ recordTaskOutcome: vi.fn() }) }));
vi.mock('../../learning/outcome-tracker', () => ({ OutcomeTracker: { getInstance: () => ({ recordOutcome: vi.fn() }) } }));
vi.mock('../../learning/strategy-learner', () => ({ StrategyLearner: { getInstance: () => ({ getRecommendation: vi.fn(() => null) }) } }));
vi.mock('../../learning/preference-store', () => ({ getPreferenceStore: () => ({ get: vi.fn(() => undefined) }) }));
vi.mock('../../orchestration/child-result-storage', () => ({
  getChildResultStorage: () => ({ getChildSummary: vi.fn().mockResolvedValue(null) }),
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

function failedChild(errorMessage: OutputMessage): Instance {
  return { id: 'child-1', displayName: 'Child', status: 'error', createdAt: Date.now() - 1000, totalTokensUsed: 0, outputBuffer: [errorMessage] } as unknown as Instance;
}

describe('a finished child\'s failure is classified from its real reason', () => {
  it('reads the reason behind plain words, so a timeout is still a timeout', async () => {
    const child = failedChild({
      id: 'e1', timestamp: Date.now(), type: 'error',
      content: 'Claude couldn\'t finish this request. What to do: Check Details, then try again. Your message and the work above are kept.',
      metadata: { errorPresentation: { category: 'unknown', headline: 'x', whatToDo: 'y', rawDetail: 'ACP session/prompt request timed out after 600000ms' } },
    });

    const announcement = await createManager().buildAnnouncement(child, 'parent-1');

    expect(announcement?.errorClassification?.category).toBe('timeout');
  });

  it('classifies an error message with no presentation from its text, as before', async () => {
    const child = failedChild({ id: 'e2', timestamp: Date.now(), type: 'error', content: 'read ECONNRESET' });

    const announcement = await createManager().buildAnnouncement(child, 'parent-1');

    expect(announcement?.errorClassification?.category).toBe('network_error');
  });
});

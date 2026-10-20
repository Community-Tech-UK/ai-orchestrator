import { describe, expect, it } from 'vitest';
import { createInstance } from '../../shared/types/instance.types';
import { instanceToContinuityState } from './session-continuity-instance-state';

const CONFIG = { persistSessionContent: true, redactToolOutputs: false };

describe('instanceToContinuityState', () => {
  it('records internal sessions so recovery can keep them out of the user\'s list', () => {
    const nodeRun = createInstance({
      workingDirectory: '/workspace',
      metadata: { spawnDepth: 1, hideFromProjectRail: true },
    });
    const reviewer = createInstance({
      workingDirectory: '/workspace',
      metadata: { hideFromProjectRail: true },
    });

    expect(instanceToContinuityState(nodeRun, CONFIG).hideFromProjectRail).toBe(true);
    expect(instanceToContinuityState(reviewer, CONFIG).hideFromProjectRail).toBe(true);
  });

  it('records automation provenance so a crash-recovered run keeps its labels', () => {
    const automation = createInstance({
      workingDirectory: '/workspace',
      metadata: { automationId: 'automation-1', automationRunId: 'run-1', automationHidden: true },
    });

    expect(instanceToContinuityState(automation, CONFIG).automation).toEqual({
      automationId: 'automation-1',
      automationRunId: 'run-1',
      hidden: true,
    });
    expect('automation' in instanceToContinuityState(
      createInstance({ workingDirectory: '/workspace' }),
      CONFIG,
    )).toBe(false);
  });

  it('leaves the flag off ordinary and automation sessions', () => {
    const own = createInstance({ workingDirectory: '/workspace' });
    const automation = createInstance({
      workingDirectory: '/workspace',
      metadata: { automationId: 'automation-1', automationHidden: true },
    });

    expect('hideFromProjectRail' in instanceToContinuityState(own, CONFIG)).toBe(false);
    expect('hideFromProjectRail' in instanceToContinuityState(automation, CONFIG)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import {
  appendActiveGoalContext,
  buildActiveGoalContext,
  getInstanceGoalState,
} from './goal-command';

function makeInstance(metadata?: Record<string, unknown>): Instance {
  return {
    id: 'inst-1',
    provider: 'claude',
    metadata,
  } as Instance;
}

describe('legacy instance goal metadata context', () => {
  it('parses an active stored goal and builds read-only context for older sessions', () => {
    const instance = makeInstance({
      goal: {
        objective: 'finish the importer',
        status: 'active',
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    expect(getInstanceGoalState(instance)).toEqual({
      objective: 'finish the importer',
      status: 'active',
      createdAt: 1000,
      updatedAt: 1000,
    });
    expect(buildActiveGoalContext(instance)).toContain('finish the importer');
    expect(appendActiveGoalContext('existing context', instance)).toContain('existing context');
    expect(appendActiveGoalContext('existing context', instance)).toContain('## Active /goal');
  });

  it('ignores paused or malformed stored goals', () => {
    const paused = makeInstance({
      goal: {
        objective: 'finish the release',
        status: 'paused',
        createdAt: 1000,
        updatedAt: 2000,
      },
    });
    const malformed = makeInstance({
      goal: {
        objective: '',
        status: 'active',
        createdAt: 1000,
        updatedAt: 2000,
      },
    });

    expect(buildActiveGoalContext(paused)).toBeNull();
    expect(getInstanceGoalState(malformed)).toBeNull();
  });
});

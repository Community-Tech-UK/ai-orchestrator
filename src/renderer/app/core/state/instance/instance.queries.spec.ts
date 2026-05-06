import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActivityDebouncerService } from '../../services/activity-debouncer.service';
import { InstanceQueries } from './instance.queries';
import { InstanceStateService } from './instance-state.service';
import type { Instance } from './instance.types';

function createInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'inst-1',
    displayName: 'Instance 1',
    createdAt: 1,
    parentId: null,
    childrenIds: [],
    agentId: 'build',
    agentMode: 'build',
    provider: 'codex',
    status: 'idle',
    contextUsage: {
      used: 0,
      total: 200000,
      percentage: 0,
    },
    lastActivity: 2,
    sessionId: 'session-1',
    workingDirectory: '/tmp/project',
    yoloMode: false,
    outputBuffer: [],
    ...overrides,
  };
}

describe('InstanceQueries', () => {
  let queries: InstanceQueries;
  let stateService: InstanceStateService;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        InstanceQueries,
        InstanceStateService,
        {
          provide: ActivityDebouncerService,
          useValue: {
            getActivity: () => undefined,
            activities: () => new Map<string, string>(),
          },
        },
      ],
    });

    queries = TestBed.inject(InstanceQueries);
    stateService = TestBed.inject(InstanceStateService);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('resolves a selected superseded edit source to its replacement instance', () => {
    stateService.addInstance(createInstance({
      id: 'source-1',
      status: 'superseded',
      supersededBy: 'replacement-1',
      cancelledForEdit: true,
    }));
    stateService.addInstance(createInstance({
      id: 'replacement-1',
      displayName: 'Edited continuation',
      status: 'idle',
    }));
    stateService.setSelectedInstance('source-1');

    expect(queries.selectedInstance()?.id).toBe('replacement-1');
  });
});

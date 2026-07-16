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
    historyThreadId: 'thread-1',
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
    providerSessionId: 'provider-session-1',
    sessionId: 'session-1',
    restartEpoch: 0,
    workingDirectory: '/tmp/project',
    yoloMode: false,
    launchMode: 'interactive',
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

  it('groups cost by provider, summing per provider and sorting highest first', () => {
    stateService.addInstance(createInstance({
      id: 'c1', provider: 'claude',
      contextUsage: { used: 0, total: 200000, percentage: 0, costEstimate: 1.5 },
    }));
    stateService.addInstance(createInstance({
      id: 'c2', provider: 'claude',
      contextUsage: { used: 0, total: 200000, percentage: 0, costEstimate: 0.5 },
    }));
    stateService.addInstance(createInstance({
      id: 'x1', provider: 'codex',
      contextUsage: { used: 0, total: 200000, percentage: 0, costEstimate: 0.25 },
    }));
    // Zero-cost instance must not appear.
    stateService.addInstance(createInstance({
      id: 'g1', provider: 'gemini',
      contextUsage: { used: 0, total: 200000, percentage: 0, costEstimate: 0 },
    }));

    expect(queries.costByProvider()).toEqual([
      { provider: 'claude', cost: 2 },
      { provider: 'codex', cost: 0.25 },
    ]);
  });

  it('returns an empty breakdown when no instance has a cost', () => {
    stateService.addInstance(createInstance({ id: 'n1', provider: 'claude' }));
    expect(queries.costByProvider()).toEqual([]);
  });
});

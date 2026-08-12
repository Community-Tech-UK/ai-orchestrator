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

/**
 * LT-018 at fleet scope. Every instance is seeded with a placeholder
 * `{used: 0, total: 200000}` at create, so summing unconditionally made
 * `total > 0` true the instant any session existed — and the always-visible
 * sidebar rendered a confident "0% ctx" for a fleet that had simply not
 * reported yet. This is the same defect as the composer ring, and it is
 * arguably more visible because it shows regardless of which instance is focused.
 */
describe('InstanceQueries.totalContextUsage (LT-018)', () => {
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

  it('reports no occupancy when every instance is still on its seeded placeholder', () => {
    stateService.addInstance(createInstance({ id: 'a' }));
    stateService.addInstance(createInstance({ id: 'b' }));

    const total = queries.totalContextUsage();
    expect(total.occupancyReported).toBe(false);
    expect(total.total).toBe(0);
    expect(total.percentage).toBe(0);
  });

  it('counts only the instances that actually reported', () => {
    stateService.addInstance(createInstance({ id: 'placeholder' }));
    stateService.addInstance(createInstance({
      id: 'reporting',
      contextUsage: { used: 50_000, total: 200_000, percentage: 25, occupancyReported: true },
    }));

    const total = queries.totalContextUsage();
    expect(total.occupancyReported).toBe(true);
    // The placeholder's 200k window must not dilute the real one to 12.5%.
    expect(total.used).toBe(50_000);
    expect(total.total).toBe(200_000);
    expect(total.percentage).toBeCloseTo(25, 5);
  });

  it('still aggregates cost from instances that never reported occupancy', () => {
    stateService.addInstance(createInstance({
      id: 'billed',
      contextUsage: { used: 0, total: 200_000, percentage: 0, costEstimate: 1.25 },
    }));

    const total = queries.totalContextUsage();
    expect(total.occupancyReported).toBe(false);
    expect(total.costEstimate).toBeCloseTo(1.25, 5);
  });
});

/**
 * LT-034: the fleet stat is rendered as "N% ctx" in the always-visible sidebar
 * footer. An aggregate-only provider contributes cumulative spend, so summing
 * it fabricates a window figure — and one such instance is enough to pin it.
 */
describe('InstanceQueries.totalContextUsage (LT-034)', () => {
  let queries: InstanceQueries;
  let stateService: InstanceStateService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [InstanceQueries, InstanceStateService, ActivityDebouncerService],
    });
    queries = TestBed.inject(InstanceQueries);
    stateService = TestBed.inject(InstanceStateService);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('excludes an aggregate-only instance from the fleet occupancy figure', () => {
    stateService.addInstance(createInstance({
      id: 'copilot',
      contextUsage: {
        used: 190_000, total: 200_000, percentage: 95,
        occupancyReported: true, occupancyIsAggregate: true,
      },
    }));

    const total = queries.totalContextUsage();
    expect(total.occupancyReported).toBe(false);
    expect(total.percentage).toBe(0);
    expect(total.used).toBe(0);
  });

  it('does not let one aggregate instance pollute a real occupancy total', () => {
    stateService.addInstance(createInstance({
      id: 'claude',
      contextUsage: { used: 50_000, total: 200_000, percentage: 25, occupancyReported: true },
    }));
    stateService.addInstance(createInstance({
      id: 'copilot',
      contextUsage: {
        used: 190_000, total: 200_000, percentage: 95,
        occupancyReported: true, occupancyIsAggregate: true,
      },
    }));

    const total = queries.totalContextUsage();
    expect(total.used).toBe(50_000);
    expect(total.total).toBe(200_000);
    expect(total.percentage).toBe(25);
  });

  it('still counts cost from an aggregate instance — billing is independent of occupancy', () => {
    stateService.addInstance(createInstance({
      id: 'copilot',
      contextUsage: {
        used: 190_000, total: 200_000, percentage: 95,
        occupancyReported: true, occupancyIsAggregate: true, costEstimate: 1.5,
      },
    }));

    expect(queries.totalContextUsage().costEstimate).toBe(1.5);
  });
});

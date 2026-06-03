/**
 * FleetDashboardComponent – unit tests
 *
 * Strategy: test zone partitioning via the exported pure helpers and via the
 * computed signals on a shallow TestBed instance that stubs InstanceStore.
 * No IPC or sub-stores are needed.
 */

import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';

import {
  FleetDashboardComponent,
  classifyInstance,
  relativeTime,
  basename,
} from './fleet-dashboard.component';
import { InstanceStore } from '../../core/state/instance/instance.store';
import type { Instance, InstanceStatus } from '../../core/state/instance/instance.types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInstance(id: string, status: InstanceStatus, overrides: Partial<Instance> = {}): Instance {
  return {
    id,
    displayName: `Instance ${id}`,
    createdAt: 1000,
    historyThreadId: `ht-${id}`,
    parentId: null,
    childrenIds: [],
    agentId: 'build',
    agentMode: 'build',
    provider: 'claude',
    status,
    contextUsage: { used: 0, total: 200_000, percentage: 0 },
    lastActivity: Date.now() - 5_000,
    sessionId: `session-${id}`,
    providerSessionId: `ps-${id}`,
    restartEpoch: 0,
    workingDirectory: `/home/user/project-${id}`,
    yoloMode: false,
    outputBuffer: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure-helper tests (no Angular)
// ---------------------------------------------------------------------------

describe('classifyInstance', () => {
  it('maps waiting_for_permission → needs-you', () => {
    expect(classifyInstance('waiting_for_permission')).toBe('needs-you');
  });

  it('maps waiting_for_input → needs-you', () => {
    expect(classifyInstance('waiting_for_input')).toBe('needs-you');
  });

  it('maps error → needs-you', () => {
    expect(classifyInstance('error')).toBe('needs-you');
  });

  it('maps failed → needs-you', () => {
    expect(classifyInstance('failed')).toBe('needs-you');
  });

  it('maps busy → working', () => {
    expect(classifyInstance('busy')).toBe('working');
  });

  it('maps processing → working', () => {
    expect(classifyInstance('processing')).toBe('working');
  });

  it('maps thinking_deeply → working', () => {
    expect(classifyInstance('thinking_deeply')).toBe('working');
  });

  it('maps initializing → working', () => {
    expect(classifyInstance('initializing')).toBe('working');
  });

  it('maps idle → idle', () => {
    expect(classifyInstance('idle')).toBe('idle');
  });

  it('maps ready → idle', () => {
    expect(classifyInstance('ready')).toBe('idle');
  });

  it('maps terminated → idle', () => {
    expect(classifyInstance('terminated')).toBe('idle');
  });

  it('maps hibernated → idle', () => {
    expect(classifyInstance('hibernated')).toBe('idle');
  });
});

describe('relativeTime', () => {
  it('returns "just now" for < 5s', () => {
    expect(relativeTime(Date.now() - 2_000)).toBe('just now');
  });

  it('returns seconds label for < 60s', () => {
    expect(relativeTime(Date.now() - 30_000)).toBe('30s ago');
  });

  it('returns minutes label for < 60m', () => {
    expect(relativeTime(Date.now() - 5 * 60_000)).toBe('5m ago');
  });

  it('returns hours label for < 24h', () => {
    expect(relativeTime(Date.now() - 3 * 3_600_000)).toBe('3h ago');
  });

  it('returns days label for >= 24h', () => {
    expect(relativeTime(Date.now() - 2 * 86_400_000)).toBe('2d ago');
  });
});

describe('basename', () => {
  it('extracts last path segment for unix paths', () => {
    expect(basename('/home/user/my-project')).toBe('my-project');
  });

  it('strips trailing slash', () => {
    expect(basename('/home/user/project/')).toBe('project');
  });

  it('returns empty string for empty input', () => {
    expect(basename('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Component tests
// ---------------------------------------------------------------------------

describe('FleetDashboardComponent', () => {
  let component: FleetDashboardComponent;

  // Build a minimal InstanceStore stub
  function buildStoreStub(instances: Instance[], selectedId: string | null = null) {
    const _instances = signal(instances);
    const _count = signal(instances.length);
    const _selectedId = signal(selectedId);
    const setSelectedInstance = vi.fn((id: string | null) => {
      _selectedId.set(id);
    });

    return {
      instances: _instances,
      instanceCount: _count,
      selectedInstanceId: _selectedId,
      setSelectedInstance,
    };
  }

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  function setup(instances: Instance[], selectedId: string | null = null): typeof component {
    const stub = buildStoreStub(instances, selectedId);

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [FleetDashboardComponent],
      providers: [
        { provide: InstanceStore, useValue: stub },
      ],
    });

    return TestBed.createComponent(FleetDashboardComponent).componentInstance;
  }

  // ---- Zone partitioning ----

  it('places waiting_for_permission instances in needsYou zone', () => {
    component = setup([makeInstance('a', 'waiting_for_permission')]);
    expect(component.needsYou()).toHaveLength(1);
    expect(component.working()).toHaveLength(0);
    expect(component.idle()).toHaveLength(0);
  });

  it('places busy instances in working zone', () => {
    component = setup([makeInstance('b', 'busy')]);
    expect(component.needsYou()).toHaveLength(0);
    expect(component.working()).toHaveLength(1);
    expect(component.idle()).toHaveLength(0);
  });

  it('places idle instances in idle zone', () => {
    component = setup([makeInstance('c', 'idle')]);
    expect(component.needsYou()).toHaveLength(0);
    expect(component.working()).toHaveLength(0);
    expect(component.idle()).toHaveLength(1);
  });

  it('partitions a mixed list across all three zones correctly', () => {
    const instances = [
      makeInstance('n1', 'waiting_for_permission'),
      makeInstance('n2', 'error'),
      makeInstance('w1', 'busy'),
      makeInstance('w2', 'processing'),
      makeInstance('i1', 'idle'),
      makeInstance('i2', 'terminated'),
      makeInstance('i3', 'ready'),
    ];
    component = setup(instances);

    expect(component.needsYou()).toHaveLength(2);
    expect(component.working()).toHaveLength(2);
    expect(component.idle()).toHaveLength(3);
  });

  // ---- Zone counts ----

  it('zone counts sum to total instance count', () => {
    const instances = [
      makeInstance('a', 'waiting_for_input'),
      makeInstance('b', 'busy'),
      makeInstance('c', 'idle'),
      makeInstance('d', 'terminated'),
    ];
    component = setup(instances);

    const total = component.needsYou().length + component.working().length + component.idle().length;
    expect(total).toBe(instances.length);
  });

  // ---- Empty state ----

  it('all zones empty when no instances exist', () => {
    component = setup([]);
    expect(component.needsYou()).toHaveLength(0);
    expect(component.working()).toHaveLength(0);
    expect(component.idle()).toHaveLength(0);
  });

  // ---- Select action ----

  it('calls store.setSelectedInstance when selectInstance is called', () => {
    const stub = buildStoreStub([makeInstance('x1', 'idle')]);

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [FleetDashboardComponent],
      providers: [{ provide: InstanceStore, useValue: stub }],
    });

    component = TestBed.createComponent(FleetDashboardComponent).componentInstance;
    component.selectInstance('x1');

    expect(stub.setSelectedInstance).toHaveBeenCalledWith('x1');
  });

  // ---- Toggle zone ----

  it('needs-you and working zones start expanded; idle starts collapsed', () => {
    component = setup([]);
    expect(component['expandedZones']().has('needs-you')).toBe(true);
    expect(component['expandedZones']().has('working')).toBe(true);
    expect(component['expandedZones']().has('idle')).toBe(false);
  });

  it('toggleZone collapses an open zone and expands a closed one', () => {
    component = setup([]);

    // collapse needs-you
    component.toggleZone('needs-you');
    expect(component['expandedZones']().has('needs-you')).toBe(false);

    // expand idle
    component.toggleZone('idle');
    expect(component['expandedZones']().has('idle')).toBe(true);
  });
});

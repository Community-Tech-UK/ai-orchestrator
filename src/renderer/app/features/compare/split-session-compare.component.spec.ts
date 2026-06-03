/**
 * Split Session Compare – unit tests
 *
 * Tests cover:
 *   1. pickPaneDefaults() pure helper
 *   2. Signal-level pane-selection behaviour via direct signal manipulation
 *      (no TestBed — avoids the full component bootstrap chain).
 */

import { describe, it, expect } from 'vitest';
import { signal, computed } from '@angular/core';
import { pickPaneDefaults } from './split-session-compare.component';
import type { Instance } from '../../core/state/instance/instance.types';

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

function makeInstance(id: string, displayName = `Agent ${id}`): Instance {
  return {
    id,
    displayName,
    createdAt: Date.now(),
    historyThreadId: id,
    parentId: null,
    childrenIds: [],
    agentId: 'build',
    agentMode: 'build',
    provider: 'claude',
    status: 'idle',
    contextUsage: { used: 0, total: 200_000, percentage: 0 },
    lastActivity: Date.now(),
    providerSessionId: id,
    sessionId: id,
    restartEpoch: 0,
    workingDirectory: '/tmp',
    yoloMode: false,
    outputBuffer: [],
  } as unknown as Instance;
}

/**
 * Minimal mock of the InstanceStore's relevant surface:
 *   - instances: WritableSignal<Instance[]>
 *   - getInstance(id): Instance | null
 */
function makeStoreMock(initialInstances: Instance[] = []) {
  const _instances = signal<Instance[]>(initialInstances);
  return {
    instances: _instances.asReadonly(),
    getInstance: (id: string) => _instances().find(i => i.id === id) ?? null,
    _set: (list: Instance[]) => _instances.set(list),
  };
}

// ────────────────────────────────────────────────────────────────
// 1. pickPaneDefaults()
// ────────────────────────────────────────────────────────────────

describe('pickPaneDefaults()', () => {
  it('returns [null, null] for an empty list', () => {
    expect(pickPaneDefaults([])).toEqual([null, null]);
  });

  it('returns [first.id, null] when only one instance exists', () => {
    const [left, right] = pickPaneDefaults([makeInstance('a')]);
    expect(left).toBe('a');
    expect(right).toBeNull();
  });

  it('returns [first.id, second.id] when two or more instances exist', () => {
    const [left, right] = pickPaneDefaults([
      makeInstance('alpha'),
      makeInstance('beta'),
      makeInstance('gamma'),
    ]);
    expect(left).toBe('alpha');
    expect(right).toBe('beta');
  });
});

// ────────────────────────────────────────────────────────────────
// 2. Pane-selection signal logic (no TestBed)
// ────────────────────────────────────────────────────────────────

describe('Pane selection signals (logic-level)', () => {
  it('selecting an instance in a pane reflects in the pane signal', () => {
    const leftId = signal<string | null>(null);
    leftId.set('inst-1');
    expect(leftId()).toBe('inst-1');
  });

  it('two pane signals are independent', () => {
    const leftId = signal<string | null>(null);
    const rightId = signal<string | null>(null);

    leftId.set('inst-A');
    rightId.set('inst-B');

    expect(leftId()).toBe('inst-A');
    expect(rightId()).toBe('inst-B');
  });

  it('instance lookup returns correct outputBuffer via computed', () => {
    const inst = makeInstance('x');
    inst.outputBuffer = [
      {
        id: 'msg-1',
        timestamp: 1000,
        type: 'assistant',
        content: 'hello',
      },
    ] as unknown as Instance['outputBuffer'];

    const store = makeStoreMock([inst]);
    const selectedId = signal<string | null>('x');

    const resolvedInstance = computed(() => {
      const id = selectedId();
      return id ? store.getInstance(id) : null;
    });

    const messages = computed(() => resolvedInstance()?.outputBuffer ?? []);

    expect(messages()).toHaveLength(1);
    expect(messages()[0].content).toBe('hello');
  });

  it('messages computed returns empty array when no instance is selected', () => {
    const store = makeStoreMock([makeInstance('z')]);
    const selectedId = signal<string | null>(null);
    const messages = computed(
      () => (selectedId() ? store.getInstance(selectedId()!)?.outputBuffer : null) ?? []
    );
    expect(messages()).toEqual([]);
  });

  it('seeding defaults: both panes null → get first two instances', () => {
    const instances = [makeInstance('p1'), makeInstance('p2'), makeInstance('p3')];
    const leftId = signal<string | null>(null);
    const rightId = signal<string | null>(null);

    // Simulate the seeding effect
    if (instances.length > 0 && leftId() === null && rightId() === null) {
      const [defaultLeft, defaultRight] = pickPaneDefaults(instances);
      leftId.set(defaultLeft);
      rightId.set(defaultRight);
    }

    expect(leftId()).toBe('p1');
    expect(rightId()).toBe('p2');
  });

  it('seeding defaults: does NOT override an already-set pane', () => {
    const instances = [makeInstance('q1'), makeInstance('q2')];
    const leftId = signal<string | null>('custom');
    const rightId = signal<string | null>(null);

    // Seeding condition: only seeds when BOTH are null
    if (instances.length > 0 && leftId() === null && rightId() === null) {
      const [defaultLeft, defaultRight] = pickPaneDefaults(instances);
      leftId.set(defaultLeft);
      rightId.set(defaultRight);
    }

    // leftId was 'custom', not null, so the condition was false
    expect(leftId()).toBe('custom');
    expect(rightId()).toBeNull();
  });

  it('switching pane selection updates the resolved instance', () => {
    const inst1 = makeInstance('s1');
    const inst2 = makeInstance('s2');
    const store = makeStoreMock([inst1, inst2]);

    const selectedId = signal<string | null>('s1');
    const resolved = computed(() => {
      const id = selectedId();
      return id ? store.getInstance(id) : null;
    });

    expect(resolved()?.id).toBe('s1');
    selectedId.set('s2');
    expect(resolved()?.id).toBe('s2');
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { OrchestrationSnapshotManager } from '../orchestration-snapshot';

describe('OrchestrationSnapshotManager', () => {
  beforeEach(() => {
    OrchestrationSnapshotManager._resetForTesting();
  });

  it('should provide an empty snapshot initially', () => {
    const manager = OrchestrationSnapshotManager.getInstance();
    const snapshot = manager.getSnapshot();
    expect(Object.keys(snapshot.activeChildren)).toHaveLength(0);
    expect(snapshot.activeDebates).toHaveLength(0);
  });

  it('should track active children', () => {
    const manager = OrchestrationSnapshotManager.getInstance();
    manager.addChild('parent-1', {
      childId: 'child-1', parentId: 'parent-1', name: 'Worker',
      status: 'busy', createdAt: Date.now(), tokensUsed: 0,
    });
    const children = manager.getSnapshot().activeChildren['parent-1'];
    expect(children).toHaveLength(1);
    expect(children[0].childId).toBe('child-1');
  });

  it('should remove children', () => {
    const manager = OrchestrationSnapshotManager.getInstance();
    manager.addChild('parent-1', {
      childId: 'child-1', parentId: 'parent-1', name: 'Worker',
      status: 'busy', createdAt: Date.now(), tokensUsed: 0,
    });
    manager.removeChild('parent-1', 'child-1');
    expect(manager.getSnapshot().activeChildren['parent-1'] ?? []).toHaveLength(0);
  });

  it('should update child status', () => {
    const manager = OrchestrationSnapshotManager.getInstance();
    manager.addChild('parent-1', {
      childId: 'child-1', parentId: 'parent-1', name: 'Worker',
      status: 'busy', createdAt: Date.now(), tokensUsed: 0,
    });
    manager.updateChild('parent-1', 'child-1', { status: 'idle', tokensUsed: 500 });
    const child = manager.getSnapshot().activeChildren['parent-1'][0];
    expect(child.status).toBe('idle');
    expect(child.tokensUsed).toBe(500);
  });

  it('should return a copy not a reference', () => {
    const manager = OrchestrationSnapshotManager.getInstance();
    const s1 = manager.getSnapshot();
    const s2 = manager.getSnapshot();
    expect(s1).not.toBe(s2);
  });
});

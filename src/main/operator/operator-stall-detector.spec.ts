import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { createOperatorTables } from './operator-schema';
import { OperatorRunStore } from './operator-run-store';
import { OperatorStallDetector } from './operator-stall-detector';

describe('OperatorStallDetector', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('blocks running nodes that exceed their stall threshold without progress', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const db = defaultDriverFactory(':memory:');
    createOperatorTables(db);
    const runStore = new OperatorRunStore(db);
    const run = runStore.createRun({
      threadId: 'thread-1',
      sourceMessageId: 'message-1',
      title: 'Pull repositories',
      goal: 'Please pull all repos',
    });
    const node = runStore.createNode({
      runId: run.id,
      type: 'git-batch',
      title: 'Pull repositories',
      targetPath: '/work',
    });
    runStore.updateRun(run.id, { status: 'running' });
    runStore.updateNode(node.id, { status: 'running' });
    vi.setSystemTime(1_500);
    runStore.appendEvent({
      runId: run.id,
      nodeId: node.id,
      kind: 'progress',
      payload: { message: 'started' },
    });

    vi.setSystemTime(7_000);
    const detector = new OperatorStallDetector({
      runStore,
      now: () => Date.now(),
      thresholds: { 'git-batch': 5_000 },
    });

    const blocked = detector.checkOnce();
    const graph = runStore.getRunGraph(run.id);

    expect(blocked).toEqual([
      expect.objectContaining({
        runId: run.id,
        nodeId: node.id,
        nodeType: 'git-batch',
        stallMs: 5_500,
        thresholdMs: 5_000,
      }),
    ]);
    expect(graph?.run).toMatchObject({
      status: 'blocked',
      error: 'Operator node stalled: git-batch exceeded 5000ms without progress',
    });
    expect(graph?.nodes[0]).toMatchObject({
      status: 'blocked',
      error: 'Operator node stalled: git-batch exceeded 5000ms without progress',
      completedAt: 7_000,
    });
    expect(graph?.events).toContainEqual(expect.objectContaining({
      kind: 'recovery',
      nodeId: node.id,
      payload: expect.objectContaining({
        reason: 'stalled-node',
        action: 'blocked',
        stallMs: 5_500,
        thresholdMs: 5_000,
      }),
    }));
    db.close();
  });

  it('keeps running nodes active when recent progress is inside the threshold', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const db = defaultDriverFactory(':memory:');
    createOperatorTables(db);
    const runStore = new OperatorRunStore(db);
    const run = runStore.createRun({
      threadId: 'thread-1',
      sourceMessageId: 'message-1',
      title: 'Pull repositories',
      goal: 'Please pull all repos',
    });
    const node = runStore.createNode({
      runId: run.id,
      type: 'git-batch',
      title: 'Pull repositories',
      targetPath: '/work',
    });
    runStore.updateRun(run.id, { status: 'running' });
    runStore.updateNode(node.id, { status: 'running' });
    vi.setSystemTime(6_500);
    runStore.appendEvent({
      runId: run.id,
      nodeId: node.id,
      kind: 'progress',
      payload: { message: 'still working' },
    });

    vi.setSystemTime(7_000);
    const detector = new OperatorStallDetector({
      runStore,
      now: () => Date.now(),
      thresholds: { 'git-batch': 5_000 },
    });

    expect(detector.checkOnce()).toEqual([]);
    expect(runStore.getRunGraph(run.id)?.run.status).toBe('running');
    expect(runStore.getRunGraph(run.id)?.nodes[0]?.status).toBe('running');
    db.close();
  });
});

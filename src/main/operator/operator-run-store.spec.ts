import { describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { createOperatorTables } from './operator-schema';
import { OperatorRunStore } from './operator-run-store';

describe('OperatorRunStore', () => {
  it('persists runs, nodes, events, budgets, and terminal results', () => {
    const db = defaultDriverFactory(':memory:');
    createOperatorTables(db);
    const store = new OperatorRunStore(db);

    const run = store.createRun({
      threadId: 'thread-1',
      sourceMessageId: 'message-1',
      title: 'Pull all repos',
      goal: 'Please pull all repos in my work folder',
      planJson: { intent: 'workspace_git_batch' },
    });
    const node = store.createNode({
      runId: run.id,
      type: 'git-batch',
      title: 'Pull repositories',
      targetPath: '/work',
      inputJson: { rootPath: '/work' },
    });
    store.appendEvent({
      runId: run.id,
      nodeId: node.id,
      kind: 'shell-command',
      payload: {
        cmd: 'git',
        args: ['fetch', '--prune'],
        cwd: '/work/app',
        exitCode: 0,
        durationMs: 10,
        stdoutBytes: 0,
        stderrBytes: 0,
      },
    });
    store.updateNode(node.id, {
      status: 'completed',
      outputJson: { pulled: 1 },
      completedAt: 2,
    });
    store.updateRun(run.id, {
      status: 'completed',
      resultJson: { summary: 'Pulled 1 repo' },
      completedAt: 3,
    });

    const graph = store.getRunGraph(run.id);

    expect(graph?.run).toMatchObject({
      id: run.id,
      status: 'completed',
      budget: {
        maxNodes: 50,
        maxRetries: 3,
        maxConcurrentNodes: 3,
      },
      usageJson: {
        nodesStarted: 0,
        nodesCompleted: 0,
        retriesUsed: 0,
      },
      resultJson: { summary: 'Pulled 1 repo' },
    });
    expect(graph?.nodes).toEqual([
      expect.objectContaining({
        id: node.id,
        status: 'completed',
        type: 'git-batch',
        outputJson: { pulled: 1 },
      }),
    ]);
    expect(graph?.events).toEqual([
      expect.objectContaining({
        kind: 'shell-command',
        payload: expect.objectContaining({ cmd: 'git' }),
      }),
    ]);
    db.close();
  });

  it('persists operator instance links as the recovery source of truth', () => {
    const db = defaultDriverFactory(':memory:');
    createOperatorTables(db);
    const store = new OperatorRunStore(db);
    const run = store.createRun({
      threadId: 'thread-1',
      sourceMessageId: 'message-1',
      title: 'Implement feature',
      goal: 'Implement voice conversations',
    });
    const node = store.createNode({
      runId: run.id,
      type: 'project-agent',
      title: 'AI Orchestrator worker',
      targetPath: '/work/ai-orchestrator',
    });

    const linked = store.upsertInstanceLink({
      instanceId: 'instance-1',
      runId: run.id,
      nodeId: node.id,
    });
    store.touchInstanceLink('instance-1', 'recovered');

    expect(linked).toMatchObject({
      instanceId: 'instance-1',
      runId: run.id,
      nodeId: node.id,
      recoveryState: 'active',
    });
    expect(store.getInstanceLink('instance-1')).toMatchObject({
      instanceId: 'instance-1',
      recoveryState: 'recovered',
    });
    expect(store.listInstanceLinksForRun(run.id)).toEqual([
      expect.objectContaining({
        instanceId: 'instance-1',
        nodeId: node.id,
      }),
    ]);
    db.close();
  });
});

import { describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import * as schema from '../persistence/rlm/rlm-schema';
import {
  getProjectKnowledgeSourceInventory,
  listProjectKnowledgeLinks,
  listProjectKnowledgeSources,
} from '../persistence/rlm/rlm-project-knowledge';
import type {
  OperatorProjectRecord,
  OperatorRunGraph,
} from '../../shared/types/operator.types';
import { OperatorMemoryPromoter } from './operator-memory-promoter';

describe('OperatorMemoryPromoter', () => {
  it('promotes completed operator synthesis into project memory with source links', () => {
    const db = defaultDriverFactory(':memory:');
    schema.createTables(db);
    schema.createMigrationsTable(db);
    schema.runMigrations(db);
    const promoter = new OperatorMemoryPromoter({ db, now: () => 1_000 });

    const results = promoter.promote({
      graph: completedGraph(),
      projects: [projectRecord()],
    });

    expect(results).toEqual([
      expect.objectContaining({
        projectId: 'project-1',
        projectKey: '/work/ai-orchestrator',
        sourceCreated: true,
        sourceChanged: false,
        linkCreated: true,
      }),
    ]);
    expect(listProjectKnowledgeSources(db, '/work/ai-orchestrator')).toEqual([
      expect.objectContaining({
        sourceKind: 'operator_result',
        sourceUri: 'operator://runs/run-1/projects/project-1',
        sourceTitle: 'Implement voice',
        metadata: expect.objectContaining({
          operatorRunId: 'run-1',
          projectId: 'project-1',
        }),
      }),
    ]);
    expect(listProjectKnowledgeLinks(db, '/work/ai-orchestrator')).toEqual([
      expect.objectContaining({
        targetKind: 'wake_hint',
        evidenceStrength: 0.9,
      }),
    ]);
    expect(getProjectKnowledgeSourceInventory(db, '/work/ai-orchestrator').byKind).toMatchObject({
      operator_result: 1,
    });
    const hint = db.prepare('SELECT * FROM wake_hints WHERE room = ?')
      .get<{ content: string }>('/work/ai-orchestrator');
    expect(hint?.content).toContain('Operator completed "Implement voice"');
    expect(hint?.content).toContain('Verification: passed');
    db.close();
  });

  it('does not promote non-completed runs', () => {
    const db = defaultDriverFactory(':memory:');
    schema.createTables(db);
    schema.createMigrationsTable(db);
    schema.runMigrations(db);
    const promoter = new OperatorMemoryPromoter({ db });
    const graph = completedGraph();

    expect(promoter.promote({
      graph: {
        ...graph,
        run: {
          ...graph.run,
          status: 'failed',
        },
      },
      projects: [projectRecord()],
    })).toEqual([]);
    expect(listProjectKnowledgeSources(db, '/work/ai-orchestrator')).toEqual([]);
    db.close();
  });
});

function completedGraph(): OperatorRunGraph {
  return {
    run: {
      id: 'run-1',
      threadId: 'thread-1',
      sourceMessageId: 'message-1',
      title: 'Implement voice',
      status: 'completed',
      autonomyMode: 'full',
      createdAt: 1,
      updatedAt: 2,
      completedAt: 3,
      goal: 'Implement voice conversations',
      budget: {
        maxNodes: 50,
        maxRetries: 3,
        maxWallClockMs: 1_000,
        maxConcurrentNodes: 1,
      },
      usageJson: {
        nodesStarted: 3,
        nodesCompleted: 3,
        retriesUsed: 0,
        wallClockMs: 100,
      },
      planJson: {
        intent: 'project_feature',
      },
      resultJson: {
        synthesis: {
          status: 'completed',
          summaryMarkdown: 'Completed:\n- Implemented voice conversations\n- Verification: passed',
          completedWork: ['Implemented voice conversations', 'Verification: passed'],
          skippedWork: [],
          failedWork: [],
          verification: 'Verification: passed',
        },
      },
      error: null,
    },
    nodes: [],
    events: [],
  };
}

function projectRecord(): OperatorProjectRecord {
  return {
    id: 'project-1',
    canonicalPath: '/work/ai-orchestrator',
    displayName: 'AI Orchestrator',
    aliases: ['AI Orchestrator'],
    source: 'scan',
    gitRoot: '/work/ai-orchestrator',
    remotes: [],
    currentBranch: 'main',
    isPinned: false,
    lastSeenAt: 1,
    lastAccessedAt: 1,
    metadata: {},
  };
}

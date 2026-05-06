import { describe, expect, it, vi } from 'vitest';
import { createInstance as createInstanceRecord } from '../../shared/types/instance.types';
import type { OperatorProjectRecord } from '../../shared/types/operator.types';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { createOperatorTables } from './operator-schema';
import { OperatorRunStore } from './operator-run-store';
import { ProjectAgentExecutor } from './operator-project-agent-executor';

describe('ProjectAgentExecutor', () => {
  it('spawns a linked project worker and waits for the instance to settle', async () => {
    const db = defaultDriverFactory(':memory:');
    createOperatorTables(db);
    const runStore = new OperatorRunStore(db);
    const run = runStore.createRun({
      threadId: 'thread-1',
      sourceMessageId: 'message-1',
      title: 'Implement voice',
      goal: 'In AI Orchestrator, implement voice conversations',
    });
    const node = runStore.createNode({
      runId: run.id,
      type: 'project-agent',
      title: 'AI Orchestrator worker',
      targetProjectId: 'project-1',
      targetPath: '/work/ai-orchestrator',
    });
    const settled = createInstanceRecord({
      workingDirectory: '/work/ai-orchestrator',
      provider: 'codex',
    });
    settled.id = 'instance-1';
    settled.status = 'idle';
    settled.outputBuffer = [{
      id: 'assistant-1',
      timestamp: 2,
      type: 'assistant',
      content: 'Implemented voice conversations and verified tests.',
    }];
    settled.diffStats = {
      totalAdded: 12,
      totalDeleted: 3,
      files: {
        '/work/ai-orchestrator/src/main/voice.ts': {
          path: '/work/ai-orchestrator/src/main/voice.ts',
          status: 'modified',
          added: 12,
          deleted: 3,
        },
      },
    };
    const instanceManager = {
      createInstance: vi.fn(async (config) => {
        const instance = createInstanceRecord(config);
        instance.id = 'instance-1';
        instance.createdAt = 1;
        return instance;
      }),
      waitForInstanceSettled: vi.fn(async () => settled),
    };
    const executor = new ProjectAgentExecutor({ runStore, instanceManager });

    const result = await executor.execute({
      run,
      node,
      project: projectRecord(),
      goal: 'I want to allow voice conversations, please implement it',
    });

    expect(instanceManager.createInstance).toHaveBeenCalledWith(expect.objectContaining({
      workingDirectory: '/work/ai-orchestrator',
      displayName: 'Operator: AI Orchestrator',
      agentId: 'build',
      yoloMode: true,
      metadata: {
        source: 'operator',
        operatorRunId: run.id,
        operatorNodeId: node.id,
        operatorProjectId: 'project-1',
      },
    }));
    expect(instanceManager.createInstance.mock.calls[0]?.[0].initialPrompt).toContain(
      'I want to allow voice conversations, please implement it',
    );
    expect(instanceManager.createInstance.mock.calls[0]?.[0].initialPrompt).toContain(
      'Suggested verification',
    );
    expect(instanceManager.waitForInstanceSettled).toHaveBeenCalledWith('instance-1', expect.objectContaining({
      afterTimestamp: 1,
    }));
    expect(runStore.getInstanceLink('instance-1')).toMatchObject({
      instanceId: 'instance-1',
      runId: run.id,
      nodeId: node.id,
      recoveryState: 'active',
    });
    expect(result).toMatchObject({
      status: 'completed',
      externalRefKind: 'instance',
      externalRefId: 'instance-1',
      outputJson: {
        instanceId: 'instance-1',
        finalStatus: 'idle',
        outputPreview: 'Implemented voice conversations and verified tests.',
        changedFiles: ['/work/ai-orchestrator/src/main/voice.ts'],
        diffStats: {
          totalAdded: 12,
          totalDeleted: 3,
        },
      },
      error: null,
    });
    db.close();
  });

  it('uses an explicit prompt override without changing worker metadata or linking', async () => {
    const db = defaultDriverFactory(':memory:');
    createOperatorTables(db);
    const runStore = new OperatorRunStore(db);
    const run = runStore.createRun({
      threadId: 'thread-1',
      sourceMessageId: 'message-1',
      title: 'Repair verification',
      goal: 'Fix the failed verification',
    });
    const node = runStore.createNode({
      runId: run.id,
      type: 'project-agent',
      title: 'AI Orchestrator repair worker',
      targetProjectId: 'project-1',
      targetPath: '/work/ai-orchestrator',
    });
    const instanceManager = {
      createInstance: vi.fn(async (config) => {
        const instance = createInstanceRecord(config);
        instance.id = 'instance-override';
        instance.createdAt = 10;
        return instance;
      }),
      waitForInstanceSettled: vi.fn(async (instanceId: string) => {
        const settled = createInstanceRecord({
          workingDirectory: '/work/ai-orchestrator',
          provider: 'codex',
        });
        settled.id = instanceId;
        settled.status = 'idle';
        return settled;
      }),
    };
    const executor = new ProjectAgentExecutor({ runStore, instanceManager });

    await executor.execute({
      run,
      node,
      project: projectRecord(),
      goal: 'Fix the failed verification',
      promptOverride: 'Use this exact repair prompt.',
    });

    expect(instanceManager.createInstance).toHaveBeenCalledWith(expect.objectContaining({
      initialPrompt: 'Use this exact repair prompt.',
      metadata: {
        source: 'operator',
        operatorRunId: run.id,
        operatorNodeId: node.id,
        operatorProjectId: 'project-1',
      },
    }));
    expect(runStore.getInstanceLink('instance-override')).toMatchObject({
      instanceId: 'instance-override',
      runId: run.id,
      nodeId: node.id,
      recoveryState: 'active',
    });
    db.close();
  });

  it('passes operator routing decisions to the spawned worker', async () => {
    const db = defaultDriverFactory(':memory:');
    createOperatorTables(db);
    const runStore = new OperatorRunStore(db);
    const run = runStore.createRun({
      threadId: 'thread-1',
      sourceMessageId: 'message-1',
      title: 'Implement voice',
      goal: 'Implement voice conversations',
    });
    const node = runStore.createNode({
      runId: run.id,
      type: 'project-agent',
      title: 'AI Orchestrator worker',
      targetProjectId: 'project-1',
      targetPath: '/work/ai-orchestrator',
    });
    const instanceManager = {
      createInstance: vi.fn(async (config) => {
        const instance = createInstanceRecord(config);
        instance.id = 'instance-routed';
        instance.createdAt = 1;
        return instance;
      }),
      waitForInstanceSettled: vi.fn(async (instanceId: string) => {
        const settled = createInstanceRecord({
          workingDirectory: '/work/ai-orchestrator',
          provider: 'codex',
        });
        settled.id = instanceId;
        settled.status = 'idle';
        return settled;
      }),
    };
    const executor = new ProjectAgentExecutor({ runStore, instanceManager });

    await executor.execute({
      run,
      node,
      project: projectRecord(),
      goal: 'Implement voice conversations',
      routing: {
        provider: 'codex',
        modelOverride: 'gpt-5.5',
        reasoningEffort: 'high',
        nodePlacement: {
          requiresCli: 'codex',
          requiresWorkingDirectory: '/work/ai-orchestrator',
        },
        audit: {
          source: 'operator-routing',
          reason: 'Implementation task routed to powerful Codex model',
          remoteEligible: true,
          memoryPromotionEligible: true,
          automationFollowUpEligible: false,
        },
      },
    });

    expect(instanceManager.createInstance).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'codex',
      modelOverride: 'gpt-5.5',
      reasoningEffort: 'high',
      nodePlacement: {
        requiresCli: 'codex',
        requiresWorkingDirectory: '/work/ai-orchestrator',
      },
      metadata: expect.objectContaining({
        operatorRouting: {
          source: 'operator-routing',
          reason: 'Implementation task routed to powerful Codex model',
          remoteEligible: true,
          memoryPromotionEligible: true,
          automationFollowUpEligible: false,
        },
      }),
    }));
    db.close();
  });
});

function projectRecord(): OperatorProjectRecord {
  return {
    id: 'project-1',
    canonicalPath: '/work/ai-orchestrator',
    displayName: 'AI Orchestrator',
    aliases: ['AI Orchestrator', 'ai-orchestrator'],
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

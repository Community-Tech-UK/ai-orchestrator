import { afterEach, describe, expect, it } from 'vitest';
import { ConversationLedgerService } from '../../conversation-ledger';
import { NativeConversationRegistry } from '../../conversation-ledger/native-conversation-registry';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { ChatStore } from '../../chats/chat-store';
import { createOperatorTables } from '../../operator/operator-schema';
import {
  GitBatchCancelledError,
  GitBatchService,
  type GitBatchPullOptions,
} from '../../operator/git-batch-service';
import { OperatorRunStore } from '../../operator/operator-run-store';
import type { OperatorGitBatchSummary } from '../../../shared/types/operator.types';
import { createOrchestratorToolDefinitions } from '../orchestrator-tools';

describe('orchestrator MCP tools', () => {
  const ledgers: ConversationLedgerService[] = [];
  const dbs: SqliteDriver[] = [];

  afterEach(async () => {
    for (const ledger of ledgers) await ledger.close();
    ledgers.length = 0;
    for (const db of dbs) db.close();
    dbs.length = 0;
  });

  it('creates an auditable operator run when git_batch_pull is invoked from a chat instance', async () => {
    const db = createDb();
    const ledger = createLedger();
    const chatStore = new ChatStore(db);
    const conversation = await ledger.startConversation({
      provider: 'orchestrator',
      title: 'Tool chat',
      metadata: { chatId: 'chat-1', scope: 'chat', operatorThreadKind: 'chat' },
    });
    const userMessage = (await ledger.appendMessage(conversation.id, {
      role: 'user',
      phase: null,
      content: 'Pull the repositories',
      createdAt: Date.now(),
    })).messages[0];
    const toolCallMessage = (await ledger.appendMessage(conversation.id, {
      role: 'assistant',
      phase: 'tool_call',
      content: 'git_batch_pull({"root":"/work"})',
      createdAt: Date.now(),
      rawJson: {
        metadata: {
          kind: 'tool_call',
          toolName: 'git_batch_pull',
        },
      },
    })).messages[1];
    chatStore.insert({
      id: 'chat-1',
      name: 'Tool chat',
      provider: 'claude',
      currentCwd: '/work',
      ledgerThreadId: conversation.id,
      currentInstanceId: 'inst-1',
    });

    const [tool] = createOrchestratorToolDefinitions({
      db,
      ledger,
      instanceId: 'inst-1',
      gitBatchService: new FakeGitBatchService(),
    });
    const result = await tool.handler({
      root: '/work',
      ignore: ['node_modules'],
      concurrency: 2,
    }) as { runId: string; nodeId: string; total: number };

    expect(result.total).toBe(1);
    const graph = new OperatorRunStore(db).getRunGraph(result.runId);
    expect(graph?.run).toMatchObject({
      status: 'completed',
      threadId: conversation.id,
      sourceMessageId: toolCallMessage.id,
      resultJson: {
        summary: expect.objectContaining({
          rootPath: '/work',
          total: 1,
          pulled: 1,
        }),
      },
    });
    expect(graph?.run.sourceMessageId).not.toBe(userMessage.id);
    expect(graph?.run.planJson).toMatchObject({
      tool: 'git_batch_pull',
      chatId: 'chat-1',
      instanceId: 'inst-1',
      messageId: toolCallMessage.id,
    });
    expect(graph?.nodes).toEqual([
      expect.objectContaining({
        id: result.nodeId,
        type: 'git-batch',
        status: 'completed',
        targetPath: '/work',
        inputJson: expect.objectContaining({
          root: '/work',
          ignore: ['node_modules'],
          concurrency: 2,
          chatId: 'chat-1',
          instanceId: 'inst-1',
          messageId: toolCallMessage.id,
        }),
        outputJson: {
          summary: expect.objectContaining({
            pulled: 1,
          }),
        },
      }),
    ]);
    expect(graph?.events).toContainEqual(expect.objectContaining({
      kind: 'shell-command',
      payload: expect.objectContaining({
        cmd: 'git',
        args: ['pull', '--ff-only'],
        cwd: '/work/repo',
      }),
    }));
  });

  it('records a cancelled operator run when git_batch_pull observes cancellation', async () => {
    const db = createDb();
    const ledger = createLedger();
    const chatStore = new ChatStore(db);
    const conversation = await ledger.startConversation({
      provider: 'orchestrator',
      title: 'Tool chat',
      metadata: { chatId: 'chat-1', scope: 'chat', operatorThreadKind: 'chat' },
    });
    chatStore.insert({
      id: 'chat-1',
      name: 'Tool chat',
      provider: 'claude',
      currentCwd: '/work',
      ledgerThreadId: conversation.id,
      currentInstanceId: 'inst-1',
    });

    const [tool] = createOrchestratorToolDefinitions({
      db,
      ledger,
      instanceId: 'inst-1',
      gitBatchService: new CancellingGitBatchService(db),
    });
    const result = await tool.handler({ root: '/work' }) as {
      runId: string;
      nodeId: string;
      status: string;
      cancelled: boolean;
    };

    expect(result).toMatchObject({
      status: 'cancelled',
      cancelled: true,
    });
    const graph = new OperatorRunStore(db).getRunGraph(result.runId);
    expect(graph?.run.status).toBe('cancelled');
    expect(graph?.run.error).toBe('Cancelled by user');
    expect(graph?.nodes[0]).toMatchObject({
      id: result.nodeId,
      status: 'cancelled',
      error: 'Cancelled by user',
    });
    expect(graph?.events).toContainEqual(expect.objectContaining({
      kind: 'state-change',
      payload: expect.objectContaining({
        status: 'cancelled',
        error: 'Cancelled by user',
      }),
    }));
  });

  it('list_remote_nodes returns sanitized remote worker status and capabilities', async () => {
    const db = createDb();
    const tools = createOrchestratorToolDefinitions({
      db,
      instanceId: null,
      listRemoteNodes: async () => ({
        connectedCount: 1,
        totalCount: 2,
        nodes: [
          {
            id: 'node-1',
            name: 'windows-pc',
            status: 'connected',
            platform: 'win32',
            arch: 'x64',
            supportedClis: ['claude', 'codex'],
            hasBrowserRuntime: true,
            hasBrowserMcp: true,
            hasDocker: false,
            gpuName: 'NVIDIA RTX 4090',
            gpuMemoryMB: 24576,
            activeInstances: 1,
            maxConcurrentInstances: 4,
            workingDirectories: ['C:/Users/James/projects'],
            lastHeartbeat: 1234,
            latencyMs: 18,
          },
          {
            id: 'node-2',
            name: 'linux-box',
            status: 'degraded',
            platform: 'linux',
            arch: 'arm64',
            supportedClis: ['gemini'],
            hasBrowserRuntime: false,
            hasBrowserMcp: false,
            hasDocker: true,
            activeInstances: 0,
            maxConcurrentInstances: 2,
            workingDirectories: ['/work'],
          },
        ],
      }),
    } as Parameters<typeof createOrchestratorToolDefinitions>[0] & {
      listRemoteNodes: () => Promise<unknown>;
    });
    const listTool = tools.find((t) => t.name === 'list_remote_nodes');

    expect(listTool).toBeDefined();
    const result = await listTool!.handler({});

    expect(result).toEqual({
      connectedCount: 1,
      totalCount: 2,
      nodes: [
        {
          id: 'node-1',
          name: 'windows-pc',
          status: 'connected',
          platform: 'win32',
          arch: 'x64',
          supportedClis: ['claude', 'codex'],
          hasBrowserRuntime: true,
          hasBrowserMcp: true,
          hasDocker: false,
          gpuName: 'NVIDIA RTX 4090',
          gpuMemoryMB: 24576,
          activeInstances: 1,
          maxConcurrentInstances: 4,
          workingDirectories: ['C:/Users/James/projects'],
          lastHeartbeat: 1234,
          latencyMs: 18,
        },
        {
          id: 'node-2',
          name: 'linux-box',
          status: 'degraded',
          platform: 'linux',
          arch: 'arm64',
          supportedClis: ['gemini'],
          hasBrowserRuntime: false,
          hasBrowserMcp: false,
          hasDocker: true,
          activeInstances: 0,
          maxConcurrentInstances: 2,
          workingDirectories: ['/work'],
        },
      ],
    });
  });

  it('describes remote worker tools with Windows PC and inspect-first language', () => {
    const db = createDb();
    const tools = createOrchestratorToolDefinitions({ db, instanceId: null });
    const runOnNode = tools.find((t) => t.name === 'run_on_node');

    expect(runOnNode?.description).toMatch(/Windows PC/i);
    expect(runOnNode?.description).toMatch(/remote machine|other machine/i);
    expect(runOnNode?.description).toMatch(/list_remote_nodes/i);
  });

  it('run_on_node forwards parsed args to the injected spawnRemoteInstance', async () => {
    const db = createDb();
    const calls: unknown[] = [];
    const tools = createOrchestratorToolDefinitions({
      db,
      instanceId: null,
      spawnRemoteInstance: async (args) => {
        calls.push(args);
        return {
          instanceId: 'inst-9',
          nodeId: 'node-9',
          nodeName: 'windows-pc',
          workingDirectory: 'C:/work',
          status: 'initializing',
        };
      },
    });
    const runOnNode = tools.find((t) => t.name === 'run_on_node');
    expect(runOnNode).toBeDefined();

    const result = await runOnNode!.handler({
      node: 'windows-pc',
      prompt: 'run the tests',
      provider: 'claude',
    });

    expect(calls).toEqual([
      { node: 'windows-pc', prompt: 'run the tests', provider: 'claude' },
    ]);
    expect(result).toMatchObject({ instanceId: 'inst-9', nodeId: 'node-9', status: 'initializing' });
  });

  it('run_on_node threads the caller instance id to spawnRemoteInstance (spawn-depth guard lineage)', async () => {
    const db = createDb();
    const metas: unknown[] = [];
    const tools = createOrchestratorToolDefinitions({
      db,
      instanceId: 'parent-instance-1',
      spawnRemoteInstance: async (_args, meta) => {
        metas.push(meta);
        return {
          instanceId: 'inst-10',
          nodeId: 'node-10',
          nodeName: 'linux-box',
          workingDirectory: '/work',
          status: 'initializing',
        };
      },
    });
    const runOnNode = tools.find((t) => t.name === 'run_on_node');

    await runOnNode!.handler({ prompt: 'do work' });

    expect(metas).toEqual([{ callerInstanceId: 'parent-instance-1' }]);
  });

  it('run_on_node passes a null caller id when no instance context is present', async () => {
    const db = createDb();
    const metas: unknown[] = [];
    const tools = createOrchestratorToolDefinitions({
      db,
      instanceId: null,
      spawnRemoteInstance: async (_args, meta) => {
        metas.push(meta);
        return {
          instanceId: 'inst-11',
          nodeId: 'node-11',
          nodeName: 'linux-box',
          workingDirectory: '/work',
          status: 'initializing',
        };
      },
    });
    const runOnNode = tools.find((t) => t.name === 'run_on_node');

    await runOnNode!.handler({ prompt: 'do work' });

    expect(metas).toEqual([{ callerInstanceId: null }]);
  });

  it('run_on_node rejects when no spawnRemoteInstance is wired', async () => {
    const db = createDb();
    const tools = createOrchestratorToolDefinitions({ db, instanceId: null });
    const runOnNode = tools.find((t) => t.name === 'run_on_node');

    await expect(runOnNode!.handler({ prompt: 'do a thing' })).rejects.toThrow(/unavailable/);
  });

  it('run_on_node requires a prompt', async () => {
    const db = createDb();
    const tools = createOrchestratorToolDefinitions({
      db,
      instanceId: null,
      spawnRemoteInstance: async () => {
        throw new Error('should not be called');
      },
    });
    const runOnNode = tools.find((t) => t.name === 'run_on_node');

    await expect(runOnNode!.handler({ node: 'windows-pc' })).rejects.toThrow();
  });

  it('read_node_output forwards parsed args to the injected reader', async () => {
    const db = createDb();
    const calls: unknown[] = [];
    const tools = createOrchestratorToolDefinitions({
      db,
      instanceId: null,
      readInstanceOutput: async (args) => {
        calls.push(args);
        return {
          instanceId: args.instanceId,
          status: 'idle',
          done: true,
          messageCount: 1,
          truncated: false,
          messages: [{ type: 'assistant', content: 'Windows 11', timestamp: 1 }],
        };
      },
    });
    const readTool = tools.find((t) => t.name === 'read_node_output');
    expect(readTool).toBeDefined();

    const result = await readTool!.handler({ instanceId: 'inst-9', limit: 5 });

    expect(calls).toEqual([{ instanceId: 'inst-9', limit: 5 }]);
    expect(result).toMatchObject({ instanceId: 'inst-9', done: true });
  });

  it('read_node_output throws when the instance is unknown', async () => {
    const db = createDb();
    const tools = createOrchestratorToolDefinitions({
      db,
      instanceId: null,
      readInstanceOutput: async () => null,
    });
    const readTool = tools.find((t) => t.name === 'read_node_output');

    await expect(readTool!.handler({ instanceId: 'ghost' })).rejects.toThrow(/Instance not found/);
  });

  it('read_node_output rejects when no reader is wired', async () => {
    const db = createDb();
    const tools = createOrchestratorToolDefinitions({ db, instanceId: null });
    const readTool = tools.find((t) => t.name === 'read_node_output');

    await expect(readTool!.handler({ instanceId: 'inst-9' })).rejects.toThrow(/unavailable/);
  });

  it('read_node_output requires an instanceId', async () => {
    const db = createDb();
    const tools = createOrchestratorToolDefinitions({
      db,
      instanceId: null,
      readInstanceOutput: async () => {
        throw new Error('should not be called');
      },
    });
    const readTool = tools.find((t) => t.name === 'read_node_output');

    await expect(readTool!.handler({ limit: 5 })).rejects.toThrow();
  });

  it('create_automation forwards parsed args + caller id to the injected creator', async () => {
    const db = createDb();
    const calls: { args: unknown; meta: unknown }[] = [];
    const tools = createOrchestratorToolDefinitions({
      db,
      instanceId: 'chat-instance-1',
      createAutomation: async (args, meta) => {
        calls.push({ args, meta });
        return {
          id: 'auto-1',
          name: args.name,
          scheduleSummary: `cron ${args.cron} (UTC)`,
          nextRunAt: 123,
          enabled: true,
          workingDirectory: '/repo',
        };
      },
    });
    const tool = tools.find((t) => t.name === 'create_automation');
    expect(tool).toBeDefined();

    const result = await tool!.handler({
      name: 'Daily PR sweep',
      prompt: 'Review open PRs',
      cron: '0 9 * * 1-5',
    });

    expect(calls).toEqual([
      {
        args: { name: 'Daily PR sweep', prompt: 'Review open PRs', cron: '0 9 * * 1-5' },
        meta: { callerInstanceId: 'chat-instance-1' },
      },
    ]);
    expect(result).toMatchObject({ id: 'auto-1', name: 'Daily PR sweep', enabled: true });
  });

  it('create_automation requires a cron or runAt', async () => {
    const db = createDb();
    const tools = createOrchestratorToolDefinitions({
      db,
      instanceId: null,
      createAutomation: async () => {
        throw new Error('should not be called');
      },
    });
    const tool = tools.find((t) => t.name === 'create_automation');

    await expect(tool!.handler({ name: 'X', prompt: 'do a thing' })).rejects.toThrow();
  });

  it('create_automation requires a name and prompt', async () => {
    const db = createDb();
    const tools = createOrchestratorToolDefinitions({
      db,
      instanceId: null,
      createAutomation: async () => {
        throw new Error('should not be called');
      },
    });
    const tool = tools.find((t) => t.name === 'create_automation');

    await expect(tool!.handler({ cron: '0 9 * * *' })).rejects.toThrow();
  });

  it('create_automation rejects when no creator is wired', async () => {
    const db = createDb();
    const tools = createOrchestratorToolDefinitions({ db, instanceId: null });
    const tool = tools.find((t) => t.name === 'create_automation');

    await expect(
      tool!.handler({ name: 'X', prompt: 'do a thing', cron: '0 9 * * *' }),
    ).rejects.toThrow(/unavailable/);
  });

  it('list_automations forwards to the injected lister', async () => {
    const db = createDb();
    const tools = createOrchestratorToolDefinitions({
      db,
      instanceId: null,
      listAutomations: async () => ({
        count: 1,
        automations: [
          {
            id: 'auto-1',
            name: 'Daily PR sweep',
            scheduleSummary: 'cron 0 9 * * 1-5 (UTC)',
            enabled: true,
            nextRunAt: 123,
            lastRunAt: null,
            workingDirectory: '/repo',
          },
        ],
      }),
    });
    const tool = tools.find((t) => t.name === 'list_automations');
    expect(tool).toBeDefined();

    const result = await tool!.handler({});
    expect(result).toMatchObject({ count: 1 });
  });

  it('list_automations rejects when no lister is wired', async () => {
    const db = createDb();
    const tools = createOrchestratorToolDefinitions({ db, instanceId: null });
    const tool = tools.find((t) => t.name === 'list_automations');

    await expect(tool!.handler({})).rejects.toThrow(/unavailable/);
  });

  it('delete_automation forwards the parsed id to the injected deleter', async () => {
    const db = createDb();
    const calls: unknown[] = [];
    const tools = createOrchestratorToolDefinitions({
      db,
      instanceId: null,
      deleteAutomation: async (args) => {
        calls.push(args);
        return { id: args.id, name: 'Daily PR sweep', deleted: true, detachedInstanceIds: [] };
      },
    });
    const tool = tools.find((t) => t.name === 'delete_automation');
    expect(tool).toBeDefined();

    const result = await tool!.handler({ id: 'auto-1' });

    expect(calls).toEqual([{ id: 'auto-1' }]);
    expect(result).toMatchObject({ id: 'auto-1', deleted: true });
  });

  it('delete_automation requires an id', async () => {
    const db = createDb();
    const tools = createOrchestratorToolDefinitions({
      db,
      instanceId: null,
      deleteAutomation: async () => {
        throw new Error('should not be called');
      },
    });
    const tool = tools.find((t) => t.name === 'delete_automation');

    await expect(tool!.handler({})).rejects.toThrow();
  });

  it('delete_automation rejects when no deleter is wired', async () => {
    const db = createDb();
    const tools = createOrchestratorToolDefinitions({ db, instanceId: null });
    const tool = tools.find((t) => t.name === 'delete_automation');

    await expect(tool!.handler({ id: 'auto-1' })).rejects.toThrow(/unavailable/);
  });

  it('update_automation forwards the parsed args to the injected updater', async () => {
    const db = createDb();
    const calls: unknown[] = [];
    const tools = createOrchestratorToolDefinitions({
      db,
      instanceId: null,
      updateAutomation: async (args) => {
        calls.push(args);
        return {
          id: args.id,
          name: 'Daily PR sweep',
          scheduleSummary: 'cron 0 9 * * 1-5 (UTC)',
          nextRunAt: null,
          enabled: false,
          workingDirectory: '/repo',
        };
      },
    });
    const tool = tools.find((t) => t.name === 'update_automation');
    expect(tool).toBeDefined();

    const result = await tool!.handler({ id: 'auto-1', enabled: false });

    expect(calls).toEqual([{ id: 'auto-1', enabled: false }]);
    expect(result).toMatchObject({ id: 'auto-1', enabled: false });
  });

  it('update_automation rejects when both cron and runAt are provided', async () => {
    const db = createDb();
    const tools = createOrchestratorToolDefinitions({
      db,
      instanceId: null,
      updateAutomation: async () => {
        throw new Error('should not be called');
      },
    });
    const tool = tools.find((t) => t.name === 'update_automation');

    await expect(
      tool!.handler({ id: 'auto-1', cron: '0 9 * * *', runAt: '2026-01-01T00:00:00Z' }),
    ).rejects.toThrow();
  });

  it('update_automation rejects when no updater is wired', async () => {
    const db = createDb();
    const tools = createOrchestratorToolDefinitions({ db, instanceId: null });
    const tool = tools.find((t) => t.name === 'update_automation');

    await expect(tool!.handler({ id: 'auto-1', enabled: true })).rejects.toThrow(/unavailable/);
  });

  it('postpone_automation forwards the parsed args to the injected postponer', async () => {
    const db = createDb();
    const calls: unknown[] = [];
    const tools = createOrchestratorToolDefinitions({
      db,
      instanceId: null,
      postponeAutomation: async (args) => {
        calls.push(args);
        return {
          id: args.id,
          name: 'Daily PR sweep',
          scheduleSummary: 'cron 0 9 * * 1-5 (UTC)',
          nextRunAt: 999,
          enabled: true,
          workingDirectory: '/repo',
        };
      },
    });
    const tool = tools.find((t) => t.name === 'postpone_automation');
    expect(tool).toBeDefined();

    const result = await tool!.handler({ id: 'auto-1', delayMinutes: 60 });

    expect(calls).toEqual([{ id: 'auto-1', delayMinutes: 60 }]);
    expect(result).toMatchObject({ id: 'auto-1', nextRunAt: 999 });
  });

  it('postpone_automation rejects when neither untilIso nor delayMinutes is provided', async () => {
    const db = createDb();
    const tools = createOrchestratorToolDefinitions({
      db,
      instanceId: null,
      postponeAutomation: async () => {
        throw new Error('should not be called');
      },
    });
    const tool = tools.find((t) => t.name === 'postpone_automation');

    await expect(tool!.handler({ id: 'auto-1' })).rejects.toThrow();
  });

  it('postpone_automation rejects when both untilIso and delayMinutes are provided', async () => {
    const db = createDb();
    const tools = createOrchestratorToolDefinitions({
      db,
      instanceId: null,
      postponeAutomation: async () => {
        throw new Error('should not be called');
      },
    });
    const tool = tools.find((t) => t.name === 'postpone_automation');

    await expect(
      tool!.handler({ id: 'auto-1', untilIso: '2026-01-01T00:00:00Z', delayMinutes: 60 }),
    ).rejects.toThrow();
  });

  it('postpone_automation rejects when no postponer is wired', async () => {
    const db = createDb();
    const tools = createOrchestratorToolDefinitions({ db, instanceId: null });
    const tool = tools.find((t) => t.name === 'postpone_automation');

    await expect(tool!.handler({ id: 'auto-1', delayMinutes: 60 })).rejects.toThrow(/unavailable/);
  });

  function createDb(): SqliteDriver {
    const db = defaultDriverFactory(':memory:');
    createOperatorTables(db);
    dbs.push(db);
    return db;
  }

  function createLedger(): ConversationLedgerService {
    const ledger = new ConversationLedgerService({
      dbPath: ':memory:',
      enableWAL: false,
      registry: new NativeConversationRegistry(),
    });
    ledgers.push(ledger);
    return ledger;
  }
});

class FakeGitBatchService extends GitBatchService {
  override async pullAll(
    rootPath: string,
    options: GitBatchPullOptions = {},
  ): Promise<OperatorGitBatchSummary> {
    options.onShellCommand?.({
      cmd: 'git',
      args: ['pull', '--ff-only'],
      cwd: `${rootPath}/repo`,
      exitCode: 0,
      durationMs: 12,
      stdoutBytes: 5,
      stderrBytes: 0,
    });
    return {
      rootPath,
      total: 1,
      pulled: 1,
      upToDate: 0,
      skipped: 0,
      failed: 0,
      results: [
        {
          repositoryPath: `${rootPath}/repo`,
          status: 'pulled',
          reason: null,
          branch: 'main',
          upstream: 'origin/main',
          ahead: 0,
          behind: 0,
          dirty: false,
          durationMs: 12,
          error: null,
        },
      ],
    };
  }
}

class CancellingGitBatchService extends GitBatchService {
  constructor(private readonly db: SqliteDriver) {
    super();
  }

  override async pullAll(
    _rootPath: string,
    options: GitBatchPullOptions = {},
  ): Promise<OperatorGitBatchSummary> {
    const store = new OperatorRunStore(this.db);
    const run = store.listRuns({ limit: 1 })[0];
    if (!run) {
      throw new Error('Expected git_batch_pull to create an operator run before starting Git work');
    }
    store.updateRun(run.id, {
      status: 'cancelled',
      error: 'Cancelled by user',
    });
    if (options.shouldCancel?.()) {
      throw new GitBatchCancelledError();
    }
    throw new Error('git_batch_pull did not pass cancellation state into GitBatchService');
  }
}

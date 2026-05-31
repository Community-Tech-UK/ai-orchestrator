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

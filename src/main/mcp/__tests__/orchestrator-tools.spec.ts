import { afterEach, describe, expect, it, vi } from 'vitest';
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
import {
  buildReadNodeOutputResult, createOrchestratorToolDefinitions } from '../orchestrator-tools';

describe('orchestrator MCP tools', () => {
  const maxCatalogModelId = `${'m'.repeat(509)}-v1`;
  const tooLongCatalogModelId = `${'m'.repeat(510)}-v1`;
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
            hasAndroidMcp: true,
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
            hasAndroidMcp: false,
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
          hasAndroidMcp: true,
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
          hasAndroidMcp: false,
          hasDocker: true,
          activeInstances: 0,
          maxConcurrentInstances: 2,
          workingDirectories: ['/work'],
        },
      ],
    });
  });

  it('captures an AIO-owned MCP result with the canonical tool-call identity before returning it', async () => {
    const db = createDb();
    const ledger = createLedger();
    const conversation = await ledger.startConversation({
      provider: 'orchestrator', metadata: { scope: 'instance', historyThreadId: 'history-1' },
    });
    const toolCall = (await ledger.appendMessage(conversation.id, {
      role: 'assistant', phase: 'tool_call', content: 'list_remote_nodes({})',
      rawJson: { metadata: { kind: 'tool_call' } }, createdAt: 1,
    })).messages[0]!;
    const boundedResult = { evidenceId: 'evidence-1', truncated: true };
    const captureAioMcpResult = vi.fn(async () => ({
      providerResult: boundedResult,
      capture: { status: 'captured' },
    }));
    const tools = createOrchestratorToolDefinitions({
      db,
      ledger,
      instanceId: 'instance-1',
      listRemoteNodes: async () => ({ connectedCount: 0, totalCount: 0, nodes: [] }),
      contextEvidence: {
        conversationId: conversation.id,
        mode: 'shadow',
        providerWindowTokens: 200_000,
        coordinator: evidenceCoordinatorStub(captureAioMcpResult),
      },
    });

    const result = await tools.find((tool) => tool.name === 'list_remote_nodes')!.handler({});

    expect(captureAioMcpResult).toHaveBeenCalledWith({
      queueId: 'instance-1',
      conversationId: conversation.id,
      captureKey: `mcp:${toolCall.id}:list_remote_nodes`,
      turnRef: toolCall.id,
      toolCallRef: toolCall.id,
      toolName: 'list_remote_nodes',
      result: { connectedCount: 0, totalCount: 0, nodes: [] },
      providerWindowTokens: 200_000,
    });
    expect(result).toEqual(boundedResult);
  });

  it('blocks an explicit failed capture result in enforce mode', async () => {
    const db = createDb();
    const ledger = createLedger();
    const conversation = await ledger.startConversation({ provider: 'orchestrator', metadata: {} });
    await ledger.appendMessage(conversation.id, {
      role: 'assistant', phase: 'tool_call', content: 'list_remote_nodes({})', createdAt: 1,
    });
    const tool = createOrchestratorToolDefinitions({
      db,
      ledger,
      instanceId: 'instance-1',
      listRemoteNodes: async () => ({ connectedCount: 0, totalCount: 0, nodes: [] }),
      contextEvidence: {
        conversationId: conversation.id,
        mode: 'enforce',
        coordinator: evidenceCoordinatorStub(vi.fn(async () => ({
          providerResult: { connectedCount: 0, totalCount: 0, nodes: [] },
          capture: { status: 'failed', errorCode: 'FIXTURE' },
        }))),
      },
    }).find((candidate) => candidate.name === 'list_remote_nodes')!;

    await expect(tool.handler({})).rejects.toThrow('EVIDENCE_CAPTURE_REQUIRED');
  });

  it('passes capture failures through in shadow and blocks the result in enforce', async () => {
    const db = createDb();
    const ledger = createLedger();
    const conversation = await ledger.startConversation({ provider: 'orchestrator', metadata: {} });
    await ledger.appendMessage(conversation.id, {
      role: 'assistant', phase: 'tool_call', content: 'list_remote_nodes({})', createdAt: 1,
    });
    const createTools = (mode: 'shadow' | 'enforce') => createOrchestratorToolDefinitions({
      db,
      ledger,
      instanceId: 'instance-1',
      listRemoteNodes: async () => ({ connectedCount: 0, totalCount: 0, nodes: [] }),
      contextEvidence: {
        conversationId: conversation.id,
        mode,
        coordinator: evidenceCoordinatorStub(vi.fn(async () => {
          throw new Error('capture failed');
        })),
      },
    }).find((tool) => tool.name === 'list_remote_nodes')!;

    await expect(createTools('shadow').handler({})).resolves.toMatchObject({ totalCount: 0 });
    await expect(createTools('enforce').handler({})).rejects.toThrow('EVIDENCE_CAPTURE_REQUIRED');
  });

  it('describes remote worker tools with Windows PC and inspect-first language', () => {
    const db = createDb();
    const tools = createOrchestratorToolDefinitions({ db, instanceId: null });
    const runOnNode = tools.find((t) => t.name === 'run_on_node');

    expect(runOnNode?.description).toMatch(/Windows PC/i);
    expect(runOnNode?.description).toMatch(/laptop|desktop/i);
    expect(runOnNode?.description).toMatch(/Noah's laptop/i);
    expect(runOnNode?.description).toMatch(/remote machine|other machine/i);
    expect(runOnNode?.description).toMatch(/list_remote_nodes/i);
    expect(runOnNode?.description).toMatch(/before local filesystem/i);
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
      requiresAndroid: true,
      androidDeviceKind: 'emulator',
    });

    expect(calls).toEqual([
      {
        node: 'windows-pc',
        prompt: 'run the tests',
        provider: 'claude',
        requiresAndroid: true,
        androidDeviceKind: 'emulator',
      },
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

  it('download_from_node allows the implementation to choose a default local destination', async () => {
    const db = createDb();
    const calls: { args: unknown; meta: unknown }[] = [];
    const tools = createOrchestratorToolDefinitions({
      db,
      instanceId: 'caller-inst',
      downloadFromNode: async (args: unknown, meta: unknown) => {
        calls.push({ args, meta });
        return {
          ok: true,
          nodeId: 'node-1',
          nodeName: 'windows-pc',
          remotePath: 'C:\\Users\\James\\Downloads\\file.docx',
          localPath: '/repo/_scratch/file.docx',
          size: 11,
          sha256: 'a'.repeat(64),
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        };
      },
    } as Parameters<typeof createOrchestratorToolDefinitions>[0] & {
      downloadFromNode: (args: unknown, meta: unknown) => Promise<unknown>;
    });
    const tool = tools.find((t) => t.name === 'download_from_node');
    expect(tool).toBeDefined();

    const result = await tool!.handler({
      node: 'windows-pc',
      remotePath: 'C:\\Users\\James\\Downloads\\file.docx',
      overwrite: false,
    });

    expect(calls).toEqual([
      {
        args: {
          node: 'windows-pc',
          remotePath: 'C:\\Users\\James\\Downloads\\file.docx',
          overwrite: false,
        },
        meta: { callerInstanceId: 'caller-inst' },
      },
    ]);
    expect(result).toMatchObject({ ok: true, size: 11, sha256: 'a'.repeat(64) });
  });

  it('collect_browser_download forwards candidate search args to the injected transfer implementation', async () => {
    const db = createDb();
    const calls: { args: unknown; meta: unknown }[] = [];
    const tools = createOrchestratorToolDefinitions({
      db,
      instanceId: null,
      collectBrowserDownload: async (args: unknown, meta: unknown) => {
        calls.push({ args, meta });
        return {
          ok: false,
          code: 'multiple_download_candidates',
          candidates: [
            {
              path: 'C:\\Users\\James\\Downloads\\a.pdf',
              name: 'a.pdf',
              size: 10,
              modifiedAt: 123,
              extension: '.pdf',
              rootLabel: 'Downloads',
            },
          ],
        };
      },
    } as Parameters<typeof createOrchestratorToolDefinitions>[0] & {
      collectBrowserDownload: (args: unknown, meta: unknown) => Promise<unknown>;
    });
    const tool = tools.find((t) => t.name === 'collect_browser_download');
    expect(tool).toBeDefined();

    const result = await tool!.handler({
      node: 'windows-pc',
      fileNameHint: 'invoice',
      extensions: ['.pdf'],
      modifiedWithinMinutes: 15,
    });

    expect(calls).toEqual([
      {
        args: {
          node: 'windows-pc',
          fileNameHint: 'invoice',
          extensions: ['.pdf'],
          modifiedWithinMinutes: 15,
        },
        meta: { callerInstanceId: null },
      },
    ]);
    expect(result).toMatchObject({ ok: false, code: 'multiple_download_candidates' });
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

  it('run_on_node accepts model ids up to the dynamic catalog limit', async () => {
    const db = createDb();
    const calls: unknown[] = [];
    const tools = createOrchestratorToolDefinitions({
      db,
      instanceId: null,
      spawnRemoteInstance: async (args) => {
        calls.push(args);
        return {
          instanceId: 'inst-model',
          nodeId: 'node-model',
          nodeName: 'linux-box',
          workingDirectory: '/work',
          status: 'initializing',
        };
      },
    });
    const runOnNode = tools.find((t) => t.name === 'run_on_node');

    expect(maxCatalogModelId).toHaveLength(512);

    await runOnNode!.handler({
      prompt: 'run with model',
      provider: 'claude',
      model: maxCatalogModelId,
    });

    expect(calls).toEqual([{
      prompt: 'run with model',
      provider: 'claude',
      model: maxCatalogModelId,
    }]);
  });

  it('run_on_node rejects model ids beyond the dynamic catalog limit', async () => {
    const db = createDb();
    const calls: unknown[] = [];
    const tools = createOrchestratorToolDefinitions({
      db,
      instanceId: null,
      spawnRemoteInstance: async (args) => {
        calls.push(args);
        return {
          instanceId: 'inst-too-long',
          nodeId: 'node-too-long',
          nodeName: 'linux-box',
          workingDirectory: '/work',
          status: 'initializing',
        };
      },
    });
    const runOnNode = tools.find((t) => t.name === 'run_on_node');

    expect(tooLongCatalogModelId).toHaveLength(513);

    await expect(runOnNode!.handler({
      prompt: 'run with model',
      provider: 'claude',
      model: tooLongCatalogModelId,
    })).rejects.toThrow();
    expect(calls).toEqual([]);
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
          lastSeq: 0,
          messages: [{ type: 'assistant', content: 'Windows 11', timestamp: 1, seq: 0 }],
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

  it('terminate_node_instance forwards single-id args to the injected terminator', async () => {
    const db = createDb();
    const calls: unknown[] = [];
    const tools = createOrchestratorToolDefinitions({
      db,
      instanceId: null,
      terminateNodeInstances: async (args) => {
        calls.push(args);
        return { terminated: [{ instanceId: args.instanceId! }], skipped: [] };
      },
    });
    const tool = tools.find((t) => t.name === 'terminate_node_instance');
    expect(tool).toBeDefined();

    const result = await tool!.handler({ instanceId: 'inst-9' });

    expect(calls).toEqual([{ instanceId: 'inst-9' }]);
    expect(result).toEqual({ terminated: [{ instanceId: 'inst-9' }], skipped: [] });
  });

  it('terminate_node_instance forwards allIdle sweep args with a node filter', async () => {
    const db = createDb();
    const calls: unknown[] = [];
    const tools = createOrchestratorToolDefinitions({
      db,
      instanceId: null,
      terminateNodeInstances: async (args) => {
        calls.push(args);
        return {
          terminated: [{ instanceId: 'a' }, { instanceId: 'b' }],
          skipped: [{ instanceId: 'c', reason: 'still working (busy)' }],
        };
      },
    });
    const tool = tools.find((t) => t.name === 'terminate_node_instance');

    const result = await tool!.handler({ allIdle: true, node: 'noahlaptop' });

    expect(calls).toEqual([{ allIdle: true, node: 'noahlaptop' }]);
    expect(result).toMatchObject({ terminated: [{ instanceId: 'a' }, { instanceId: 'b' }] });
  });

  it('terminate_node_instance rejects when both instanceId and allIdle are given', async () => {
    const db = createDb();
    const tools = createOrchestratorToolDefinitions({
      db,
      instanceId: null,
      terminateNodeInstances: async () => {
        throw new Error('should not be called');
      },
    });
    const tool = tools.find((t) => t.name === 'terminate_node_instance');

    await expect(tool!.handler({ instanceId: 'inst-9', allIdle: true })).rejects.toThrow();
    await expect(tool!.handler({})).rejects.toThrow();
    await expect(tool!.handler({ instanceId: 'inst-9', node: 'noahlaptop' })).rejects.toThrow();
  });

  it('terminate_node_instance rejects when no terminator is wired', async () => {
    const db = createDb();
    const tools = createOrchestratorToolDefinitions({ db, instanceId: null });
    const tool = tools.find((t) => t.name === 'terminate_node_instance');

    await expect(tool!.handler({ instanceId: 'inst-9' })).rejects.toThrow(/unavailable/);
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

  it('update_automation accepts model ids up to the dynamic catalog limit', async () => {
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
          enabled: true,
          workingDirectory: '/repo',
        };
      },
    });
    const tool = tools.find((t) => t.name === 'update_automation');

    expect(maxCatalogModelId).toHaveLength(512);

    await tool!.handler({ id: 'auto-1', model: maxCatalogModelId });

    expect(calls).toEqual([{ id: 'auto-1', model: maxCatalogModelId }]);
  });

  it('update_automation rejects model ids beyond the dynamic catalog limit', async () => {
    const db = createDb();
    const tools = createOrchestratorToolDefinitions({
      db,
      instanceId: null,
      updateAutomation: async () => {
        throw new Error('should not be called');
      },
    });
    const tool = tools.find((t) => t.name === 'update_automation');

    expect(tooLongCatalogModelId).toHaveLength(513);

    await expect(
      tool!.handler({ id: 'auto-1', model: tooLongCatalogModelId }),
    ).rejects.toThrow();
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

function evidenceCoordinatorStub(captureAioMcpResult: ReturnType<typeof vi.fn>) {
  return {
    list: vi.fn(async () => []),
    search: vi.fn(async () => []),
    read: vi.fn(async () => ({})),
    compare: vi.fn(async () => ({})),
    verify: vi.fn(async () => ({})),
    captureAioMcpResult,
  };
}

describe('buildReadNodeOutputResult (WS11.5 afterSeq cursor)', () => {
  const buffer = Array.from({ length: 6 }, (_, i) => ({
    type: 'assistant' as const,
    content: `msg-${i}`,
    timestamp: i,
  }));
  const base = { instanceId: 'inst-1', status: 'idle', done: true, buffer };

  it('legacy mode returns the most-recent window with seqs and marks older messages truncated', () => {
    const result = buildReadNodeOutputResult({ ...base, limit: 2 });
    expect(result.messages.map((m) => m.seq)).toEqual([4, 5]);
    expect(result.messages.map((m) => m.content)).toEqual(['msg-4', 'msg-5']);
    expect(result.truncated).toBe(true); // 4 older messages skipped
    expect(result.lastSeq).toBe(5);
    expect(result.messageCount).toBe(6);
  });

  it('consecutive cursor reads are gap-free and duplicate-free', () => {
    const first = buildReadNodeOutputResult({ ...base, afterSeq: -1, limit: 3 });
    expect(first.messages.map((m) => m.seq)).toEqual([0, 1, 2]);
    expect(first.truncated).toBe(true); // limit cut into the unseen window

    const second = buildReadNodeOutputResult({ ...base, afterSeq: 2, limit: 3 });
    expect(second.messages.map((m) => m.seq)).toEqual([3, 4, 5]);
    expect(second.truncated).toBe(false); // everything unseen was returned
    expect(second.lastSeq).toBe(5);

    const third = buildReadNodeOutputResult({ ...base, afterSeq: second.lastSeq });
    expect(third.messages).toEqual([]);
    expect(third.truncated).toBe(false);
  });

  it('a rotated window is detectable: cursor past the buffer returns empty with lastSeq < afterSeq', () => {
    const result = buildReadNodeOutputResult({ ...base, afterSeq: 40 });
    expect(result.messages).toEqual([]);
    expect(result.lastSeq).toBe(5);
  });

  it('caps oversized message content and flags truncated', () => {
    const result = buildReadNodeOutputResult({
      ...base,
      buffer: [{ type: 'assistant', content: 'x'.repeat(50), timestamp: 1 }],
      maxContentChars: 10,
    });
    expect(result.messages[0].content).toContain('… [truncated]');
    expect(result.truncated).toBe(true);
  });
});

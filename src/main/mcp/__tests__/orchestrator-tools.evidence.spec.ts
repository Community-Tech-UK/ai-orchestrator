import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationLedgerService } from '../../conversation-ledger';
import { NativeConversationRegistry } from '../../conversation-ledger/native-conversation-registry';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { ChatStore } from '../../chats/chat-store';
import { createOperatorTables } from '../../operator/operator-schema';
import { createOrchestratorToolDefinitions, type OrchestratorToolRuntimeContext } from '../orchestrator-tools';

describe('MCP evidence execution boundary', () => {
  const resources: { ledger: ConversationLedgerService; db: SqliteDriver }[] = [];
  afterEach(async () => {
    for (const { ledger, db } of resources.splice(0)) {
      await ledger.close();
      db.close();
    }
  });

  async function setup() {
    const db = defaultDriverFactory(':memory:');
    createOperatorTables(db);
    const ledger = new ConversationLedgerService({
      dbPath: ':memory:', enableWAL: false, registry: new NativeConversationRegistry(),
    });
    resources.push({ ledger, db });
    const conversation = await ledger.startConversation({
      provider: 'orchestrator', metadata: { scope: 'instance', historyThreadId: 'history-1' },
    });
    const captures: Record<string, unknown>[] = [];
    const capture = vi.fn(async (input: Record<string, unknown>) => {
      captures.push(input);
      return {
        capture: {
          status: 'captured',
          record: {
            id: `evidence-${captures.length}`, conversationId: input['conversationId'], status: 'complete',
            provider: 'orchestrator', toolName: input['toolName'], sourceKind: 'mcp',
            byteCount: 1, mimeType: 'application/json', sensitivity: 'normal',
            provenanceTrust: 'runtime-authenticated', createdAt: 1,
            captureMode: 'pre-retention', captureCompleteness: 'complete',
          },
        },
        providerResult: input['result'],
      };
    });
    const context: OrchestratorToolRuntimeContext = {
      db, ledger, instanceId: 'instance-1',
      contextEvidence: {
        mode: 'enforce', conversationId: conversation.id,
        coordinator: {
          list: vi.fn(), read: vi.fn(), search: vi.fn(), compare: vi.fn(), verify: vi.fn(),
          captureAioMcpResult: capture,
        },
      },
    };
    const user = async (content = 'Use the worker') => ledger.appendMessageReturningRecord(conversation.id, {
      role: 'user', content, createdAt: Date.now(),
      rawJson: { metadata: { instanceId: 'instance-1' } },
    });
    return { context, conversation, ledger, db, captures, capture, user };
  }

  it('rejects missing recorded source BEFORE a remote spawn can execute', async () => {
    const { context, capture } = await setup();
    const spawn = vi.fn(async () => ({
      instanceId: 'child', nodeId: 'node', nodeName: 'windows-pc', workingDirectory: 'C:/work', status: 'idle',
    }));
    const tool = createOrchestratorToolDefinitions({ ...context, spawnRemoteInstance: spawn })
      .find((entry) => entry.name === 'run_on_node')!;
    await expect(tool.handler({ node: 'windows-pc', prompt: 'Synthetic task' }))
      .rejects.toThrow(/EVIDENCE_CAPTURE_REQUIRED.*execution=not_started.*SOURCE_MESSAGE_MISSING/);
    expect(spawn).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  it('rejects a different chat owner BEFORE executing its handler', async () => {
    const { context, ledger, db, user } = await setup();
    await user();
    const other = await ledger.startConversation({ provider: 'orchestrator', metadata: { scope: 'chat' } });
    await ledger.appendMessage(other.id, { role: 'user', content: 'Other chat', createdAt: 1 });
    new ChatStore(db).insert({
      id: 'other-chat', name: 'Other', provider: 'codex', currentCwd: null,
      ledgerThreadId: other.id, currentInstanceId: 'instance-1',
    });
    const list = vi.fn(async () => ({ connectedCount: 0, totalCount: 0, nodes: [] }));
    const tool = createOrchestratorToolDefinitions({ ...context, listRemoteNodes: list })
      .find((entry) => entry.name === 'list_remote_nodes')!;
    await expect(tool.handler({})).rejects.toThrow(/execution=not_started.*CONVERSATION_MISMATCH/);
    expect(list).not.toHaveBeenCalled();
  });

  it('awaits pending genuine transcript persistence before executing a handler', async () => {
    const { context, ledger, conversation, captures } = await setup();
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const events: string[] = [];
    let sourceId = '';
    const prepareEvidenceSource = async () => {
      await ready;
      sourceId = (await ledger.appendMessageReturningRecord(conversation.id, {
        role: 'user', content: 'Genuine queued runtime send', createdAt: 1,
      })).id;
      events.push('persisted');
    };
    const tool = createOrchestratorToolDefinitions({
      ...context, prepareEvidenceSource,
      listRemoteNodes: async () => {
        events.push('executed');
        return { connectedCount: 0, totalCount: 0, nodes: [] };
      },
    }).find((entry) => entry.name === 'list_remote_nodes')!;
    const pending = tool.handler({});
    await Promise.resolve();
    expect(events).toEqual([]);
    release();
    await expect(pending).resolves.toMatchObject({ totalCount: 0 });
    expect(events).toEqual(['persisted', 'executed']);
    expect(captures[0]?.['turnRef']).toBe(sourceId);
  });

  it('blocks persistence failure even with an older recorded source and sanitizes the error', async () => {
    const { context, user } = await setup();
    await user();
    const list = vi.fn(async () => ({ connectedCount: 0, totalCount: 0, nodes: [] }));
    const tool = createOrchestratorToolDefinitions({
      ...context, listRemoteNodes: list,
      prepareEvidenceSource: async () => { throw new Error('synthetic-private-storage-detail'); },
    }).find((entry) => entry.name === 'list_remote_nodes')!;
    const failure = await tool.handler({}).then(() => null, (error: Error) => error);
    expect(failure?.message).toMatch(/execution=not_started.*SOURCE_PERSISTENCE_FAILED/);
    expect(failure?.message).not.toContain('synthetic-private-storage-detail');
    expect(list).not.toHaveBeenCalled();
  });

  it('keeps a missing canonical owner enforced', async () => {
    const { context } = await setup();
    const list = vi.fn(async () => ({ connectedCount: 0, totalCount: 0, nodes: [] }));
    const tool = createOrchestratorToolDefinitions({
      ...context, listRemoteNodes: list,
      contextEvidence: { ...context.contextEvidence!, conversationId: null },
    }).find((entry) => entry.name === 'list_remote_nodes')!;
    await expect(tool.handler({})).rejects.toThrow(/execution=not_started.*CONVERSATION_UNRESOLVED/);
    expect(list).not.toHaveBeenCalled();
  });

  it('does not use recorded messages explicitly attributed to another runtime instance', async () => {
    const { context, ledger, conversation } = await setup();
    await ledger.appendMessage(conversation.id, {
      role: 'tool', phase: 'tool_call', content: 'Other runtime', createdAt: 1,
      rawJson: { metadata: { instanceId: 'other-instance', toolName: 'list_remote_nodes' } },
    });
    const list = vi.fn(async () => ({ connectedCount: 0, totalCount: 0, nodes: [] }));
    const tool = createOrchestratorToolDefinitions({ ...context, listRemoteNodes: list })
      .find((entry) => entry.name === 'list_remote_nodes')!;
    await expect(tool.handler({})).rejects.toThrow(/execution=not_started.*SOURCE_MESSAGE_MISSING/);
    expect(list).not.toHaveBeenCalled();
  });

  it('gives concurrent and later calls from the same recorded source different capture identities', async () => {
    const { context, captures, user } = await setup();
    const source = await user();
    let count = 0;
    const definitions = () => createOrchestratorToolDefinitions({
      ...context, listRemoteNodes: async () => ({ connectedCount: 0, totalCount: ++count, nodes: [] }),
    });
    const tool = definitions().find((entry) => entry.name === 'list_remote_nodes')!;
    const results = await Promise.all([tool.handler({}), tool.handler({})]);
    results.push(await definitions().find((entry) => entry.name === 'list_remote_nodes')!.handler({}));
    expect(results).toEqual([
      { connectedCount: 0, totalCount: 1, nodes: [] },
      { connectedCount: 0, totalCount: 2, nodes: [] },
      { connectedCount: 0, totalCount: 3, nodes: [] },
    ]);
    expect(new Set(captures.map((input) => input['captureKey'])).size).toBe(3);
    expect(captures.every((input) => input['turnRef'] === source.id)).toBe(true);
    expect(new Set(captures.map((input) => input['toolCallRef'])).size).toBe(3);
  });

  it.each([
    { capture: { status: 'failed', errorCode: 'CAPTURE_STAGE_FAILED' } },
    { capture: { status: 'conflict', errorCode: 'EVIDENCE_CAPTURE_KEY_CONTENT_CONFLICT' } },
    { capture: { status: 'unexpected' } },
    { capture: { status: 'captured' } },
    { capture: { status: 'duplicate', record: { id: 'evidence', status: 'complete', conversationId: 'another-conversation' } } },
    {},
  ])('blocks invalid capture receipts and discloses completed execution without returning raw results: %j', async (receipt) => {
    const { context, capture, user } = await setup();
    await user();
    capture.mockImplementationOnce(async () => receipt as never);
    const exec = vi.fn(async () => ({
      nodeId: 'node', nodeName: 'windows-pc', exitCode: 0, stdout: 'synthetic-sensitive-result',
      stderr: '', stdoutTruncated: false, stderrTruncated: false, durationMs: 1,
    }));
    const tool = createOrchestratorToolDefinitions({ ...context, execOnNode: exec })
      .find((entry) => entry.name === 'exec_on_node')!;
    const error = await tool.handler({ node: 'windows-pc', executable: 'fixture.exe', args: [] })
      .then(() => null, (failure: Error) => failure);
    expect(error?.message).toMatch(/EVIDENCE_CAPTURE_REQUIRED.*execution=completed/);
    expect(error?.message).not.toContain('synthetic-sensitive-result');
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('sanitizes capture exceptions after execution', async () => {
    const { context, capture, user } = await setup();
    await user();
    capture.mockRejectedValueOnce(new Error('synthetic-private-error-content'));
    const tool = createOrchestratorToolDefinitions({
      ...context, listRemoteNodes: async () => ({ connectedCount: 0, totalCount: 0, nodes: [] }),
    }).find((entry) => entry.name === 'list_remote_nodes')!;
    const failure = await tool.handler({}).then(() => null, (error: Error) => error);
    expect(failure?.message).toMatch(/execution=completed.*CAPTURE_EXCEPTION/);
    expect(failure?.message).not.toContain('synthetic-private-error-content');
  });

  it('blocks an ownership change during capture after execution without returning raw results', async () => {
    const { context, capture, user, conversation } = await setup();
    await user();
    let owner: string | null = conversation.id;
    capture.mockImplementationOnce(async (input) => {
      owner = 'new-canonical-conversation';
      return {
        capture: { status: 'captured', record: { id: 'complete-receipt', status: 'complete', conversationId: input['conversationId'] } },
        providerResult: input['result'],
      } as never;
    });
    const list = vi.fn(async () => ({ connectedCount: 0, totalCount: 0, nodes: [] }));
    const tool = createOrchestratorToolDefinitions({
      ...context, listRemoteNodes: list, resolveEvidenceConversation: () => owner,
    }).find((entry) => entry.name === 'list_remote_nodes')!;
    await expect(tool.handler({})).rejects.toThrow(/execution=completed.*CONVERSATION_OWNERSHIP_CHANGED/);
    expect(list).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('sanitizes authoritative owner lookup failures and blocks execution', async () => {
    const { context, capture, user } = await setup();
    await user();
    const list = vi.fn(async () => ({ connectedCount: 0, totalCount: 0, nodes: [] }));
    const tool = createOrchestratorToolDefinitions({
      ...context, listRemoteNodes: list,
      resolveEvidenceConversation: () => { throw new Error('synthetic-private-owner-detail'); },
    }).find((entry) => entry.name === 'list_remote_nodes')!;
    const error = await tool.handler({}).then(() => null, (failure: Error) => failure);
    expect(error?.message).toMatch(/execution=not_started.*SOURCE_OWNERSHIP_LOOKUP_FAILED/);
    expect(error?.message).not.toContain('synthetic-private-owner-detail');
    expect(list).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  it('uses the current user source instead of a previous turn or unrelated tool call', async () => {
    const { context, ledger, conversation, captures, user } = await setup();
    await ledger.appendMessage(conversation.id, {
      role: 'tool', phase: 'tool_call', content: 'run_on_node', createdAt: 1,
      rawJson: { metadata: { toolName: 'run_on_node', instanceId: 'instance-1' } },
    });
    const source = await user();
    await ledger.appendMessage(conversation.id, {
      role: 'tool', phase: 'tool_call', content: 'Other tool', createdAt: 2,
      rawJson: { metadata: { toolName: 'unrelated_tool', instanceId: 'instance-1' } },
    });
    const tool = createOrchestratorToolDefinitions({
      ...context, listRemoteNodes: async () => ({ connectedCount: 0, totalCount: 0, nodes: [] }),
    }).find((entry) => entry.name === 'list_remote_nodes')!;
    await tool.handler({});
    expect(captures[0]?.['turnRef']).toBe(source.id);
  });

  it('anchors repeated calls to the genuine user when pending native calls cannot be correlated', async () => {
    const { context, ledger, conversation, captures, user } = await setup();
    const source = await user();
    await ledger.appendMessage(conversation.id, {
      role: 'tool', phase: 'tool_call', content: 'Pending native call', createdAt: 1,
      rawJson: { metadata: { toolName: 'list_remote_nodes', toolUseId: 'earlier-native-call', instanceId: 'instance-1' } },
    });
    const tool = createOrchestratorToolDefinitions({
      ...context, listRemoteNodes: async () => ({ connectedCount: 0, totalCount: 0, nodes: [] }),
    }).find((entry) => entry.name === 'list_remote_nodes')!;
    await tool.handler({});
    await tool.handler({});
    expect(captures.map((capture) => capture['turnRef'])).toEqual([source.id, source.id]);
    expect(captures[0]?.['captureKey']).not.toBe(captures[1]?.['captureKey']);
  });

  it.each(['completed', 'ambiguous'])('uses genuine user provenance when recorded same-tool calls are %s', async (kind) => {
    const { context, ledger, conversation, captures, user } = await setup();
    const source = await user();
    await ledger.appendMessage(conversation.id, {
      role: 'tool', phase: 'tool_call', content: 'First call', createdAt: 1,
      rawJson: { metadata: { toolName: 'list_remote_nodes', toolUseId: 'native-call-a' } },
    });
    await ledger.appendMessage(conversation.id, {
      role: 'tool', phase: kind === 'completed' ? 'tool_result' : 'tool_call',
      content: 'Another event', createdAt: 2,
      rawJson: { metadata: { toolName: 'list_remote_nodes', toolUseId: kind === 'completed' ? 'native-call-a' : 'native-call-b' } },
    });
    const tool = createOrchestratorToolDefinitions({
      ...context, listRemoteNodes: async () => ({ connectedCount: 0, totalCount: 0, nodes: [] }),
    }).find((entry) => entry.name === 'list_remote_nodes')!;
    await tool.handler({});
    expect(captures[0]?.['turnRef']).toBe(source.id);
  });

  it('preserves shadow passthrough when provenance is missing', async () => {
    const { context, capture } = await setup();
    const tool = createOrchestratorToolDefinitions({
      ...context,
      contextEvidence: { ...context.contextEvidence!, mode: 'shadow' },
      listRemoteNodes: async () => ({ connectedCount: 0, totalCount: 0, nodes: [] }),
    }).find((entry) => entry.name === 'list_remote_nodes')!;
    await expect(tool.handler({})).resolves.toEqual({ connectedCount: 0, totalCount: 0, nodes: [] });
    expect(capture).not.toHaveBeenCalled();
  });
});

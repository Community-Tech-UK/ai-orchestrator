import { afterEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));
vi.mock('../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import {
  OrchestratorToolsRpcServer,
  _resetOrchestratorToolsRpcServerForTesting,
} from './orchestrator-tools-rpc-server';
import { createOrchestratorEvidenceToolDefinitions } from './orchestrator-evidence-tools';
import { ConversationLedgerService } from '../conversation-ledger';
import { NativeConversationRegistry } from '../conversation-ledger/native-conversation-registry';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { createOperatorTables } from '../operator/operator-schema';
import { ChatStore } from '../chats/chat-store';
import { ChatTranscriptBridge, flushChatTranscriptSource } from '../chats/chat-transcript-bridge';
import { createOrchestratorToolDefinitions } from './orchestrator-tools';

const runtime = vi.hoisted(() => ({ ledger: null as ConversationLedgerService | null }));
vi.mock('../conversation-ledger', async (importOriginal) => ({
  ...await importOriginal<typeof import('../conversation-ledger')>(),
  getConversationLedgerService: () => {
    if (!runtime.ledger) throw new Error('Synthetic ledger is not initialized');
    return runtime.ledger;
  },
}));

describe('orchestrator-tools evidence RPC', () => {
  afterEach(() => _resetOrchestratorToolsRpcServerForTesting());

  it('injects the canonical conversation resolved from the authenticated instance', async () => {
    const coordinator = coordinatorStub();
    const server = evidenceServer(coordinator);

    await server.handleRequest(request('orchestrator_tools.evidence_read', {
      evidenceId: 'evidence-1', startByte: 0, endByte: 7, tokenLimit: 512,
    }));

    expect(coordinator.read).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'canonical-conversation',
      evidenceId: 'evidence-1',
      requester: expect.objectContaining({ id: 'mcp:evidence_read:instance-known' }),
    }));
  });

  it('rejects a model-supplied conversation id before invoking retrieval', async () => {
    const coordinator = coordinatorStub();
    const server = evidenceServer(coordinator);

    await expect(server.handleRequest(request('orchestrator_tools.evidence_read', {
      conversationId: 'attacker-conversation',
      evidenceId: 'evidence-1', startByte: 0, endByte: 7, tokenLimit: 512,
    }))).rejects.toThrow();

    expect(coordinator.read).not.toHaveBeenCalled();
  });

  it('routes list, search, compare, and verify through their strict schemas', async () => {
    const coordinator = coordinatorStub();
    const server = evidenceServer(coordinator);

    await server.handleRequest(request('orchestrator_tools.evidence_list', { limit: 5 }));
    await server.handleRequest(request('orchestrator_tools.evidence_search', {
      query: 'needle', tokenLimit: 512,
    }));
    await server.handleRequest(request('orchestrator_tools.evidence_compare', {
      left: { evidenceId: 'a', startByte: 0, endByte: 1 },
      right: { evidenceId: 'b', startByte: 0, endByte: 1 },
    }));
    await server.handleRequest(request('orchestrator_tools.evidence_verify', {
      evidenceId: 'a', startByte: 0, endByte: 1, contentDigest: 'a'.repeat(64),
    }));

    expect(coordinator.list).toHaveBeenCalledOnce();
    expect(coordinator.search).toHaveBeenCalledOnce();
    expect(coordinator.compare).toHaveBeenCalledOnce();
    expect(coordinator.verify).toHaveBeenCalledOnce();
  });

  it.each(['injected', 'production'] as const)('persists a queued provider source before %s worker dispatch', async (factoryMode) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-evidence-source-'));
    const db = defaultDriverFactory(':memory:');
    createOperatorTables(db);
    const ledger = new ConversationLedgerService({
      dbPath: ':memory:', enableWAL: false, registry: new NativeConversationRegistry(),
    });
    runtime.ledger = ledger;
    const conversation = await ledger.startConversation({
      provider: 'orchestrator', metadata: { scope: 'instance', historyThreadId: 'history-known' },
    });
    const instance = {
      id: 'instance-known', provider: 'codex', historyThreadId: 'history-known',
      contextEvidence: { mode: 'enforce', conversationId: conversation.id, captureFailureCount: 0 },
    };
    const manager = Object.assign(new EventEmitter(), { getInstance: () => instance });
    const bridge = new ChatTranscriptBridge({
      ledger, chatStore: new ChatStore(db), instanceManager: manager as never,
      eventBus: new EventEmitter(), flushIntervalMs: 10_000,
    });
    bridge.start();
    const list = vi.fn(async () => {
      const source = (await ledger.getRecentConversation(conversation.id, 10)).messages;
      expect(source).toHaveLength(1);
      expect(source[0]).toMatchObject({ role: 'tool', phase: 'tool_call' });
      return { connectedCount: 0, totalCount: 0, nodes: [] };
    });
    const capture = vi.fn(async (input: { result: unknown }) => ({
      capture: {
        status: 'captured',
        record: { id: 'evidence-rpc-call', conversationId: conversation.id, status: 'complete' },
      },
      providerResult: input.result,
    }));
    const prepare = vi.fn(flushChatTranscriptSource);
    const server = new OrchestratorToolsRpcServer({
      operatorDbPath: path.join(root, 'operator.db'), userDataPath: root,
      isKnownLocalInstance: (id) => id === instance.id, registerCleanup: () => undefined,
      listRemoteNodes: list,
      prepareEvidenceSource: prepare,
      resolveContextEvidence: () => ({
        ...instance.contextEvidence, mode: 'enforce',
        coordinator: { ...coordinatorStub(), captureAioMcpResult: capture },
      }),
      ...(factoryMode === 'injected' ? {
        toolFactory: (context: Parameters<typeof createOrchestratorToolDefinitions>[0]) =>
          createOrchestratorToolDefinitions({ ...context, db, ledger }),
      } : {}),
    });
    try {
      manager.emit('provider:normalized-event', {
        instanceId: instance.id, eventId: 'call-known', provider: 'codex', seq: 1, timestamp: 1,
        event: { kind: 'tool_use', toolName: 'list_remote_nodes', toolUseId: 'call-known', input: {} },
      });
      expect((await ledger.getRecentConversation(conversation.id, 10)).messages).toHaveLength(0);

      await expect(server.handleRequest(request('orchestrator_tools.list_remote_nodes', {})))
        .resolves.toEqual({ connectedCount: 0, totalCount: 0, nodes: [] });

      const persisted = (await ledger.getRecentConversation(conversation.id, 10)).messages;
      expect(prepare).toHaveBeenCalledWith(instance.id);
      expect(list).toHaveBeenCalledTimes(1);
      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toMatchObject({ role: 'tool', phase: 'tool_call' });
      expect(capture).toHaveBeenCalledWith(expect.objectContaining({
        queueId: instance.id, conversationId: conversation.id, turnRef: persisted[0].id,
      }));
    } finally {
      bridge.stop();
      await server.stop();
      runtime.ledger = null;
      await ledger.close();
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects unresolved canonical ownership before dispatching a worker operation', async () => {
    const db = defaultDriverFactory(':memory:');
    createOperatorTables(db);
    const list = vi.fn(async () => ({ connectedCount: 0, totalCount: 0, nodes: [] }));
    const capture = vi.fn();
    const server = new OrchestratorToolsRpcServer({
      isKnownLocalInstance: () => true, registerCleanup: () => undefined,
      listRemoteNodes: list,
      resolveContextEvidence: () => ({
        mode: 'enforce', conversationId: null,
        coordinator: { ...coordinatorStub(), captureAioMcpResult: capture },
      }),
      toolFactory: (context) => createOrchestratorToolDefinitions({ ...context, db }),
    });
    try {
      await expect(server.handleRequest(request('orchestrator_tools.list_remote_nodes', {})))
        .rejects.toThrow(/EVIDENCE_CAPTURE_REQUIRED.*execution=not_started.*CONVERSATION_UNRESOLVED/);
      expect(list).not.toHaveBeenCalled();
      expect(capture).not.toHaveBeenCalled();
    } finally {
      await server.stop();
      db.close();
    }
  });

  it.each(
    (['injected', 'production'] as const).flatMap((factoryMode) =>
      (['prepare', 'lookup', 'handler'] as const).flatMap((stage) =>
        (['changed', 'off', 'missing'] as const).map((ownership) => ({ factoryMode, stage, ownership })))),
  )('rejects $ownership ownership after $stage awaits through $factoryMode RPC dispatch', async ({
    factoryMode, stage, ownership,
  }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-evidence-owner-'));
    const db = defaultDriverFactory(':memory:');
    createOperatorTables(db);
    const ledger = new ConversationLedgerService({
      dbPath: ':memory:', enableWAL: false, registry: new NativeConversationRegistry(),
    });
    runtime.ledger = ledger;
    const originalOwner = await ledger.startConversation({ provider: 'orchestrator' });
    const nextOwner = await ledger.startConversation({ provider: 'orchestrator' });
    await ledger.appendMessage(originalOwner.id, {
      role: 'user', content: 'Synthetic worker command', createdAt: 1,
      rawJson: { metadata: { instanceId: 'instance-known' } },
    });
    let liveOwner = originalOwner.id;
    let liveMode: 'off' | 'enforce' = 'enforce';
    let instanceExists = true;
    const invalidateOwnership = () => {
      if (ownership === 'changed') liveOwner = nextOwner.id;
      else if (ownership === 'off') liveMode = 'off';
      else instanceExists = false;
    };
    const capture = vi.fn(async (input: { result: unknown; conversationId: string }) => ({
      capture: {
        status: 'captured',
        record: { id: 'race-receipt', conversationId: input.conversationId, status: 'complete' },
      },
      providerResult: input.result,
    }));
    const exec = vi.fn(async () => {
      await Promise.resolve();
      if (stage === 'handler') invalidateOwnership();
      return {
        nodeId: 'synthetic-worker', nodeName: 'windows-pc', exitCode: 0,
        stdout: 'synthetic-result-do-not-retain', stderr: '', durationMs: 1,
        stdoutTruncated: false, stderrTruncated: false,
      };
    });
    const prepare = async () => {
      await Promise.resolve();
      if (stage === 'prepare') invalidateOwnership();
    };
    if (stage === 'lookup') {
      const read = ledger.getRecentConversation.bind(ledger);
      vi.spyOn(ledger, 'getRecentConversation').mockImplementationOnce(async (...args) => {
        const source = await read(...args);
        invalidateOwnership();
        return source;
      });
    }
    const server = new OrchestratorToolsRpcServer({
      operatorDbPath: path.join(root, 'operator.db'), userDataPath: root,
      isKnownLocalInstance: () => true, registerCleanup: () => undefined,
      execOnNode: exec, prepareEvidenceSource: prepare,
      resolveContextEvidence: () => instanceExists && liveMode !== 'off' ? {
        mode: 'enforce', conversationId: liveOwner,
        coordinator: { ...coordinatorStub(), captureAioMcpResult: capture },
      } : null,
      ...(factoryMode === 'injected' ? {
        toolFactory: (context: Parameters<typeof createOrchestratorToolDefinitions>[0]) =>
          createOrchestratorToolDefinitions({ ...context, db, ledger }),
      } : {}),
    });
    try {
      const failure = await server.handleRequest(request('orchestrator_tools.exec_on_node', {
        node: 'windows-pc', executable: 'fixture.exe', args: [],
      })).then(() => null, (error: Error) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure?.message).toMatch(/EVIDENCE_CAPTURE_REQUIRED/);
      expect(failure?.message).toContain(`execution=${stage === 'handler' ? 'completed' : 'not_started'}`);
      expect(failure?.message).not.toContain('synthetic-result-do-not-retain');
      expect(exec).toHaveBeenCalledTimes(stage === 'handler' ? 1 : 0);
      expect(capture).not.toHaveBeenCalled();
    } finally {
      await server.stop();
      runtime.ledger = null;
      await ledger.close();
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function evidenceServer(coordinator: ReturnType<typeof coordinatorStub>) {
  return new OrchestratorToolsRpcServer({
    isKnownLocalInstance: (instanceId) => instanceId === 'instance-known',
    registerCleanup: () => undefined,
    resolveContextEvidence: () => ({
      coordinator,
      conversationId: 'canonical-conversation',
      providerWindowTokens: 100_000,
    }),
    toolFactory: (context) => context.contextEvidence
      ? createOrchestratorEvidenceToolDefinitions({
          ...context.contextEvidence,
          instanceId: context.instanceId!,
        })
      : [],
  });
}

function request(method: string, payload: Record<string, unknown>) {
  return {
    jsonrpc: '2.0' as const,
    id: 1,
    method,
    params: { instanceId: 'instance-known', payload },
  };
}

function coordinatorStub() {
  return {
    list: vi.fn(async () => []),
    search: vi.fn(async () => []),
    read: vi.fn(async () => ({ ok: true })),
    compare: vi.fn(async () => ({ equal: false })),
    verify: vi.fn(async () => ({ verified: true })),
  };
}

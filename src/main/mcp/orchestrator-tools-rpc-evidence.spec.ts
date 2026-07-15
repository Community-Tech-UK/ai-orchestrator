import { afterEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));
vi.mock('../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import {
  OrchestratorToolsRpcServer,
  _resetOrchestratorToolsRpcServerForTesting,
} from './orchestrator-tools-rpc-server';
import { createOrchestratorEvidenceToolDefinitions } from './orchestrator-evidence-tools';

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

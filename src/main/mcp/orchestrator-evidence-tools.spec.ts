import { describe, expect, it, vi } from 'vitest';
import { createOrchestratorEvidenceToolDefinitions } from './orchestrator-evidence-tools';

describe('orchestrator evidence MCP tools', () => {
  it('registers the five provider-neutral tools without a model-controlled conversation id', () => {
    const tools = createOrchestratorEvidenceToolDefinitions(context());

    expect(tools.map((tool) => tool.name)).toEqual([
      'evidence_list',
      'evidence_search',
      'evidence_read',
      'evidence_compare',
      'evidence_verify',
    ]);
    for (const tool of tools) {
      expect(tool.inputSchema['properties']).not.toHaveProperty('conversationId');
    }
  });

  it('injects canonical conversation ownership and a provider requester', async () => {
    const h = context();
    const tool = createOrchestratorEvidenceToolDefinitions(h).find(
      (candidate) => candidate.name === 'evidence_read',
    );

    await tool!.handler({
      evidenceId: 'evidence-1',
      startByte: 0,
      endByte: 7,
      tokenLimit: 512,
    });

    expect(h.coordinator.read).toHaveBeenCalledWith({
      requester: {
        id: 'mcp:evidence_read:instance-1',
        path: 'provider',
        localSensitiveAuthorized: false,
        localRestrictedAuthorized: false,
      },
      conversationId: 'conversation-1',
      evidenceId: 'evidence-1',
      startByte: 0,
      endByte: 7,
      tokenLimit: 512,
      providerWindowTokens: 100_000,
    });
  });

  it('fails closed when the runtime has not injected canonical ownership', async () => {
    const h = context({ conversationId: null });
    const tool = createOrchestratorEvidenceToolDefinitions(h).find(
      (candidate) => candidate.name === 'evidence_list',
    );

    await expect(tool!.handler({})).rejects.toThrow('EVIDENCE_CONVERSATION_UNRESOLVED');
    expect(h.coordinator.list).not.toHaveBeenCalled();
  });

  it('validates search, compare, and digest arguments before delegation', async () => {
    const h = context();
    const tools = createOrchestratorEvidenceToolDefinitions(h);

    await expect(tools.find((tool) => tool.name === 'evidence_search')!.handler({
      query: '', tokenLimit: 512,
    })).rejects.toThrow();
    await expect(tools.find((tool) => tool.name === 'evidence_compare')!.handler({
      left: { evidenceId: 'a', startByte: 1, endByte: 1 },
      right: { evidenceId: 'b', startByte: 0, endByte: 1 },
    })).rejects.toThrow();
    await expect(tools.find((tool) => tool.name === 'evidence_verify')!.handler({
      evidenceId: 'a', startByte: 0, endByte: 1, contentDigest: 'plaintext',
    })).rejects.toThrow();

    expect(h.coordinator.search).not.toHaveBeenCalled();
    expect(h.coordinator.compare).not.toHaveBeenCalled();
    expect(h.coordinator.verify).not.toHaveBeenCalled();
  });

  it('injects the known provider window into compare and verify bounds', async () => {
    const h = context();
    const tools = createOrchestratorEvidenceToolDefinitions(h);

    await tools.find((tool) => tool.name === 'evidence_compare')!.handler({
      left: { evidenceId: 'a', startByte: 0, endByte: 1 },
      right: { evidenceId: 'b', startByte: 0, endByte: 1 },
    });
    await tools.find((tool) => tool.name === 'evidence_verify')!.handler({
      evidenceId: 'a', startByte: 0, endByte: 1, contentDigest: 'a'.repeat(64),
    });

    expect(h.coordinator.compare).toHaveBeenCalledWith(expect.objectContaining({
      providerWindowTokens: 100_000,
    }));
    expect(h.coordinator.verify).toHaveBeenCalledWith(expect.objectContaining({
      providerWindowTokens: 100_000,
    }));
  });
});

function context(overrides: { conversationId?: string | null } = {}) {
  return {
    instanceId: 'instance-1',
    conversationId: overrides.conversationId === undefined
      ? 'conversation-1'
      : overrides.conversationId,
    providerWindowTokens: 100_000,
    coordinator: {
      list: vi.fn(async () => []),
      search: vi.fn(async () => []),
      read: vi.fn(async () => ({ ok: true })),
      compare: vi.fn(async () => ({ equal: true })),
      verify: vi.fn(async () => ({ verified: true })),
    },
  };
}

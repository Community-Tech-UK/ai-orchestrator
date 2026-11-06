import { describe, expect, it, vi } from 'vitest';
import { createSessionReadToolDefinitions, createSessionReadForwarderTools, ReadSessionArgsSchema } from './orchestrator-session-read-tools';
import { createOrchestratorToolsForwarderTools } from './orchestrator-tools-mcp-forwarder';
import { createDeferredOrchestratorTools, ORCHESTRATOR_CORE_TOOL_NAMES } from './orchestrator-mcp-deferral';
import { createStableOrchestratorTools } from './orchestrator-mcp-stable-tools';
import { OrchestratorToolsRpcServer } from './orchestrator-tools-rpc-server';
import type { SessionTranscriptReader } from '../session/session-transcript-reader';
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));

describe('read session tools', () => {
  it('validates strict arguments before forwarding and defaults the page size', async () => {
    expect(ReadSessionArgsSchema.safeParse({ session: 'self', spoofed: true }).success).toBe(false);
    expect(ReadSessionArgsSchema.parse({ session: 'self' }).limit).toBe(20);
    const call = vi.fn(async () => ({ outcome: 'not-found' }));
    const [tool] = createSessionReadForwarderTools({ call });
    await tool.handler({ session: 'self' });
    expect(call).toHaveBeenCalledWith('orchestrator_tools.read_session', expect.objectContaining({ session: 'self', limit: 20 }));
  });
  it('constructs tools before startup without resolving the reader', async () => {
    const getReader = vi.fn(() => { throw new Error('not ready'); });
    const [tool] = createSessionReadToolDefinitions({ instanceId: 'caller', getReader });
    expect(getReader).not.toHaveBeenCalled();
    expect(await tool.handler({ session: 'self' })).toMatchObject({ outcome: 'not-allowed', reason: expect.stringContaining('not ready') });
  });
  it('passes the trusted caller and dispatches validated RPC even at the spawn-depth limit', async () => {
    const read = vi.fn(async () => ({ outcome: 'not-found' as const }));
    const server = new OrchestratorToolsRpcServer({ userDataPath: '/tmp', isKnownLocalInstance: () => true,
      resolveSpawnEligibility: () => false, registerCleanup: () => undefined,
      toolFactory: (ctx) => createSessionReadToolDefinitions({ instanceId: ctx.instanceId, getReader: () => ({ read }) as unknown as SessionTranscriptReader }) });
    const request = { jsonrpc: '2.0' as const, id: 1, method: 'orchestrator_tools.read_session', params: { instanceId: 'caller', payload: { session: 'self' } } };
    expect(await server.handleRequest(request)).toEqual({ outcome: 'not-found' });
    expect(read).toHaveBeenCalledWith('caller', expect.objectContaining({ session: 'self', limit: 20 }));
    await expect(server.handleRequest({ ...request, params: { ...request.params, payload: { session: 'self', caller: 'other' } } })).rejects.toThrow();
  });
  it.each(['stable', 'deferred'])('discovers session reading first in %s mode without adding it to core tools', async (mode) => {
    const all = createOrchestratorToolsForwarderTools({ call: async () => null });
    const tools = mode === 'stable' ? createStableOrchestratorTools(all) : createDeferredOrchestratorTools(all, { onReveal: () => undefined });
    const search = tools.find((tool) => tool.name === 'orchestrator.tool_search')!;
    const result = await search.handler({ query: "read another session's conversation" }) as { matches: { name: string }[] };
    expect(result.matches[0]?.name).toBe('read_session');
    expect(ORCHESTRATOR_CORE_TOOL_NAMES).not.toContain('read_session');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createSessionReadToolDefinitions, createSessionReadForwarderTools, ReadSessionArgsSchema } from './orchestrator-session-read-tools';
import { createOrchestratorToolsForwarderTools } from './orchestrator-tools-mcp-forwarder';
import { createDeferredOrchestratorTools, ORCHESTRATOR_CORE_TOOL_NAMES } from './orchestrator-mcp-deferral';
import { createStableOrchestratorTools } from './orchestrator-mcp-stable-tools';
import { OrchestratorToolsRpcServer } from './orchestrator-tools-rpc-server';
import { SessionTranscriptReader } from '../session/session-transcript-reader';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));

describe('read session tools', () => {
  it('reads a user-supplied session ID through RPC without a special mention', async () => {
    const message: OutputMessage = { id: 'typed', type: 'user', timestamp: 1,
      content: 'sessionID = i6avhn1bc\n\nPlease continue', metadata: { inputOrigin: { kind: 'person', typedAt: 1 } } };
    const instances = [
      { id: 'caller', displayName: 'Caller', workingDirectory: '/project', parentId: null, lastActivity: 1, outputBuffer: [message] },
      { id: 'i6avhn1bc', displayName: 'Earlier work', workingDirectory: '/elsewhere', parentId: null, lastActivity: 1,
        outputBuffer: [{ id: 'reply', type: 'assistant', timestamp: 1, content: 'The next task is ready.' }] },
    ] as Instance[];
    const reader = new SessionTranscriptReader({
      getInstance: (id) => instances.find((instance) => instance.id === id), getAllInstances: () => instances,
      getSettings: () => ({ interSessionMessaging: { enabled: false } }),
      history: { getEntries: () => [], loadConversation: async () => null },
      getCompleteInstanceMessages: async (instance) => instance.outputBuffer,
      scratchDirectory: '/scratch', writeAudit: vi.fn(),
    });
    const server = new OrchestratorToolsRpcServer({ userDataPath: '/tmp', isKnownLocalInstance: () => true,
      registerCleanup: () => undefined,
      toolFactory: (ctx) => createSessionReadToolDefinitions({ instanceId: ctx.instanceId, getReader: () => reader }) });
    expect(await server.handleRequest({ jsonrpc: '2.0', id: 1, method: 'orchestrator_tools.read_session',
      params: { instanceId: 'caller', payload: { session: 'i6avhn1bc' } } })).toMatchObject({
      outcome: 'ok', items: [{ text: 'The next task is ready.' }],
    });
  });
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

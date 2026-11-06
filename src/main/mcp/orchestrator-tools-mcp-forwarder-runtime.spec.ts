import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServerToolDefinition } from './mcp-server-tools';
import type { OrchestratorToolsRpcClientLike } from './orchestrator-tools-rpc-client';
import {
  ORCHESTRATOR_TOOL_DEFERRAL_ENV,
  REMOTE_WORKER_CORE_TOOL_NAMES,
} from './orchestrator-mcp-deferral';
import { ORCHESTRATOR_TOOL_STABLE_ENV } from './orchestrator-mcp-stable-tools';
import {
  WORKER_ROSTER_PROBE_TIMEOUT_MS,
  probeRemoteWorkersConnected,
  resolveOrchestratorForwarderTools,
  runOrchestratorToolsForwarder,
} from './orchestrator-tools-mcp-forwarder-runtime';
import { createOrchestratorToolsForwarderTools } from './orchestrator-tools-mcp-forwarder';

const forwarder = vi.hoisted(() => ({ runStdioMcpForwarder: vi.fn<(options: unknown) => Promise<void>>(async () => undefined) }));
vi.mock('./mcp-stdio-forwarder', () => forwarder);

const ROSTER_METHOD = 'orchestrator_tools.list_remote_nodes';
const roster = (value: unknown) => ({ call: vi.fn(async () => value) });
const visibleNames = (tools: McpServerToolDefinition[]) => tools.filter((tool) => !tool.hidden).map((tool) => tool.name);
const remoteNames: readonly string[] = REMOTE_WORKER_CORE_TOOL_NAMES;

/** Starts the forwarder with a stub stdio runner and returns the tool list it would register. */
async function startedTools(client: OrchestratorToolsRpcClientLike): Promise<McpServerToolDefinition[]> {
  forwarder.runStdioMcpForwarder.mockClear();
  await runOrchestratorToolsForwarder(client);
  expect(forwarder.runStdioMcpForwarder).toHaveBeenCalledOnce();
  const { tools } = forwarder.runStdioMcpForwarder.mock.calls[0][0] as unknown as {
    tools: (server: { revealTools: () => void }) => McpServerToolDefinition[];
  };
  return tools({ revealTools: vi.fn() });
}

describe('probeRemoteWorkersConnected', () => {
  afterEach(() => vi.useRealTimers());

  it('asks the roster once and reports no connected worker', async () => {
    const client = roster({ connectedCount: 0, totalCount: 2, nodes: [{ connected: false }, { connected: false }] });
    await expect(probeRemoteWorkersConnected(client)).resolves.toBe(false);
    expect(client.call).toHaveBeenCalledExactlyOnceWith(ROSTER_METHOD, {}, { timeoutMs: WORKER_ROSTER_PROBE_TIMEOUT_MS });
  });

  it.each([
    ['a connected count', { connectedCount: 2, totalCount: 2, nodes: [] }, true],
    ['one connected node and no count', { nodes: [{ status: 'disconnected' }, { connected: true }] }, true],
    ['a node whose status says connected', { nodes: [{ status: 'connected' }] }, true],
    ['only disconnected nodes and no count', { nodes: [{ connected: false }, { status: 'offline' }] }, false],
    ['an empty roster', { nodes: [] }, false],
  ])('reads %s', async (_label, answer, expected) => {
    await expect(probeRemoteWorkersConnected(roster(answer))).resolves.toBe(expected);
  });

  it.each([
    ['null', null], ['a string', 'ok'], ['an empty object', {}], ['a non-array node list', { nodes: 'none' }],
    ['a negative count', { connectedCount: -1, nodes: [] }], ['a NaN count', { connectedCount: Number.NaN }],
    ['an unfamiliar node', { nodes: [{ id: 'worker-placeholder' }] }], ['a null node', { nodes: [null] }],
  ])('keeps the tools visible (unknown) for %s', async (_label, answer) => {
    await expect(probeRemoteWorkersConnected(roster(answer))).resolves.toBeUndefined();
  });

  it('keeps the tools visible after a synchronous client failure and clears its deadline', async () => {
    vi.useFakeTimers();
    await expect(probeRemoteWorkersConnected({ call: () => { throw new Error('client setup failed'); } })).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the tools visible when the roster call fails, even late', async () => {
    let rejectLate!: (error: Error) => void;
    const slow = { call: vi.fn(() => new Promise<never>((_resolve, reject) => { rejectLate = reject; })) };
    vi.useFakeTimers();
    const pending = probeRemoteWorkersConnected(slow, 100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toBeUndefined();
    rejectLate(new Error('socket closed after the deadline')); // must not become an unhandled rejection
    await vi.advanceTimersByTimeAsync(1);

    await expect(probeRemoteWorkersConnected({ call: vi.fn(async () => { throw new Error('unavailable'); }) })).resolves.toBeUndefined();
  });

  it('gives up after the default deadline and leaves no timer behind once answered', async () => {
    vi.useFakeTimers();
    const hung = probeRemoteWorkersConnected({ call: vi.fn(() => new Promise<never>(() => undefined)) });
    await vi.advanceTimersByTimeAsync(WORKER_ROSTER_PROBE_TIMEOUT_MS);
    await expect(hung).resolves.toBeUndefined();

    await probeRemoteWorkersConnected(roster({ connectedCount: 0, nodes: [] }));
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('orchestrator forwarder tool listing', () => {
  const stub = { call: vi.fn(async () => ({})) };

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv(ORCHESTRATOR_TOOL_DEFERRAL_ENV, '');
    vi.stubEnv(ORCHESTRATOR_TOOL_STABLE_ENV, '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('hides the remote-worker tools in deferred mode only when told no worker is connected', () => {
    vi.stubEnv(ORCHESTRATOR_TOOL_DEFERRAL_ENV, '1');
    const shown = visibleNames(resolveOrchestratorForwarderTools(stub, vi.fn(), { remoteWorkersConnected: true }));
    const hidden = visibleNames(resolveOrchestratorForwarderTools(stub, vi.fn(), { remoteWorkersConnected: false }));

    for (const name of remoteNames) {
      expect(shown).toContain(name);
      expect(hidden).not.toContain(name);
    }
    expect(visibleNames(resolveOrchestratorForwarderTools(stub, vi.fn()))).toEqual(shown);
  });

  it('drops them from the fixed core in stable mode, still reachable through the execute wrapper', () => {
    vi.stubEnv(ORCHESTRATOR_TOOL_STABLE_ENV, '1');
    const names = resolveOrchestratorForwarderTools(stub, vi.fn(), { remoteWorkersConnected: false }).map((tool) => tool.name);

    expect(names).toContain('orchestrator.tool_execute');
    for (const name of remoteNames) expect(names).not.toContain(name);
  });

  it('never trims the eager surface', () => {
    const all = createOrchestratorToolsForwarderTools(stub).map((tool) => tool.name);
    expect(resolveOrchestratorForwarderTools(stub, vi.fn(), { remoteWorkersConnected: false }).map((tool) => tool.name)).toEqual(all);
  });
});

describe('runOrchestratorToolsForwarder', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv(ORCHESTRATOR_TOOL_DEFERRAL_ENV, '');
    vi.stubEnv(ORCHESTRATOR_TOOL_STABLE_ENV, '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ['deferred', ORCHESTRATOR_TOOL_DEFERRAL_ENV],
    ['stable', ORCHESTRATOR_TOOL_STABLE_ENV],
  ])('reads the roster once before starting and hides the remote tools in %s mode when it is empty', async (_mode, env) => {
    vi.stubEnv(env, '1');
    const client = roster({ connectedCount: 0, totalCount: 0, nodes: [] });

    const tools = await startedTools(client);

    expect(client.call).toHaveBeenCalledExactlyOnceWith(ROSTER_METHOD, {}, { timeoutMs: WORKER_ROSTER_PROBE_TIMEOUT_MS });
    const direct = tools.filter((tool) => !tool.hidden).map((tool) => tool.name);
    for (const name of remoteNames) expect(direct).not.toContain(name);
    expect(direct).toContain('list_settings');
  });

  it('keeps the remote tools visible when a worker is connected', async () => {
    vi.stubEnv(ORCHESTRATOR_TOOL_DEFERRAL_ENV, '1');
    const tools = await startedTools(roster({ connectedCount: 1, totalCount: 1, nodes: [{ connected: true }] }));
    for (const name of remoteNames) expect(visibleNames(tools)).toContain(name);
  });

  it('keeps the remote tools visible when the roster cannot be read', async () => {
    vi.stubEnv(ORCHESTRATOR_TOOL_STABLE_ENV, '1');
    const tools = await startedTools({ call: vi.fn(async () => { throw new Error('orchestrator-tools RPC unavailable'); }) });
    for (const name of remoteNames) expect(tools.map((tool) => tool.name)).toContain(name);
  });

  it('does not read the roster at all in eager mode, where nothing is hidden', async () => {
    const client = roster({ connectedCount: 0, nodes: [] });
    const tools = await startedTools(client);

    expect(client.call).not.toHaveBeenCalled();
    for (const name of remoteNames) expect(tools.map((tool) => tool.name)).toContain(name);
  });
});

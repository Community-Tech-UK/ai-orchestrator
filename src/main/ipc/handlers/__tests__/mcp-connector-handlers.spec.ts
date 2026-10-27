import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WindowManager } from '../../../window-manager';

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>(),
  signIn: vi.fn(), signOut: vi.fn(), setBearerToken: vi.fn(), testConnector: vi.fn(),
  upsert: vi.fn(), broadcast: vi.fn(),
  records: [] as { record: { id: string; name: string } }[],
  connectAccount: vi.fn(),
  managedServers: new Set<string>(),
}));
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => state.handlers.set(channel, handler) } }));
vi.mock('../../../mcp/mcp-manager', () => ({ getMcpManager: () => ({ on: vi.fn(), getServerStatus: vi.fn(), addServer: vi.fn(), upsertServer: vi.fn(), removeServer: async (id: string) => { state.managedServers.delete(id); } }) }));
vi.mock('../../../mcp/mcp-lifecycle-manager', () => ({ getMcpLifecycleManager: () => ({}) }));
vi.mock('../../../mcp/connector-auth-service', () => ({ getConnectorAuthService: () => state }));
vi.mock('../../../graph/graph-connector-service', () => ({ getGraphConnectorService: () => ({ connectAccount: state.connectAccount }) }));
vi.mock('../../../mcp/mcp-multi-provider-singletons', () => ({
  getOrchestratorMcpRepository: () => ({ list: () => state.records, get: () => ({ record: { id: 'connector', name: 'remote-example', kind: 'remote', authType: 'bearer' } }) }),
  getCliMcpConfigService: () => ({
    getMultiProviderState: async () => ({ orchestrator: [], providers: [], stateVersion: 1 }),
    orchestratorUpsert: state.upsert,
  }),
}));
import { registerMcpHandlers } from '../mcp-handlers';

describe('Connector handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks(); state.handlers.clear();
    state.records = [];
    state.managedServers.clear();
    state.connectAccount.mockResolvedValue({ accountKey: 'PLACEHOLDER_ACCOUNT', username: 'person@example.test', tenant: 'PLACEHOLDER_TENANT' });
    state.upsert.mockReturnValue({ record: { id: 'connector', name: 'm365-example', kind: 'microsoft365' } });
    registerMcpHandlers({ windowManager: { sendToRenderer: state.broadcast } as unknown as WindowManager });
  });

  it('removes every Shared write and drift handler', () => {
    expect([...state.handlers.keys()].filter((channel) => channel.startsWith('mcp:shared:'))).toEqual([]);
  });

  it('validates bearer writes and never returns the bearer value', async () => {
    const handler = state.handlers.get('mcp:connector:auth');
    expect(handler).toBeDefined();
    expect(await handler!({}, { serverId: 'connector', action: 'set-bearer' })).toMatchObject({ success: false });
    expect(state.setBearerToken).not.toHaveBeenCalled();
    const result = await handler!({}, { serverId: 'connector', action: 'set-bearer', bearerToken: 'PLACEHOLDER_TOKEN' });
    expect(result).toEqual({ success: true });
    expect(state.setBearerToken).toHaveBeenCalledWith('connector', 'PLACEHOLDER_TOKEN');
    expect(JSON.stringify(result)).not.toContain('PLACEHOLDER_TOKEN');
  });

  it('creates an account connector after Microsoft sign-in', async () => {
    const handler = state.handlers.get('mcp:connector:add-microsoft365');
    expect(handler).toBeDefined();
    expect(await handler!({}, { name: 'm365-example', mailEnabled: false, injectInto: ['claude'] })).toEqual({ success: true });
    expect(state.upsert).toHaveBeenCalledWith(expect.objectContaining({ name: 'm365-example', kind: 'microsoft365', accountId: 'PLACEHOLDER_ACCOUNT', mailEnabled: false }));
  });

  it('rejects duplicate or reserved Microsoft connector names before signing in', async () => {
    const handler = state.handlers.get('mcp:connector:add-microsoft365')!;
    state.records = [{ record: { id: 'existing', name: 'm365-example' } }];
    expect(await handler({}, { name: 'M365-example', mailEnabled: false })).toMatchObject({ success: false });
    expect(await handler({}, { name: 'browser-gateway', mailEnabled: false })).toMatchObject({ success: false });
    expect(await handler({}, { name: 'm365_example', mailEnabled: false })).toMatchObject({ success: false });
    expect(state.connectAccount).not.toHaveBeenCalled();
  });

  it('disconnects the old local program when an accepted edit changes it to a remote connector', async () => {
    state.managedServers.add('connector');
    state.upsert.mockReturnValue({ record: { id: 'connector', name: 'remote-example', kind: 'remote', transport: 'http', url: 'https://example.test/mcp' } });
    const handler = state.handlers.get('mcp:orchestrator:upsert')!;
    expect(await handler({}, { id: 'connector', name: 'remote-example', kind: 'remote', transport: 'http', url: 'https://example.test/mcp' })).toMatchObject({ success: true });
    expect(state.managedServers.has('connector')).toBe(false);
  });
});

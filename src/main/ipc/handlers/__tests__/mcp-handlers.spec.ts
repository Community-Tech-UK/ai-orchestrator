/**
 * Tests for MCP IPC handlers.
 *
 * Strategy: mock `electron` to capture ipcMain.handle registrations, then
 * invoke the captured handlers directly to verify validation + delegation
 * behavior without launching an Electron process.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IpcResponse } from '../../../../shared/types/ipc.types';
import type { WindowManager } from '../../../window-manager';

// ============================================================
// 1. Mock electron BEFORE any import that would pull it in
// ============================================================

type IpcHandler = (event: unknown, payload?: unknown) => Promise<unknown>;
const handlers = new Map<string, IpcHandler>();

const mockWebContentsSend = vi.fn();
const mockGetMainWindow = vi.fn().mockReturnValue({
  webContents: { send: mockWebContentsSend },
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
  },
}));

// ============================================================
// 2. Mock the logger
// ============================================================

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

// ============================================================
// 3. Build a fake McpManager and mock the singleton getter
// ============================================================

const mockMcp = {
  on: vi.fn(),
  getState: vi.fn().mockReturnValue({ servers: [], tools: [], resources: [], prompts: [] }),
  getServers: vi.fn().mockReturnValue([]),
  addServer: vi.fn(),
  removeServer: vi.fn().mockResolvedValue(undefined),
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  restart: vi.fn().mockResolvedValue(undefined),
  getTools: vi.fn().mockReturnValue([]),
  getResources: vi.fn().mockReturnValue([]),
  getPrompts: vi.fn().mockReturnValue([]),
  callTool: vi.fn().mockResolvedValue({ success: true, content: [] }),
  readResource: vi.fn().mockResolvedValue({ success: true, contents: [] }),
  getPrompt: vi.fn().mockResolvedValue({ success: true, messages: [] }),
};

vi.mock('../../../mcp/mcp-manager', () => ({
  getMcpManager: () => mockMcp,
}));

const mockLifecycle = {
  getState: vi.fn().mockReturnValue({ servers: [], tools: [], resources: [], prompts: [] }),
  getServers: vi.fn().mockReturnValue([]),
  connect: vi.fn().mockResolvedValue(undefined),
  restart: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../../mcp/mcp-lifecycle-manager', () => ({
  getMcpLifecycleManager: () => mockLifecycle,
}));

// ============================================================
// 4. Mock browser automation health service
// ============================================================

const mockDiagnose = vi.fn().mockResolvedValue({ status: 'ready', sources: [] });

vi.mock('../../../browser-automation/browser-automation-health', () => ({
  getBrowserAutomationHealthService: () => ({
    diagnose: mockDiagnose,
  }),
}));

// ============================================================
// 5. Mock MCP_SERVER_PRESETS (avoids transitive fs reads)
// ============================================================

vi.mock('../../../../shared/types/mcp.types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../shared/types/mcp.types')>();
  return {
    ...actual,
    MCP_SERVER_PRESETS: [{ id: 'preset-1', name: 'Test Preset' }],
  };
});

// ============================================================
// 6. Import SUT after mocks
// ============================================================

import { registerMcpHandlers } from '../mcp-handlers';
import { IPC_CHANNELS } from '../../../../shared/types/ipc.types';

// ============================================================
// 7. Helper: invoke a registered handler as IpcResponse
// ============================================================

async function invoke(
  channel: string,
  payload?: unknown
): Promise<IpcResponse<Record<string, unknown>>> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for channel: ${channel}`);
  return handler({} /* event */, payload) as Promise<IpcResponse<Record<string, unknown>>>;
}

function makeMockWindowManager(): WindowManager {
  return {
    getMainWindow: mockGetMainWindow,
  } as unknown as WindowManager;
}

// ============================================================
// 8. Tests
// ============================================================

describe('mcp-handlers', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();

    // Re-set default mock return values cleared by clearAllMocks
    mockMcp.getState.mockReturnValue({ servers: [], tools: [], resources: [], prompts: [] });
    mockMcp.getServers.mockReturnValue([]);
    mockMcp.getTools.mockReturnValue([]);
    mockMcp.getResources.mockReturnValue([]);
    mockMcp.getPrompts.mockReturnValue([]);
    mockMcp.removeServer.mockResolvedValue(undefined);
    mockMcp.connect.mockResolvedValue(undefined);
    mockMcp.disconnect.mockResolvedValue(undefined);
    mockMcp.restart.mockResolvedValue(undefined);
    mockMcp.callTool.mockResolvedValue({ success: true, content: [] });
    mockMcp.readResource.mockResolvedValue({ success: true, contents: [] });
    mockMcp.getPrompt.mockResolvedValue({ success: true, messages: [] });
    mockLifecycle.getState.mockReturnValue({ servers: [], tools: [], resources: [], prompts: [] });
    mockLifecycle.getServers.mockReturnValue([]);
    mockLifecycle.connect.mockResolvedValue(undefined);
    mockLifecycle.restart.mockResolvedValue(undefined);
    mockGetMainWindow.mockReturnValue({ webContents: { send: mockWebContentsSend } });
    mockDiagnose.mockResolvedValue({ status: 'ready', sources: [] });

    registerMcpHandlers({ windowManager: makeMockWindowManager() });
  });

  // ----------------------------------------------------------
  // Handler registration
  // ----------------------------------------------------------

  describe('handler registration', () => {
    it('registers all expected MCP IPC channels', () => {
      const expectedChannels = [
        IPC_CHANNELS.MCP_GET_STATE,
        IPC_CHANNELS.MCP_GET_SERVERS,
        IPC_CHANNELS.MCP_ADD_SERVER,
        IPC_CHANNELS.MCP_REMOVE_SERVER,
        IPC_CHANNELS.MCP_CONNECT,
        IPC_CHANNELS.MCP_DISCONNECT,
        IPC_CHANNELS.MCP_RESTART,
        IPC_CHANNELS.MCP_GET_TOOLS,
        IPC_CHANNELS.MCP_GET_RESOURCES,
        IPC_CHANNELS.MCP_GET_PROMPTS,
        IPC_CHANNELS.MCP_CALL_TOOL,
        IPC_CHANNELS.MCP_READ_RESOURCE,
        IPC_CHANNELS.MCP_GET_PROMPT,
        IPC_CHANNELS.MCP_GET_PRESETS,
        IPC_CHANNELS.MCP_GET_BROWSER_AUTOMATION_HEALTH,
      ];

      for (const channel of expectedChannels) {
        expect(handlers.has(channel), `handler missing for: ${channel}`).toBe(true);
      }
    });

    it('subscribes to McpManager events for renderer forwarding', () => {
      // on() is called for server:connected, server:disconnected, server:error,
      // tools:updated, resources:updated, prompts:updated
      expect(mockMcp.on).toHaveBeenCalledWith('server:connected', expect.any(Function));
      expect(mockMcp.on).toHaveBeenCalledWith('server:disconnected', expect.any(Function));
      expect(mockMcp.on).toHaveBeenCalledWith('server:error', expect.any(Function));
      expect(mockMcp.on).toHaveBeenCalledWith('tools:updated', expect.any(Function));
      expect(mockMcp.on).toHaveBeenCalledWith('resources:updated', expect.any(Function));
      expect(mockMcp.on).toHaveBeenCalledWith('prompts:updated', expect.any(Function));
    });
  });

  // ----------------------------------------------------------
  // MCP_GET_STATE
  // ----------------------------------------------------------

  describe('MCP_GET_STATE', () => {
    it('returns success with state data', async () => {
      const fakeState = { servers: [{ id: 's1' }], tools: [], resources: [], prompts: [] };
      mockLifecycle.getState.mockReturnValue(fakeState);

      const result = await invoke(IPC_CHANNELS.MCP_GET_STATE);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(fakeState);
      expect(mockLifecycle.getState).toHaveBeenCalledOnce();
    });

    it('returns failure when getState throws', async () => {
      mockLifecycle.getState.mockImplementation(() => { throw new Error('state error'); });

      const result = await invoke(IPC_CHANNELS.MCP_GET_STATE);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MCP_GET_STATE_FAILED');
      expect(result.error?.message).toContain('state error');
    });
  });

  // ----------------------------------------------------------
  // MCP_GET_SERVERS
  // ----------------------------------------------------------

  describe('MCP_GET_SERVERS', () => {
    it('returns success with servers list', async () => {
      const fakeServers = [{ id: 's1', name: 'My Server' }];
      mockLifecycle.getServers.mockReturnValue(fakeServers);

      const result = await invoke(IPC_CHANNELS.MCP_GET_SERVERS);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(fakeServers);
    });

    it('returns failure when getServers throws', async () => {
      mockLifecycle.getServers.mockImplementation(() => { throw new Error('servers error'); });

      const result = await invoke(IPC_CHANNELS.MCP_GET_SERVERS);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MCP_GET_SERVERS_FAILED');
    });
  });

  // ----------------------------------------------------------
  // MCP_ADD_SERVER
  // ----------------------------------------------------------

  describe('MCP_ADD_SERVER', () => {
    const validAddPayload = {
      id: 'server-1',
      name: 'Test Server',
      transport: 'stdio' as const,
      command: 'node',
      args: ['server.js'],
    };

    it('calls addServer with validated payload', async () => {
      const result = await invoke(IPC_CHANNELS.MCP_ADD_SERVER, validAddPayload);

      expect(result.success).toBe(true);
      expect(mockMcp.addServer).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'server-1', name: 'Test Server' })
      );
    });

    it('rejects invalid payload (missing required id)', async () => {
      const result = await invoke(IPC_CHANNELS.MCP_ADD_SERVER, { name: 'Bad', transport: 'stdio' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MCP_ADD_SERVER_FAILED');
      expect(mockMcp.addServer).not.toHaveBeenCalled();
    });

    it('returns failure when addServer throws', async () => {
      mockMcp.addServer.mockImplementation(() => { throw new Error('add failed'); });

      const result = await invoke(IPC_CHANNELS.MCP_ADD_SERVER, validAddPayload);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MCP_ADD_SERVER_FAILED');
    });
  });

  // ----------------------------------------------------------
  // MCP_REMOVE_SERVER
  // ----------------------------------------------------------

  describe('MCP_REMOVE_SERVER', () => {
    it('calls removeServer with the serverId', async () => {
      const result = await invoke(IPC_CHANNELS.MCP_REMOVE_SERVER, { serverId: 'server-1' });

      expect(result.success).toBe(true);
      expect(mockMcp.removeServer).toHaveBeenCalledWith('server-1');
    });

    it('rejects invalid payload (missing serverId)', async () => {
      const result = await invoke(IPC_CHANNELS.MCP_REMOVE_SERVER, {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MCP_REMOVE_SERVER_FAILED');
    });

    it('returns failure when removeServer rejects', async () => {
      mockMcp.removeServer.mockRejectedValue(new Error('remove failed'));

      const result = await invoke(IPC_CHANNELS.MCP_REMOVE_SERVER, { serverId: 'server-1' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MCP_REMOVE_SERVER_FAILED');
    });
  });

  // ----------------------------------------------------------
  // MCP_CONNECT
  // ----------------------------------------------------------

  describe('MCP_CONNECT', () => {
    it('connects to the specified server', async () => {
      const result = await invoke(IPC_CHANNELS.MCP_CONNECT, { serverId: 'server-1' });

      expect(result.success).toBe(true);
      expect(mockLifecycle.connect).toHaveBeenCalledWith('server-1');
    });

    it('rejects invalid payload', async () => {
      const result = await invoke(IPC_CHANNELS.MCP_CONNECT, { wrongField: 'x' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MCP_CONNECT_FAILED');
    });

    it('returns failure when connect rejects', async () => {
      mockLifecycle.connect.mockRejectedValue(new Error('connection refused'));

      const result = await invoke(IPC_CHANNELS.MCP_CONNECT, { serverId: 'server-1' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MCP_CONNECT_FAILED');
      expect(result.error?.message).toContain('connection refused');
    });
  });

  // ----------------------------------------------------------
  // MCP_DISCONNECT
  // ----------------------------------------------------------

  describe('MCP_DISCONNECT', () => {
    it('disconnects from the specified server', async () => {
      const result = await invoke(IPC_CHANNELS.MCP_DISCONNECT, { serverId: 'server-2' });

      expect(result.success).toBe(true);
      expect(mockMcp.disconnect).toHaveBeenCalledWith('server-2');
    });

    it('returns failure when disconnect rejects', async () => {
      mockMcp.disconnect.mockRejectedValue(new Error('disconnect failed'));

      const result = await invoke(IPC_CHANNELS.MCP_DISCONNECT, { serverId: 'server-2' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MCP_DISCONNECT_FAILED');
    });
  });

  // ----------------------------------------------------------
  // MCP_RESTART
  // ----------------------------------------------------------

  describe('MCP_RESTART', () => {
    it('restarts the specified server', async () => {
      const result = await invoke(IPC_CHANNELS.MCP_RESTART, { serverId: 'server-1' });

      expect(result.success).toBe(true);
      expect(mockLifecycle.restart).toHaveBeenCalledWith('server-1');
    });

    it('returns failure when restart rejects', async () => {
      mockLifecycle.restart.mockRejectedValue(new Error('restart error'));

      const result = await invoke(IPC_CHANNELS.MCP_RESTART, { serverId: 'server-1' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MCP_RESTART_FAILED');
    });
  });

  // ----------------------------------------------------------
  // MCP_GET_TOOLS
  // ----------------------------------------------------------

  describe('MCP_GET_TOOLS', () => {
    it('returns success with tools list', async () => {
      const fakeTools = [{ name: 'tool-1', serverId: 's1', description: '', inputSchema: {} }];
      mockMcp.getTools.mockReturnValue(fakeTools);

      const result = await invoke(IPC_CHANNELS.MCP_GET_TOOLS);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(fakeTools);
    });

    it('returns failure when getTools throws', async () => {
      mockMcp.getTools.mockImplementation(() => { throw new Error('tools error'); });

      const result = await invoke(IPC_CHANNELS.MCP_GET_TOOLS);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MCP_GET_TOOLS_FAILED');
    });
  });

  // ----------------------------------------------------------
  // MCP_GET_RESOURCES
  // ----------------------------------------------------------

  describe('MCP_GET_RESOURCES', () => {
    it('returns success with resources list', async () => {
      const fakeResources = [{ uri: 'file:///a', serverId: 's1', name: 'a.txt' }];
      mockMcp.getResources.mockReturnValue(fakeResources);

      const result = await invoke(IPC_CHANNELS.MCP_GET_RESOURCES);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(fakeResources);
    });

    it('returns failure when getResources throws', async () => {
      mockMcp.getResources.mockImplementation(() => { throw new Error('resources error'); });

      const result = await invoke(IPC_CHANNELS.MCP_GET_RESOURCES);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MCP_GET_RESOURCES_FAILED');
    });
  });

  // ----------------------------------------------------------
  // MCP_GET_PROMPTS
  // ----------------------------------------------------------

  describe('MCP_GET_PROMPTS', () => {
    it('returns success with prompts list', async () => {
      const fakePrompts = [{ name: 'prompt-1', serverId: 's1' }];
      mockMcp.getPrompts.mockReturnValue(fakePrompts);

      const result = await invoke(IPC_CHANNELS.MCP_GET_PROMPTS);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(fakePrompts);
    });

    it('returns failure when getPrompts throws', async () => {
      mockMcp.getPrompts.mockImplementation(() => { throw new Error('prompts error'); });

      const result = await invoke(IPC_CHANNELS.MCP_GET_PROMPTS);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MCP_GET_PROMPTS_FAILED');
    });
  });

  // ----------------------------------------------------------
  // MCP_CALL_TOOL
  // ----------------------------------------------------------

  describe('MCP_CALL_TOOL', () => {
    const validCallPayload = {
      serverId: 'server-1',
      toolName: 'my-tool',
      arguments: { key: 'value' },
    };

    it('calls callTool and returns the result', async () => {
      const fakeResult = { success: true, content: [{ type: 'text', text: 'done' }] };
      mockMcp.callTool.mockResolvedValue(fakeResult);

      const result = await invoke(IPC_CHANNELS.MCP_CALL_TOOL, validCallPayload);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(fakeResult);
      expect(mockMcp.callTool).toHaveBeenCalledWith({
        serverId: 'server-1',
        toolName: 'my-tool',
        arguments: { key: 'value' },
      });
    });

    it('maps tool-level failure to error response', async () => {
      mockMcp.callTool.mockResolvedValue({ success: false, error: 'tool blew up', content: [] });

      const result = await invoke(IPC_CHANNELS.MCP_CALL_TOOL, validCallPayload);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MCP_TOOL_CALL_ERROR');
      expect(result.error?.message).toContain('tool blew up');
    });

    it('rejects invalid payload (missing toolName)', async () => {
      const result = await invoke(IPC_CHANNELS.MCP_CALL_TOOL, { serverId: 'server-1' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MCP_CALL_TOOL_FAILED');
      expect(mockMcp.callTool).not.toHaveBeenCalled();
    });

    it('returns failure when callTool rejects', async () => {
      mockMcp.callTool.mockRejectedValue(new Error('unexpected'));

      const result = await invoke(IPC_CHANNELS.MCP_CALL_TOOL, validCallPayload);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MCP_CALL_TOOL_FAILED');
    });
  });

  // ----------------------------------------------------------
  // MCP_READ_RESOURCE
  // ----------------------------------------------------------

  describe('MCP_READ_RESOURCE', () => {
    const validReadPayload = { serverId: 'server-1', uri: 'file:///some/path' };

    it('reads a resource and returns the result', async () => {
      const fakeResult = { success: true, contents: [{ uri: 'file:///some/path', text: 'hello' }] };
      mockMcp.readResource.mockResolvedValue(fakeResult);

      const result = await invoke(IPC_CHANNELS.MCP_READ_RESOURCE, validReadPayload);

      expect(result.success).toBe(true);
      expect(mockMcp.readResource).toHaveBeenCalledWith({ serverId: 'server-1', uri: 'file:///some/path' });
    });

    it('maps resource-level failure to error response', async () => {
      mockMcp.readResource.mockResolvedValue({ success: false, error: 'not found', contents: [] });

      const result = await invoke(IPC_CHANNELS.MCP_READ_RESOURCE, validReadPayload);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MCP_RESOURCE_READ_ERROR');
    });

    it('rejects invalid payload (missing uri)', async () => {
      const result = await invoke(IPC_CHANNELS.MCP_READ_RESOURCE, { serverId: 'server-1' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MCP_READ_RESOURCE_FAILED');
      expect(mockMcp.readResource).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  // MCP_GET_PROMPT
  // ----------------------------------------------------------

  describe('MCP_GET_PROMPT', () => {
    const validPromptPayload = { serverId: 'server-1', promptName: 'my-prompt' };

    it('gets a prompt and returns the result', async () => {
      const fakeResult = { success: true, messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }] };
      mockMcp.getPrompt.mockResolvedValue(fakeResult);

      const result = await invoke(IPC_CHANNELS.MCP_GET_PROMPT, validPromptPayload);

      expect(result.success).toBe(true);
      expect(mockMcp.getPrompt).toHaveBeenCalledWith({
        serverId: 'server-1',
        promptName: 'my-prompt',
        arguments: undefined,
      });
    });

    it('maps prompt-level failure to error response', async () => {
      mockMcp.getPrompt.mockResolvedValue({ success: false, error: 'no such prompt', messages: [] });

      const result = await invoke(IPC_CHANNELS.MCP_GET_PROMPT, validPromptPayload);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MCP_PROMPT_GET_ERROR');
    });

    it('rejects invalid payload (missing promptName)', async () => {
      const result = await invoke(IPC_CHANNELS.MCP_GET_PROMPT, { serverId: 'server-1' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MCP_GET_PROMPT_FAILED');
      expect(mockMcp.getPrompt).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  // MCP_GET_PRESETS
  // ----------------------------------------------------------

  describe('MCP_GET_PRESETS', () => {
    it('returns success with server presets', async () => {
      const result = await invoke(IPC_CHANNELS.MCP_GET_PRESETS);

      expect(result.success).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // MCP_GET_BROWSER_AUTOMATION_HEALTH
  // ----------------------------------------------------------

  describe('MCP_GET_BROWSER_AUTOMATION_HEALTH', () => {
    it('returns success with health report', async () => {
      const fakeReport = { status: 'ready', sources: [{ name: 'chrome', available: true }] };
      mockDiagnose.mockResolvedValue(fakeReport);

      const result = await invoke(IPC_CHANNELS.MCP_GET_BROWSER_AUTOMATION_HEALTH);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(fakeReport);
      expect(mockDiagnose).toHaveBeenCalledOnce();
    });

    it('returns failure when diagnose throws', async () => {
      mockDiagnose.mockRejectedValue(new Error('health check failed'));

      const result = await invoke(IPC_CHANNELS.MCP_GET_BROWSER_AUTOMATION_HEALTH);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MCP_GET_BROWSER_AUTOMATION_HEALTH_FAILED');
    });
  });

  // ----------------------------------------------------------
  // Event forwarding to renderer
  // ----------------------------------------------------------

  describe('event forwarding', () => {
    it('forwards server:connected event to renderer', () => {
      // Find the callback registered for 'server:connected'
      const serverConnectedCall = vi.mocked(mockMcp.on).mock.calls.find(
        (c) => c[0] === 'server:connected'
      );
      expect(serverConnectedCall).toBeDefined();

      const callback = serverConnectedCall![1] as (serverId: string) => void;
      callback('server-1');

      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IPC_CHANNELS.MCP_SERVER_STATUS_CHANGED,
        { serverId: 'server-1', status: 'connected' }
      );
    });

    it('forwards server:disconnected event to renderer', () => {
      const call = vi.mocked(mockMcp.on).mock.calls.find((c) => c[0] === 'server:disconnected');
      expect(call).toBeDefined();

      const callback = call![1] as (serverId: string) => void;
      callback('server-2');

      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IPC_CHANNELS.MCP_SERVER_STATUS_CHANGED,
        { serverId: 'server-2', status: 'disconnected' }
      );
    });

    it('forwards server:error event to renderer', () => {
      const call = vi.mocked(mockMcp.on).mock.calls.find((c) => c[0] === 'server:error');
      expect(call).toBeDefined();

      const callback = call![1] as (serverId: string, error: string) => void;
      callback('server-3', 'something went wrong');

      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IPC_CHANNELS.MCP_SERVER_STATUS_CHANGED,
        { serverId: 'server-3', status: 'error', error: 'something went wrong' }
      );
    });

    it('forwards tools:updated event to renderer', () => {
      const call = vi.mocked(mockMcp.on).mock.calls.find((c) => c[0] === 'tools:updated');
      expect(call).toBeDefined();

      const callback = call![1] as () => void;
      callback();

      expect(mockWebContentsSend).toHaveBeenCalledWith(
        IPC_CHANNELS.MCP_STATE_CHANGED,
        { type: 'tools' }
      );
    });

    it('does not throw when main window is null (event forwarding)', () => {
      // Simulate no window open
      mockGetMainWindow.mockReturnValue(null);

      // Re-register so new mockGetMainWindow is captured in closures
      handlers.clear();
      vi.clearAllMocks();
      mockGetMainWindow.mockReturnValue(null);
      registerMcpHandlers({ windowManager: makeMockWindowManager() });

      const call = vi.mocked(mockMcp.on).mock.calls.find((c) => c[0] === 'server:connected');
      expect(call).toBeDefined();

      const callback = call![1] as (serverId: string) => void;
      expect(() => callback('server-1')).not.toThrow();
    });
  });
});

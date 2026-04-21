/**
 * Tests for instance IPC handlers
 *
 * Strategy: mock `electron` to capture ipcMain.handle registrations, then
 * invoke the captured handlers directly to test validation + delegation logic
 * without spawning an Electron process.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IpcResponse } from '../../../../shared/types/ipc.types';
import type { InstanceManager } from '../../../instance/instance-manager';
import type { WindowManager } from '../../../window-manager';

// ============================================================
// 1. Mock electron BEFORE any import that would pull it in
// ============================================================

type IpcHandler = (event: unknown, payload?: unknown) => Promise<unknown>;
const handlers = new Map<string, IpcHandler>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
  },
  app: { getPath: () => '/tmp/test' },
}));

// ============================================================
// 2. Mock the logger (avoids fs / Electron app.getPath usage)
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
// 3. Mock settings manager (avoids ElectronStore / Electron)
// ============================================================

const mockSettingsGet = vi.fn().mockReturnValue(undefined);
const mockClearPrompt = vi.fn();
const mockGrant = vi.fn();

vi.mock('../../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    get: mockSettingsGet,
    getAll: vi.fn().mockReturnValue({
      maxTotalInstances: 10,
      maxChildrenPerParent: 5,
      allowNestedOrchestration: false,
    }),
  }),
}));

// ============================================================
// 3b. Mock command-manager (avoids transitive ElectronStore init)
// ============================================================

vi.mock('../../../commands/command-manager', () => ({
  getCommandManager: () => ({
    executeCommand: vi.fn(),
    getCommands: vi.fn().mockReturnValue([]),
  }),
  CommandManager: vi.fn(),
}));

vi.mock('../../../remote/observer-server', () => ({
  getRemoteObserverServer: () => ({
    clearPrompt: mockClearPrompt,
  }),
}));

vi.mock('../../../security/self-permission-granter', () => ({
  getSelfPermissionGranter: () => ({
    grant: mockGrant,
  }),
}));

// ============================================================
// 4. Import SUT + helpers (after mocks are registered)
// ============================================================

import { registerInstanceHandlers } from '../instance-handlers';
import { IPC_CHANNELS } from '../../../../shared/types/ipc.types';

// ============================================================
// 5. Helper: cast handler result to IpcResponse
// ============================================================

/** Invoke a registered handler and return the result as IpcResponse. */
async function invoke(
  channel: string,
  payload?: unknown
): Promise<IpcResponse<Record<string, unknown>>> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for channel: ${channel}`);
  return handler({} /* event */, payload) as Promise<IpcResponse<Record<string, unknown>>>;
}

// ============================================================
// 6. Mock InstanceManager / WindowManager factories
// ============================================================

function makeMockInstanceManager(): InstanceManager {
  const orchestration = {
    respondToUserAction: vi.fn(),
    getPendingUserActions: vi.fn().mockReturnValue([]),
    getPendingUserActionsForInstance: vi.fn().mockReturnValue([]),
  };

  return {
    createInstance: vi.fn(),
    getAllInstancesForIpc: vi.fn(),
    terminateInstance: vi.fn(),
    terminateAllInstances: vi.fn(),
    sendInput: vi.fn(),
    interruptInstance: vi.fn(),
    restartInstance: vi.fn(),
    restartFreshInstance: vi.fn(),
    renameInstance: vi.fn(),
    changeAgentMode: vi.fn(),
    toggleYoloMode: vi.fn(),
    changeModel: vi.fn(),
    serializeForIpc: vi.fn((inst: unknown) => inst as Record<string, unknown>),
    getOrchestrationHandler: vi.fn().mockReturnValue(orchestration),
    sendInputResponse: vi.fn(),
    resumeAfterDeferredPermission: vi.fn(),
    respawnAfterUnexpectedExit: vi.fn(),
    emitSystemMessage: vi.fn(),
    clearPendingInputRequiredPermission: vi.fn(),
    recordInputRequiredPermissionDecision: vi.fn(),
  } as unknown as InstanceManager;
}

function makeMockWindowManager(): WindowManager {
  return {} as unknown as WindowManager;
}

// ============================================================
// 7. Tests
// ============================================================

describe('instance-handlers', () => {
  let mockInstanceManager: InstanceManager;

  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    mockSettingsGet.mockReturnValue(undefined);
    mockGrant.mockReset();
    mockClearPrompt.mockReset();

    mockInstanceManager = makeMockInstanceManager();

    registerInstanceHandlers({
      instanceManager: mockInstanceManager,
      windowManager: makeMockWindowManager(),
    });
  });

  // ----------------------------------------------------------
  // INSTANCE_CREATE
  // ----------------------------------------------------------

  describe('INSTANCE_CREATE', () => {
    it('validates payload with Zod schema on INSTANCE_CREATE', async () => {
      const fakeInstance = { id: 'inst-1', communicationTokens: new Map() };
      vi.mocked(mockInstanceManager.createInstance).mockResolvedValue(
        fakeInstance as unknown as Awaited<ReturnType<typeof mockInstanceManager.createInstance>>
      );

      const result = await invoke(IPC_CHANNELS.INSTANCE_CREATE, {
        workingDirectory: '/home/user/project',
      });

      expect(result.success).toBe(true);
      expect(mockInstanceManager.createInstance).toHaveBeenCalledOnce();
    });

    it('rejects invalid payload for INSTANCE_CREATE with structured error', async () => {
      // Missing required workingDirectory field
      const result = await invoke(IPC_CHANNELS.INSTANCE_CREATE, { sessionId: 'abc' });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('CREATE_FAILED');
      expect(typeof result.error?.message).toBe('string');
      // createInstance should never have been called
      expect(mockInstanceManager.createInstance).not.toHaveBeenCalled();
    });

    it('creates instance on valid INSTANCE_CREATE and returns serialized data', async () => {
      const fakeInstance = {
        id: 'inst-42',
        displayName: 'My Agent',
        communicationTokens: new Map([['token-key', 'token-value']]),
      };
      vi.mocked(mockInstanceManager.createInstance).mockResolvedValue(
        fakeInstance as unknown as Awaited<ReturnType<typeof mockInstanceManager.createInstance>>
      );

      const result = await invoke(IPC_CHANNELS.INSTANCE_CREATE, {
        workingDirectory: '/projects/my-app',
        displayName: 'My Agent',
        initialPrompt: 'Hello Claude',
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data?.['id']).toBe('inst-42');
      // communicationTokens Map should be serialized to plain object
      expect(result.data?.['communicationTokens']).toEqual({ 'token-key': 'token-value' });
    });

    it('falls back to process.cwd() when workingDirectory is "."', async () => {
      const fakeInstance = { id: 'inst-cwd', communicationTokens: undefined };
      vi.mocked(mockInstanceManager.createInstance).mockResolvedValue(
        fakeInstance as unknown as Awaited<ReturnType<typeof mockInstanceManager.createInstance>>
      );

      await invoke(IPC_CHANNELS.INSTANCE_CREATE, { workingDirectory: '.' });

      expect(mockInstanceManager.createInstance).toHaveBeenCalledOnce();
      const callArg = vi.mocked(mockInstanceManager.createInstance).mock.calls[0][0];
      expect(callArg.workingDirectory).toBe(process.cwd());
    });

    it('uses defaultWorkingDirectory from settings when payload uses "."', async () => {
      mockSettingsGet.mockReturnValue('/settings/default/dir');
      const fakeInstance = { id: 'inst-settings', communicationTokens: undefined };
      vi.mocked(mockInstanceManager.createInstance).mockResolvedValue(
        fakeInstance as unknown as Awaited<ReturnType<typeof mockInstanceManager.createInstance>>
      );

      await invoke(IPC_CHANNELS.INSTANCE_CREATE, { workingDirectory: '.' });

      const callArg = vi.mocked(mockInstanceManager.createInstance).mock.calls[0][0];
      expect(callArg.workingDirectory).toBe('/settings/default/dir');
    });

    it('propagates instanceManager errors as { success: false, error }', async () => {
      vi.mocked(mockInstanceManager.createInstance).mockRejectedValue(new Error('Disk full'));

      const result = await invoke(IPC_CHANNELS.INSTANCE_CREATE, { workingDirectory: '/tmp' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('CREATE_FAILED');
      expect(result.error?.message).toBe('Disk full');
    });
  });

  // ----------------------------------------------------------
  // INSTANCE_LIST
  // ----------------------------------------------------------

  describe('INSTANCE_LIST', () => {
    it('returns instance list on INSTANCE_LIST', async () => {
      const fakeInstances = [
        { id: 'inst-a', status: 'idle' },
        { id: 'inst-b', status: 'running' },
      ];
      vi.mocked(mockInstanceManager.getAllInstancesForIpc).mockReturnValue(fakeInstances);

      const result = await invoke(IPC_CHANNELS.INSTANCE_LIST);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(fakeInstances);
      expect(mockInstanceManager.getAllInstancesForIpc).toHaveBeenCalledOnce();
    });

    it('returns { success: false } when getAllInstancesForIpc throws', async () => {
      vi.mocked(mockInstanceManager.getAllInstancesForIpc).mockImplementation(() => {
        throw new Error('State corrupted');
      });

      const result = await invoke(IPC_CHANNELS.INSTANCE_LIST);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('LIST_FAILED');
      expect(result.error?.message).toBe('State corrupted');
    });
  });

  // ----------------------------------------------------------
  // INSTANCE_TERMINATE
  // ----------------------------------------------------------

  describe('INSTANCE_TERMINATE', () => {
    it('terminates instance on valid INSTANCE_TERMINATE', async () => {
      vi.mocked(mockInstanceManager.terminateInstance).mockResolvedValue(undefined);

      const result = await invoke(IPC_CHANNELS.INSTANCE_TERMINATE, {
        instanceId: 'inst-99',
      });

      expect(result.success).toBe(true);
      expect(mockInstanceManager.terminateInstance).toHaveBeenCalledWith('inst-99', true);
    });

    it('passes graceful=false to terminateInstance when explicitly set', async () => {
      vi.mocked(mockInstanceManager.terminateInstance).mockResolvedValue(undefined);

      await invoke(IPC_CHANNELS.INSTANCE_TERMINATE, {
        instanceId: 'inst-50',
        graceful: false,
      });

      expect(mockInstanceManager.terminateInstance).toHaveBeenCalledWith('inst-50', false);
    });

    it('rejects missing instanceId with structured error', async () => {
      const result = await invoke(IPC_CHANNELS.INSTANCE_TERMINATE, {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('TERMINATE_FAILED');
      expect(mockInstanceManager.terminateInstance).not.toHaveBeenCalled();
    });

    it('rejects empty string instanceId with structured error', async () => {
      const result = await invoke(IPC_CHANNELS.INSTANCE_TERMINATE, { instanceId: '' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('TERMINATE_FAILED');
    });
  });

  // ----------------------------------------------------------
  // INSTANCE_SEND_INPUT
  // ----------------------------------------------------------

  describe('INSTANCE_SEND_INPUT', () => {
    it('sends message on valid INSTANCE_SEND_INPUT', async () => {
      vi.mocked(mockInstanceManager.sendInput).mockResolvedValue(undefined);

      const result = await invoke(IPC_CHANNELS.INSTANCE_SEND_INPUT, {
        instanceId: 'inst-7',
        message: 'Hello from test',
      });

      expect(result.success).toBe(true);
      expect(mockInstanceManager.sendInput).toHaveBeenCalledWith(
        'inst-7',
        'Hello from test',
        undefined,
        { isRetry: undefined }
      );
    });

    it('passes attachments through to sendInput', async () => {
      vi.mocked(mockInstanceManager.sendInput).mockResolvedValue(undefined);

      const attachments = [
        { name: 'file.txt', type: 'text/plain', size: 100, data: 'aGVsbG8=' },
      ];

      const result = await invoke(IPC_CHANNELS.INSTANCE_SEND_INPUT, {
        instanceId: 'inst-7',
        message: '',
        attachments,
      });

      expect(result.success).toBe(true);
      expect(mockInstanceManager.sendInput).toHaveBeenCalledWith('inst-7', '', attachments, { isRetry: undefined });
    });

    it('rejects missing instanceId in INSTANCE_SEND_INPUT', async () => {
      const result = await invoke(IPC_CHANNELS.INSTANCE_SEND_INPUT, { message: 'Hello' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SEND_FAILED');
      expect(mockInstanceManager.sendInput).not.toHaveBeenCalled();
    });

    it('rejects missing message field in INSTANCE_SEND_INPUT', async () => {
      const result = await invoke(IPC_CHANNELS.INSTANCE_SEND_INPUT, { instanceId: 'inst-7' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SEND_FAILED');
    });
  });

  // ----------------------------------------------------------
  // INSTANCE_TERMINATE_ALL
  // ----------------------------------------------------------

  describe('INSTANCE_TERMINATE_ALL', () => {
    it('terminates all instances and returns success', async () => {
      vi.mocked(mockInstanceManager.terminateAllInstances).mockResolvedValue(undefined);

      const result = await invoke(IPC_CHANNELS.INSTANCE_TERMINATE_ALL);

      expect(result.success).toBe(true);
      expect(mockInstanceManager.terminateAllInstances).toHaveBeenCalledOnce();
    });
  });

  // ----------------------------------------------------------
  // INSTANCE_INTERRUPT
  // ----------------------------------------------------------

  describe('INSTANCE_INTERRUPT', () => {
    it('interrupts instance and returns { interrupted: true } on success', async () => {
      vi.mocked(mockInstanceManager.interruptInstance).mockReturnValue(true);

      const result = await invoke(IPC_CHANNELS.INSTANCE_INTERRUPT, { instanceId: 'inst-11' });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ interrupted: true });
      expect(mockInstanceManager.interruptInstance).toHaveBeenCalledWith('inst-11');
    });

    it('returns { interrupted: false } when instance cannot be interrupted', async () => {
      vi.mocked(mockInstanceManager.interruptInstance).mockReturnValue(false);

      const result = await invoke(IPC_CHANNELS.INSTANCE_INTERRUPT, {
        instanceId: 'inst-missing',
      });

      expect(result.success).toBe(false);
      expect(result.data).toEqual({ interrupted: false });
    });

    it('rejects invalid payload for INSTANCE_INTERRUPT', async () => {
      const result = await invoke(IPC_CHANNELS.INSTANCE_INTERRUPT, {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INTERRUPT_FAILED');
    });
  });

  // ----------------------------------------------------------
  // INSTANCE_RENAME
  // ----------------------------------------------------------

  describe('INSTANCE_RENAME', () => {
    it('renames instance on valid payload', async () => {
      const result = await invoke(IPC_CHANNELS.INSTANCE_RENAME, {
        instanceId: 'inst-22',
        displayName: 'New Name',
      });

      expect(result.success).toBe(true);
      expect(mockInstanceManager.renameInstance).toHaveBeenCalledWith('inst-22', 'New Name');
    });

    it('rejects rename with missing displayName', async () => {
      const result = await invoke(IPC_CHANNELS.INSTANCE_RENAME, { instanceId: 'inst-22' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('RENAME_FAILED');
    });
  });

  // ----------------------------------------------------------
  // INSTANCE_RESTART
  // ----------------------------------------------------------

  describe('INSTANCE_RESTART', () => {
    it('restarts instance on valid payload', async () => {
      vi.mocked(mockInstanceManager.restartInstance).mockResolvedValue(undefined);

      const result = await invoke(IPC_CHANNELS.INSTANCE_RESTART, { instanceId: 'inst-33' });

      expect(result.success).toBe(true);
      expect(mockInstanceManager.restartInstance).toHaveBeenCalledWith('inst-33');
    });

    it('returns structured error when restart fails', async () => {
      vi.mocked(mockInstanceManager.restartInstance).mockRejectedValue(
        new Error('Cannot restart')
      );

      const result = await invoke(IPC_CHANNELS.INSTANCE_RESTART, { instanceId: 'inst-33' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('RESTART_FAILED');
      expect(result.error?.message).toBe('Cannot restart');
    });
  });

  describe('INSTANCE_RESTART_FRESH', () => {
    it('restarts instance with fresh context on valid payload', async () => {
      vi.mocked(mockInstanceManager.restartFreshInstance).mockResolvedValue(undefined);

      const result = await invoke(IPC_CHANNELS.INSTANCE_RESTART_FRESH, { instanceId: 'inst-34' });

      expect(result.success).toBe(true);
      expect(mockInstanceManager.restartFreshInstance).toHaveBeenCalledWith('inst-34');
    });

    it('returns structured error when fresh restart fails', async () => {
      vi.mocked(mockInstanceManager.restartFreshInstance).mockRejectedValue(
        new Error('Cannot restart fresh')
      );

      const result = await invoke(IPC_CHANNELS.INSTANCE_RESTART_FRESH, { instanceId: 'inst-34' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('RESTART_FRESH_FAILED');
      expect(result.error?.message).toBe('Cannot restart fresh');
    });
  });

  // ----------------------------------------------------------
  // USER_ACTION_RESPOND
  // ----------------------------------------------------------

  describe('USER_ACTION_RESPOND', () => {
    it('dispatches approval to orchestration handler', async () => {
      const result = await invoke(IPC_CHANNELS.USER_ACTION_RESPOND, {
        requestId: 'req-1',
        approved: true,
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ requestId: 'req-1', responded: true });

      const orchestration = mockInstanceManager.getOrchestrationHandler();
      expect(orchestration.respondToUserAction).toHaveBeenCalledWith('req-1', true, undefined);
    });

    it('dispatches rejection when approved=false', async () => {
      await invoke(IPC_CHANNELS.USER_ACTION_RESPOND, {
        requestId: 'req-2',
        approved: false,
        selectedOption: 'cancel',
      });

      const orchestration = mockInstanceManager.getOrchestrationHandler();
      expect(orchestration.respondToUserAction).toHaveBeenCalledWith('req-2', false, 'cancel');
    });

    it('rejects missing requestId with structured error', async () => {
      const result = await invoke(IPC_CHANNELS.USER_ACTION_RESPOND, { approved: true });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('USER_ACTION_RESPOND_FAILED');
    });
  });

  // ----------------------------------------------------------
  // USER_ACTION_LIST
  // ----------------------------------------------------------

  describe('USER_ACTION_LIST', () => {
    it('returns all pending user actions', async () => {
      const fakeRequests = [{ requestId: 'r1', requestType: 'confirm' }];
      const orchestration = mockInstanceManager.getOrchestrationHandler();
      vi.mocked(orchestration.getPendingUserActions).mockReturnValue(
        fakeRequests as unknown as ReturnType<typeof orchestration.getPendingUserActions>
      );

      const result = await invoke(IPC_CHANNELS.USER_ACTION_LIST);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(fakeRequests);
    });
  });

  // ----------------------------------------------------------
  // INPUT_REQUIRED_RESPOND
  // ----------------------------------------------------------

  describe('INPUT_REQUIRED_RESPOND', () => {
    it('responds to input required prompt and clears pending request', async () => {
      vi.mocked(mockInstanceManager.sendInputResponse).mockResolvedValue(undefined);

      const result = await invoke(IPC_CHANNELS.INPUT_REQUIRED_RESPOND, {
        instanceId: 'inst-55',
        requestId: 'req-input-1',
        response: 'y',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ requestId: 'req-input-1', responded: true });
      expect(mockInstanceManager.sendInputResponse).toHaveBeenCalledWith(
        'inst-55',
        'y',
        undefined
      );
      expect(mockInstanceManager.clearPendingInputRequiredPermission).toHaveBeenCalledWith(
        'inst-55',
        'req-input-1'
      );
    });

    it('records permission decision when decisionAction and decisionScope are provided', async () => {
      vi.mocked(mockInstanceManager.sendInputResponse).mockResolvedValue(undefined);

      await invoke(IPC_CHANNELS.INPUT_REQUIRED_RESPOND, {
        instanceId: 'inst-55',
        requestId: 'req-perm-1',
        response: 'y',
        decisionAction: 'allow',
        decisionScope: 'session',
      });

      expect(mockInstanceManager.recordInputRequiredPermissionDecision).toHaveBeenCalledWith({
        instanceId: 'inst-55',
        requestId: 'req-perm-1',
        action: 'allow',
        scope: 'session',
      });
      expect(mockInstanceManager.clearPendingInputRequiredPermission).not.toHaveBeenCalled();
      expect(mockClearPrompt).toHaveBeenCalledWith('req-perm-1');
    });

    it('records deferred permission decisions before finalizing the prompt', async () => {
      vi.mocked(mockInstanceManager.resumeAfterDeferredPermission).mockResolvedValue(undefined);

      const result = await invoke(IPC_CHANNELS.INPUT_REQUIRED_RESPOND, {
        instanceId: 'inst-56',
        requestId: 'req-defer-1',
        response: 'approved',
        decisionAction: 'allow',
        decisionScope: 'session',
        metadata: { type: 'deferred_permission' },
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        requestId: 'req-defer-1',
        responded: true,
        resumed: true,
      });
      expect(mockInstanceManager.resumeAfterDeferredPermission).toHaveBeenCalledWith(
        'inst-56',
        true,
      );
      expect(mockInstanceManager.recordInputRequiredPermissionDecision).toHaveBeenCalledWith({
        instanceId: 'inst-56',
        requestId: 'req-defer-1',
        action: 'allow',
        scope: 'session',
      });
      expect(mockInstanceManager.clearPendingInputRequiredPermission).not.toHaveBeenCalled();
      expect(mockClearPrompt).toHaveBeenCalledWith('req-defer-1');
    });

    it('records allow/always only when the self-permission grant succeeds', async () => {
      mockGrant.mockReturnValue({
        ok: true,
        rulePattern: 'Edit(/Users/test/.claude/settings.json)',
        settingsFile: '/Users/test/.claude/settings.json',
        alreadyExisted: false,
      });
      vi.mocked(mockInstanceManager.respawnAfterUnexpectedExit).mockResolvedValue(undefined);

      const result = await invoke(IPC_CHANNELS.INPUT_REQUIRED_RESPOND, {
        instanceId: 'inst-57',
        requestId: 'req-self-1',
        response: 'allow',
        decisionAction: 'allow',
        decisionScope: 'always',
        metadata: {
          type: 'permission_denial',
          tool_name: 'Edit',
          full_path: '/Users/test/.claude/settings.json',
        },
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        requestId: 'req-self-1',
        responded: true,
        granted: true,
        rulePattern: 'Edit(/Users/test/.claude/settings.json)',
        alreadyExisted: false,
        respawned: true,
      });
      expect(mockGrant).toHaveBeenCalledWith({
        toolName: 'Edit',
        action: undefined,
        path: '/Users/test/.claude/settings.json',
        scopeTree: false,
        instanceId: 'inst-57',
        requestId: 'req-self-1',
      });
      expect(mockInstanceManager.recordInputRequiredPermissionDecision).toHaveBeenCalledWith({
        instanceId: 'inst-57',
        requestId: 'req-self-1',
        action: 'allow',
        scope: 'always',
      });
      expect(mockInstanceManager.clearPendingInputRequiredPermission).not.toHaveBeenCalled();
      expect(mockInstanceManager.respawnAfterUnexpectedExit).toHaveBeenCalledWith('inst-57');
      expect(mockClearPrompt).toHaveBeenCalledWith('req-self-1');
    });

    it('does not persist allow/always when the self-permission grant fails', async () => {
      mockGrant.mockReturnValue({
        ok: false,
        code: 'WRITE_FAILED',
        message: 'disk full',
        settingsFile: '/Users/test/.claude/settings.json',
      });

      const result = await invoke(IPC_CHANNELS.INPUT_REQUIRED_RESPOND, {
        instanceId: 'inst-58',
        requestId: 'req-self-2',
        response: 'allow',
        decisionAction: 'allow',
        decisionScope: 'always',
        metadata: {
          type: 'permission_denial',
          tool_name: 'Edit',
          full_path: '/Users/test/.claude/settings.json',
        },
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        requestId: 'req-self-2',
        responded: true,
        granted: false,
        rulePattern: undefined,
        alreadyExisted: undefined,
        respawned: false,
      });
      expect(mockInstanceManager.recordInputRequiredPermissionDecision).not.toHaveBeenCalled();
      expect(mockInstanceManager.clearPendingInputRequiredPermission).toHaveBeenCalledWith(
        'inst-58',
        'req-self-2',
      );
      expect(mockInstanceManager.respawnAfterUnexpectedExit).not.toHaveBeenCalled();
      expect(mockClearPrompt).toHaveBeenCalledWith('req-self-2');
    });

    it('rejects missing instanceId with structured error', async () => {
      const result = await invoke(IPC_CHANNELS.INPUT_REQUIRED_RESPOND, {
        requestId: 'req-bad',
        response: 'y',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INPUT_REQUIRED_RESPOND_FAILED');
      expect(mockInstanceManager.sendInputResponse).not.toHaveBeenCalled();
    });
  });
});

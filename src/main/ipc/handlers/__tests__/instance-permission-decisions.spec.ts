import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { InstanceManager } from '../../../instance/instance-manager';
import type { Instance } from '../../../../shared/types/instance.types';
import type { InstanceContextPort } from '../../../instance/instance-context-port';
import type { WindowManager } from '../../../window-manager';
import type { IpcResponse } from '../../../../shared/types/ipc.types';

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => Promise<IpcResponse>>(),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (event: unknown, payload: unknown) => Promise<IpcResponse>) => handlers.set(channel, handler) },
  app: { getPath: () => '/tmp/permission-test-unused' },
}));
vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ get: () => undefined, getAll: () => ({}) }),
}));
vi.mock('../../../commands/command-manager', () => ({
  getCommandManager: () => ({ executeCommand: vi.fn(), getCommands: () => [] }),
}));
vi.mock('../../../remote/observer-server', () => ({
  getRemoteObserverServer: () => ({ clearPrompt: vi.fn() }),
}));
vi.mock('../../../pause/pause-coordinator', () => ({
  getPauseCoordinator: () => ({ isPaused: () => false }),
}));
vi.mock('../../../security/approval-adjudicator', () => ({
  maybeAdjudicateDeferredPermission: async () => null,
  resetAdjudicatorBreaker: () => undefined,
}));
// Keep permission evaluation and recording real; only bypass unrelated gate
// surfaces (bash risk analysis, model adjudication and provider processes).
vi.mock('../../../security/tool-execution-gate', () => ({
  getToolExecutionGate: () => ({ evaluate: ({ request }: { request: PermissionRequest }) => {
    const permission = PermissionManager.getInstance().checkPermission(request);
    return { action: permission.action, reason: permission.reason, source: 'permission-rule', permission };
  } }),
}));
vi.mock('../../../security/permission-enforcer', () => ({
  getPermissionEnforcer: () => ({ recordUserDecision: (...args: Parameters<PermissionManager['recordUserDecision']>) =>
    PermissionManager.getInstance().recordUserDecision(...args) }),
}));

import { PermissionManager, type PermissionRequest } from '../../../security/permission-manager';
import { InstancePermissionRequestFlow } from '../../../instance/instance-permission-request-flow';
import { registerInstanceHandlers } from '../instance-handlers';
import { IPC_CHANNELS } from '../../../../shared/types/ipc.types';
import { decisionFor } from '../../../../renderer/app/features/instance-detail/user-action-request.rules';

describe('permission card refusal through IPC and PermissionManager', () => {
  let root: string;
  let permissionsFile: string;
  let originalFile: string;
  let manager: PermissionManager;
  let flow: InstancePermissionRequestFlow;
  let forwarded: string[];
  let resumed: boolean[];
  let sendInputResponse: Mock<InstanceManager['sendInputResponse']>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'permission-decisions-'));
    permissionsFile = join(root, '.orchestrator', 'permissions.json');
    mkdirSync(join(root, '.orchestrator'));
    originalFile = JSON.stringify({ version: 1, ruleSet: {
      id: 'user', name: 'User Rules', source: 'user', enabled: true, rules: [],
    } });
    writeFileSync(permissionsFile, originalFile);
    // Pin the private filesystem boundary before singleton construction. This
    // prevents require('electron') fallback from reaching James's real HOME.
    vi.spyOn(PermissionManager.prototype as unknown as { getHomeDir(): string }, 'getHomeDir').mockReturnValue(root);
    PermissionManager._resetForTesting();
    manager = PermissionManager.getInstance();
    forwarded = [];
    resumed = [];
    sendInputResponse = vi.fn(async () => undefined);
    const instance = { id: 'inst-a', workingDirectory: root, parentId: null, depth: 0, yoloMode: false } as Instance;
    flow = new InstancePermissionRequestFlow({
      getInstance: () => instance,
      getContext: () => ({}) as InstanceContextPort,
      sendInputResponse,
      resumeAfterDeferredPermission: async (_id, approved) => { resumed.push(approved); },
      addToOutputBuffer: () => undefined,
      publishOutput: () => undefined,
      emit: (event, payload) => {
        if (event === 'instance:input-required') forwarded.push((payload as { requestId: string }).requestId);
        return true;
      },
    });
    handlers.clear();
    registerInstanceHandlers({
      instanceManager: {
        sendInputResponse,
        resumeAfterDeferredPermission: async (_id: string, approved: boolean) => { resumed.push(approved); },
        clearPendingInputRequiredPermission: (instanceId: string, requestId: string) => flow.clearPending(instanceId, requestId),
        recordInputRequiredPermissionDecision: (params: Parameters<InstancePermissionRequestFlow['recordUserDecision']>[0]) => flow.recordUserDecision(params),
      } as unknown as InstanceManager,
      windowManager: {} as WindowManager,
    });
  });

  afterEach(() => {
    manager.destroy();
    PermissionManager._resetForTesting();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  async function ask(requestId: string, metadata: Record<string, unknown>): Promise<void> {
    await flow.handleInputRequired({ instanceId: 'inst-a', requestId, prompt: 'Permission required', timestamp: 1, metadata });
  }

  async function refuse(metadata: { type: string; tool_name: string }): Promise<IpcResponse> {
    const decision = decisionFor(metadata, false, metadata.type === 'permission_denial' ? 'always' : 'once');
    return handlers.get(IPC_CHANNELS.INPUT_REQUIRED_RESPOND)!({}, {
      instanceId: 'inst-a', requestId: 'req-first', response: 'Permission denied. Please do not perform that operation.',
      decisionAction: decision?.action, decisionScope: decision?.scope, metadata,
    });
  }

  it('rejecting a denial records no decision and the same denial asks again', async () => {
    const metadata = { type: 'permission_denial', tool_name: 'Bash', action: 'execute', path: 'echo approval-example' };
    await ask('req-first', metadata);
    expect(forwarded).toEqual(['req-first']);
    expect((await refuse(metadata)).success).toBe(true);
    expect(sendInputResponse).toHaveBeenCalledWith('inst-a', expect.stringContaining('Permission denied'), undefined);
    expect(readFileSync(permissionsFile, 'utf8')).toBe(originalFile);
    expect(manager.getStats()).toMatchObject({ cacheSize: 0, sessionRulesCount: 0 });
    await ask('req-again', metadata);
    expect(forwarded).toEqual(['req-first', 'req-again']);
    expect(resumed).toEqual([]);
  });

  it("Don't allow refuses the held call, caches nothing, and the identical command asks again", async () => {
    const metadata = { type: 'deferred_permission', tool_name: 'Bash', tool_use_id: 'toolu_test', tool_input: { command: 'echo approval-example' } };
    await ask('req-first', metadata);
    expect(forwarded).toEqual(['req-first']);
    expect((await refuse(metadata)).success).toBe(true);
    expect(resumed).toEqual([false]);
    expect(sendInputResponse).not.toHaveBeenCalled();
    expect(readFileSync(permissionsFile, 'utf8')).toBe(originalFile);
    expect(manager.getStats()).toMatchObject({ cacheSize: 0, sessionRulesCount: 0 });
    await ask('req-again', metadata);
    expect(forwarded).toEqual(['req-first', 'req-again']);
    expect(resumed).toEqual([false]);
  });
});

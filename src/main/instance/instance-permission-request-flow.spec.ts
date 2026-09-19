import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import type { InstanceContextPort } from './instance-context-port';
import type { ToolExecutionGateDecision } from '../security/tool-execution-gate';
import {
  InstancePermissionRequestFlow,
  type InstancePermissionRequestHost,
} from './instance-permission-request-flow';

const { evaluate, recordUserDecision, resetAdjudicatorBreaker, maybeAdjudicate } = vi.hoisted(() => ({
  evaluate: vi.fn(),
  recordUserDecision: vi.fn(),
  resetAdjudicatorBreaker: vi.fn(),
  maybeAdjudicate: vi.fn(),
}));

vi.mock('../security/tool-execution-gate', () => ({
  getToolExecutionGate: () => ({ evaluate }),
}));

vi.mock('../security/permission-enforcer', () => ({
  getPermissionEnforcer: () => ({ recordUserDecision }),
}));

vi.mock('../security/approval-adjudicator', () => ({
  maybeAdjudicateDeferredPermission: (...args: unknown[]) => maybeAdjudicate(...args),
  resetAdjudicatorBreaker: (...args: unknown[]) => resetAdjudicatorBreaker(...args),
}));

vi.mock('../security/permission-manager', () => ({
  getPermissionManager: () => ({ loadProjectRules: vi.fn() }),
}));

const { settingsGetAll } = vi.hoisted(() => ({
  settingsGetAll: vi.fn(() => ({
    workspaceSecretsEnabled: true,
    workspaceSecretsAllowAgentRequests: true,
  })),
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: settingsGetAll }),
}));

function gateDecision(action: 'allow' | 'deny' | 'ask'): ToolExecutionGateDecision {
  return {
    action,
    reason: `${action}-reason`,
    source: 'permission-rule',
    permission: {
      action,
      reason: `${action}-reason`,
      source: 'rule',
      mode: 'default',
    },
  } as unknown as ToolExecutionGateDecision;
}

function createHost(overrides: Partial<InstancePermissionRequestHost> = {}): InstancePermissionRequestHost {
  const instance = {
    id: 'inst-1',
    workingDirectory: '/tmp/proj',
    parentId: null,
    depth: 0,
    yoloMode: false,
  } as Instance;
  return {
    getInstance: () => instance,
    sendInputResponse: vi.fn(async () => undefined),
    resumeAfterDeferredPermission: vi.fn(async () => undefined),
    addToOutputBuffer: vi.fn(),
    publishOutput: vi.fn(),
    emit: vi.fn(() => true),
    getContext: () => ({}) as InstanceContextPort,
    ...overrides,
  };
}

describe('InstancePermissionRequestFlow', () => {
  beforeEach(() => {
    evaluate.mockReset();
    recordUserDecision.mockReset();
    resetAdjudicatorBreaker.mockReset();
    maybeAdjudicate.mockReset();
  });

  it('auto-denies permission_denial prompts and does not forward them', async () => {
    evaluate.mockReturnValue(gateDecision('deny'));
    const host = createHost();
    const flow = new InstancePermissionRequestFlow(host);

    await flow.handleInputRequired({
      instanceId: 'inst-1',
      requestId: 'req-1',
      prompt: 'Allow write?',
      timestamp: Date.now(),
      metadata: { type: 'permission_denial', action: 'write', path: 'src/a.ts', tool_name: 'Edit' },
    });

    expect(host.sendInputResponse).toHaveBeenCalledWith(
      'inst-1',
      'Permission denied. (deny-reason)',
      undefined,
    );
    expect(host.emit).toHaveBeenCalledWith(
      'permission:lifecycle',
      expect.objectContaining({ outcome: 'deny', instanceId: 'inst-1' }),
    );
    expect(host.emit).not.toHaveBeenCalledWith('instance:input-required', expect.anything());
  });

  it.each([
    ['the master switch is off', { workspaceSecretsEnabled: false, workspaceSecretsAllowAgentRequests: true }],
    ['agent requests are barred', { workspaceSecretsEnabled: true, workspaceSecretsAllowAgentRequests: false }],
  ])('refuses an agent secret request when %s', async (_label, settings) => {
    settingsGetAll.mockReturnValueOnce(settings);
    const host = createHost();
    const flow = new InstancePermissionRequestFlow(host);

    await flow.handleInputRequired({
      instanceId: 'inst-1',
      requestId: 'req-secret',
      prompt: 'I need the deploy token',
      timestamp: Date.now(),
      metadata: { type: 'secret_required', name: 'DEPLOY_TOKEN' },
    });

    expect(host.emit).not.toHaveBeenCalledWith('instance:input-required', expect.anything());
    expect(host.sendInputResponse).toHaveBeenCalledWith(
      'inst-1',
      expect.stringContaining('workspace secret requests are turned off in Settings.'),
    );
    expect(host.emit).toHaveBeenCalledWith(
      'permission:lifecycle',
      expect.objectContaining({ outcome: 'deny', toolName: 'workspace-secret', source: 'operator-setting' }),
    );
    expect(host.addToOutputBuffer).toHaveBeenCalled();
  });

  it('forwards an agent secret request when both operator switches are on', async () => {
    const host = createHost();
    const flow = new InstancePermissionRequestFlow(host);

    await flow.handleInputRequired({
      instanceId: 'inst-1',
      requestId: 'req-secret-ok',
      prompt: 'I need the deploy token',
      timestamp: Date.now(),
      metadata: { type: 'secret_required', name: 'DEPLOY_TOKEN' },
    });

    expect(host.emit).toHaveBeenCalledWith(
      'instance:input-required',
      expect.objectContaining({ requestId: 'req-secret-ok' }),
    );
    expect(host.sendInputResponse).not.toHaveBeenCalled();
  });

  it('fails closed when settings cannot be read', async () => {
    settingsGetAll.mockImplementationOnce(() => { throw new Error('settings unavailable'); });
    const host = createHost();
    const flow = new InstancePermissionRequestFlow(host);

    await flow.handleInputRequired({
      instanceId: 'inst-1',
      requestId: 'req-secret-fail',
      prompt: 'I need the deploy token',
      timestamp: Date.now(),
      metadata: { type: 'secret_required', name: 'DEPLOY_TOKEN' },
    });

    expect(host.emit).not.toHaveBeenCalledWith('instance:input-required', expect.anything());
  });

  it('forwards ask permission_denial prompts to the renderer', async () => {
    evaluate.mockReturnValue(gateDecision('ask'));
    const host = createHost();
    const flow = new InstancePermissionRequestFlow(host);

    await flow.handleInputRequired({
      instanceId: 'inst-1',
      requestId: 'req-2',
      prompt: 'Allow write?',
      timestamp: Date.now(),
      metadata: { type: 'permission_denial', action: 'write', path: 'src/a.ts' },
    });

    expect(host.sendInputResponse).not.toHaveBeenCalled();
    expect(host.emit).toHaveBeenCalledWith(
      'instance:input-required',
      expect.objectContaining({ requestId: 'req-2' }),
    );
  });

  it('auto-resumes deferred allow decisions', async () => {
    evaluate.mockReturnValue(gateDecision('allow'));
    const host = createHost();
    const flow = new InstancePermissionRequestFlow(host);

    await flow.handleInputRequired({
      instanceId: 'inst-1',
      requestId: 'req-3',
      prompt: 'Allow bash?',
      timestamp: Date.now(),
      metadata: { type: 'deferred_permission', tool_name: 'Bash', tool_input: { command: 'ls' } },
    });

    expect(host.resumeAfterDeferredPermission).toHaveBeenCalledWith('inst-1', true);
    expect(host.emit).not.toHaveBeenCalledWith('instance:input-required', expect.anything());
  });

  it('records a live user decision against the pending request', async () => {
    evaluate.mockReturnValue(gateDecision('ask'));
    const host = createHost();
    const flow = new InstancePermissionRequestFlow(host);

    await flow.handleInputRequired({
      instanceId: 'inst-1',
      requestId: 'req-4',
      prompt: 'Allow write?',
      timestamp: Date.now(),
      metadata: { type: 'permission_denial', action: 'write', path: 'src/a.ts' },
    });

    flow.recordUserDecision({
      instanceId: 'inst-1',
      requestId: 'req-4',
      action: 'allow',
      scope: 'session',
    });

    expect(resetAdjudicatorBreaker).toHaveBeenCalledWith('inst-1');
    expect(recordUserDecision).toHaveBeenCalledWith(
      'inst-1',
      expect.objectContaining({ instanceId: 'inst-1', scope: 'file_write' }),
      'allow',
      'session',
    );

    flow.recordUserDecision({
      instanceId: 'inst-1',
      requestId: 'req-4',
      action: 'deny',
      scope: 'once',
    });
    expect(recordUserDecision).toHaveBeenCalledTimes(1);
  });
});

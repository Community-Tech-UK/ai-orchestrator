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

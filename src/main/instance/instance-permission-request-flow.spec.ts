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

  it.each(['allow', 'deny'] as const)('says so, and shows no card, when the saved-rule %s cannot resume the session', async (action) => {
    evaluate.mockReturnValue(gateDecision(action));
    const host = createHost({ resumeAfterDeferredPermission: vi.fn(async () => { throw new Error('No deferred tool use pending'); }) });
    await new InstancePermissionRequestFlow(host).handleInputRequired({ instanceId: 'inst-1', requestId: 'held', prompt: 'Allow?', timestamp: 1,
      metadata: { type: 'deferred_permission', tool_name: 'mcp__orchestrator__plan_queue_start', tool_input: {} } });
    // A person's answer would take the same failing resume, so no card; the note never claims the call was allowed.
    expect(host.emit).not.toHaveBeenCalledWith('instance:input-required', expect.anything());
    expect(host.addToOutputBuffer).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      content: 'Harness answered the mcp__orchestrator__plan_queue_start approval automatically but could not resume the session (No deferred tool use pending). Restart the session to continue.',
    }));
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

  it.each(['user', 'system'] as const)('adds removal guidance only for a saved user deny (%s)', async source => {
    const decision = gateDecision('deny');
    decision.permission!.matchedRule = { source } as NonNullable<typeof decision.permission>['matchedRule'];
    evaluate.mockReturnValue(decision);
    const host = createHost();
    await new InstancePermissionRequestFlow(host).handleInputRequired({ instanceId: 'inst-1', requestId: 'saved', prompt: 'Allow write?', timestamp: 1,
      metadata: { type: 'permission_denial', tool_name: 'Edit', path: 'src/a.ts' } });
    const output = JSON.stringify(vi.mocked(host.addToOutputBuffer).mock.calls);
    if (source === 'user') expect(output).toContain('Settings');
    else expect(output).not.toContain('Saved decisions');
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

    expect(host.resumeAfterDeferredPermission).toHaveBeenCalledWith('inst-1', true, { requestId: 'req-3' });
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


describe('live permission resources and strict once', () => {
  beforeEach(() => { evaluate.mockReturnValue(gateDecision('ask')); recordUserDecision.mockReset(); });
  it.each([
    ['WebFetch', { url: 'https://example.com' }, 'tool_use', 'tool:WebFetch'],
    ['Write', { file_path: './src/../a.ts' }, 'tool_use', 'tool:Write'],
    ['Read', { file_path: 'a.ts' }, 'tool_use', 'tool:Read'],
  ])('maps %s to the permission gate', async (tool, input, scope, resource) => {
    const flow = new InstancePermissionRequestFlow(createHost());
    await flow.handleInputRequired({ instanceId: 'inst-1', requestId: 'card', prompt: 'Allow?', timestamp: 1,
      metadata: { type: 'deferred_permission', live: true, tool_name: tool, tool_input: input } });
    expect(evaluate).toHaveBeenLastCalledWith(expect.objectContaining({ request: expect.objectContaining({ scope, resource, id: expect.stringMatching(/^perm-live-/) }) }));
  });
  it.each(['allow', 'deny'] as const)('does not cache a live once %s but preserves held Bash once and live session/always rules', async action => {
    const flow = new InstancePermissionRequestFlow(createHost());
    for (const [id, live, scope] of [['live-once', true, 'once'], ['held-once', false, 'once'], ['live-session', true, 'session'], ['live-always', true, 'always']] as const) {
      await flow.handleInputRequired({ instanceId: 'inst-1', requestId: id, prompt: 'Allow?', timestamp: 1,
        metadata: { type: 'deferred_permission', live, tool_name: 'Bash', tool_input: { command: 'pwd' } } });
      flow.recordUserDecision({ instanceId: 'inst-1', requestId: id, action, scope });
    }
    expect(recordUserDecision).toHaveBeenCalledTimes(3);
    expect(recordUserDecision.mock.calls.map(call => call[3])).toEqual(['once', 'session', 'always']);
  });
  // A tool-wide key (`tool:Write`) cannot say which write was allowed, so a cached "once" would allow every later Write for an hour.
  it.each(['allow', 'deny'] as const)('does not cache a held once %s for a whole tool, but still records its session and always rules', async action => {
    const flow = new InstancePermissionRequestFlow(createHost());
    for (const [id, scope] of [['held-once', 'once'], ['held-session', 'session'], ['held-always', 'always']] as const) {
      await flow.handleInputRequired({ instanceId: 'inst-1', requestId: id, prompt: 'Allow?', timestamp: 1,
        metadata: { type: 'deferred_permission', live: false, tool_name: 'Write', tool_input: { file_path: 'a.ts' } } });
      flow.recordUserDecision({ instanceId: 'inst-1', requestId: id, action, scope });
    }
    expect(recordUserDecision.mock.calls.map(call => call[3])).toEqual(['session', 'always']);
  });
  it('passes the live card id through adjudication', async () => {
    maybeAdjudicate.mockResolvedValueOnce({ approved: false, reason: 'policy', riskLevel: 'high' });
    const host = createHost();
    await new InstancePermissionRequestFlow(host).handleInputRequired({ instanceId: 'inst-1', requestId: 'adjudicated', prompt: 'Allow?', timestamp: 1,
      metadata: { type: 'deferred_permission', live: true, tool_name: 'WebFetch' } });
    // The model is told the reviewer refused it, never that a person did.
    expect(host.resumeAfterDeferredPermission).toHaveBeenCalledWith('inst-1', false, { requestId: 'adjudicated',
      autoReason: "Harness's automatic approval check refused WebFetch (risk high): policy" });
  });
});


describe('live permission gate failures and cancellation races', () => {
  it('answers fail closed if permission evaluation throws instead of leaving Claude waiting', async () => {
    evaluate.mockImplementationOnce(() => { throw new Error('gate unavailable'); });
    const host = createHost();
    const flow = new InstancePermissionRequestFlow(host);
    await flow.handleInputRequired({ instanceId: 'inst-1', requestId: 'failed-live', prompt: 'Allow?', timestamp: 1,
      metadata: { type: 'deferred_permission', live: true, tool_name: 'WebFetch' } });
    expect(host.resumeAfterDeferredPermission).toHaveBeenCalledWith('inst-1', false, expect.objectContaining({ requestId: 'failed-live' }));
    expect(host.emit).not.toHaveBeenCalledWith('instance:input-required', expect.anything());
  });
  it('does not forward an ask cancelled while its asynchronous adjudication was pending', async () => {
    evaluate.mockReturnValue(gateDecision('ask'));
    let finish!: () => void;
    maybeAdjudicate.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const host = createHost();
    const flow = new InstancePermissionRequestFlow(host);
    const handling = flow.handleInputRequired({ instanceId: 'inst-1', requestId: 'cancelled-live', prompt: 'Allow?', timestamp: 1,
      metadata: { type: 'deferred_permission', live: true, tool_name: 'WebFetch' } });
    flow.clearPending('inst-1', 'cancelled-live'); finish(); await handling;
    expect(host.emit).not.toHaveBeenCalledWith('instance:input-required', expect.anything());
  });
});


describe('live decision recording survives provider resolution', () => {
  it('keeps the live request until its caller records the session rule, even when the provider resolves first', async () => {
    evaluate.mockReturnValue(gateDecision('ask')); recordUserDecision.mockReset();
    const flow = new InstancePermissionRequestFlow(createHost());
    await flow.handleInputRequired({ instanceId: 'inst-1', requestId: 'card', prompt: 'Allow?', timestamp: 1,
      metadata: { type: 'deferred_permission', live: true, tool_name: 'WebFetch' } });
    flow.handleResolved({ instanceId: 'inst-1', requestId: 'card', reason: 'decided' });
    flow.recordUserDecision({ instanceId: 'inst-1', requestId: 'card', action: 'allow', scope: 'session' });
    expect(recordUserDecision).toHaveBeenCalledOnce();
  });
  it('clears cancelled live requests so a late answer cannot save a rule', async () => {
    evaluate.mockReturnValue(gateDecision('ask')); recordUserDecision.mockReset();
    const flow = new InstancePermissionRequestFlow(createHost());
    await flow.handleInputRequired({ instanceId: 'inst-1', requestId: 'card', prompt: 'Allow?', timestamp: 1,
      metadata: { type: 'deferred_permission', live: true, tool_name: 'WebFetch' } });
    flow.handleResolved({ instanceId: 'inst-1', requestId: 'card', reason: 'cancelled' });
    flow.recordUserDecision({ instanceId: 'inst-1', requestId: 'card', action: 'allow', scope: 'always' });
    expect(recordUserDecision).not.toHaveBeenCalled();
  });
});

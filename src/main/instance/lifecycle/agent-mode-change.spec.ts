import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAgentById } from '../../../shared/types/agent.types';
import { buildInstanceRecord } from './instance-create-builder';
import type { CliAdapter } from '../../cli/adapters/adapter-factory';
import { changeAgentModeImpl, type AgentModeChangeDeps } from './agent-mode-change';

const services = vi.hoisted(() => ({ release: vi.fn(), acquire: vi.fn(), writeIdentity: vi.fn(), resolveAgent: vi.fn() }));
vi.mock('../../session/session-mutex', () => ({ getSessionMutex: () => ({ acquire: services.acquire }) }));
vi.mock('../../session/session-continuity', () => ({ getSessionContinuityManager: () => ({ writeThroughIdentityLocked: services.writeIdentity }) }));
vi.mock('../../agents/agent-registry', () => ({ getAgentRegistry: () => ({ resolveAgent: services.resolveAgent }) }));

function harness(resume = false, fork = false) {
  const instance = buildInstanceRecord({ workingDirectory: '/fixture', provider: 'claude', agentId: 'plan' }, getAgentById('plan')!, { defaultYoloMode: false, getParent: () => undefined });
  instance.status = 'idle'; instance.planMode = { enabled: true, state: 'planning' };
  if (resume) instance.outputBuffer.push({ id: 'msg', type: 'user', content: 'task', timestamp: 1 });
  const old = { terminate: vi.fn().mockResolvedValue(undefined) } as unknown as CliAdapter;
  const adapter = { spawn: vi.fn().mockResolvedValue(123), sendInput: vi.fn().mockResolvedValue(undefined), terminate: vi.fn().mockResolvedValue(undefined), removeAllListeners: vi.fn() };
  const emitSystemNotice = vi.fn<AgentModeChangeDeps['emitSystemNotice']>();
  const deps: AgentModeChangeDeps & { emitSystemNotice: typeof emitSystemNotice } = {
    getInstance: () => instance, getAdapter: () => old, deleteAdapter: vi.fn().mockReturnValue(true),
    setAdapter: vi.fn(), setupAdapterEvents: vi.fn(), queueUpdate: vi.fn(),
    transitionState: (inst, status) => { inst.status = status; },
    getAdapterRuntimeCapabilities: () => ({ supportsResume: resume, supportsForkSession: fork }),
    resolveCliTypeForInstance: async () => 'claude', residentClaudeForSpawn: () => true,
    createRuntimeAdapter: vi.fn().mockResolvedValue(adapter), waitForResumeHealth: async () => true,
    waitForInputReadinessBoundary: async () => undefined, prepareStatusForAdapterInput: vi.fn(),
    buildFallbackHistory: async () => 'history', buildReplayContinuityMessage: () => 'replay', emitAgentChanged: vi.fn(),
    emitSystemNotice,
    spawnConfigBuilder: { getMcpConfig: () => [], getChromeDevtoolsMcpOptions: () => null, getBrowserGatewayMcpOptions: () => null, getPermissionHookPath: () => undefined, getRtkSpawnConfig: () => undefined },
  };
  return { instance, adapter, old, deps };
}
beforeEach(() => {
  vi.clearAllMocks(); services.acquire.mockResolvedValue(services.release);
  services.resolveAgent.mockImplementation(async (_cwd: string, id: string) => getAgentById(id));
});

describe('agent mode change extraction', () => {
  it('publishes a display-only receipt after the unchanged mode message is accepted', async () => {
    const { instance, adapter, deps } = harness();
    await changeAgentModeImpl(deps, instance.id, 'build');
    expect(deps.emitSystemNotice).toHaveBeenCalledExactlyOnceWith(
      instance, 'Switched to Build mode: edits are allowed, the session can read and build.',
      { kind: 'agent-mode-changed', displayOnly: true },
    );
    expect(adapter.sendInput).toHaveBeenCalledTimes(1);
    expect(adapter.sendInput.mock.calls[0][0]).not.toContain('Switched to Build mode');
    expect(adapter.sendInput.mock.invocationCallOrder[0]).toBeLessThan(deps.emitSystemNotice.mock.invocationCallOrder[0]);
  });
  it('reports Plan and Review restrictions without changing their model-facing message', async () => {
    for (const mode of ['plan', 'review'] as const) {
      const { instance, adapter, deps } = harness(); instance.agentId = 'build';
      await changeAgentModeImpl(deps, instance.id, mode);
      const agent = getAgentById(mode)!;
      expect(deps.emitSystemNotice).toHaveBeenCalledWith(instance,
        `Switched to ${agent.name} mode: edits are off, the session can read and ${mode}. Shell commands may require approval.`,
        { kind: 'agent-mode-changed', displayOnly: true });
      expect(adapter.sendInput).toHaveBeenCalledExactlyOnceWith(`[System: Agent mode changed to ${agent.name}. ${agent.description}\n\nNew instructions:\n${agent.systemPrompt}]`);
    }
  });
  it('uses the explicit session tool override instead of promising the named mode permissions', async () => {
    const { instance, deps } = harness();
    instance.toolPermissionsOverride = { ...getAgentById('build')!.permissions, read: 'deny', write: 'deny', bash: 'deny' };
    instance.yoloMode = true;
    await changeAgentModeImpl(deps, instance.id, 'build');
    expect(deps.emitSystemNotice).toHaveBeenCalledWith(instance,
      'Switched to Build mode: edits are off, file reading is off. Shell commands are off.',
      { kind: 'agent-mode-changed', displayOnly: true });
  });
  it('uses the resolved custom agent permissions and avoids an approval promise in auto-approve mode', async () => {
    const { instance, deps } = harness(); instance.yoloMode = true;
    services.resolveAgent.mockResolvedValue({ ...getAgentById('review')!, id: 'audit', name: 'Audit', mode: 'custom' });
    await changeAgentModeImpl(deps, instance.id, 'audit');
    expect(deps.emitSystemNotice).toHaveBeenCalledWith(instance,
      'Switched to Audit mode: edits are off, file reading is allowed.',
      { kind: 'agent-mode-changed', displayOnly: true });
  });
  it('does not promise edit approval when the existing runtime allowlists edit tools', async () => {
    const { instance, deps } = harness();
    instance.toolPermissionsOverride = { ...getAgentById('build')!.permissions, write: 'ask', bash: 'ask' };
    await changeAgentModeImpl(deps, instance.id, 'build');
    expect(deps.createRuntimeAdapter).toHaveBeenCalledWith('claude', expect.objectContaining({
      yoloMode: false, allowedTools: expect.arrayContaining(['Write', 'Edit', 'NotebookEdit', 'Bash']),
    }), instance.executionLocation);
    expect(deps.emitSystemNotice).toHaveBeenCalledWith(instance,
      'Switched to Build mode: edits are allowed, the session can read and build. Shell commands may require approval.',
      { kind: 'agent-mode-changed', displayOnly: true });
  });

  it('does not publish a success receipt before acceptance or after rejection', async () => {
    const { instance, adapter, deps } = harness();
    let rejectSend!: (error: Error) => void;
    adapter.sendInput.mockImplementation(() => new Promise<void>((_resolve, reject) => { rejectSend = reject; }));
    const change = changeAgentModeImpl(deps, instance.id, 'build');
    const rejection = expect(change).rejects.toThrow('fixture send failure');
    await vi.waitFor(() => expect(adapter.sendInput).toHaveBeenCalled());
    expect(deps.emitSystemNotice).not.toHaveBeenCalled();
    rejectSend(new Error('fixture send failure')); await rejection;
    expect(deps.emitSystemNotice).not.toHaveBeenCalled();
  });
  it('changes mode, exits plan state, sends the unchanged revocation and releases the mutex', async () => {
    const { instance, adapter, deps } = harness();
    expect(await changeAgentModeImpl(deps, instance.id, 'build')).toBe(instance);
    expect(instance.agentId).toBe('build'); expect(instance.status).toBe('idle'); expect(instance.planMode.enabled).toBe(false);
    expect(adapter.sendInput).toHaveBeenCalledWith(`[SYSTEM MODE CHANGE - IMPORTANT]\nYour mode has been changed from PLAN to BUILD.\nALL previous PLAN MODE restrictions are now LIFTED. You are NO LONGER in plan mode.\nYou now have FULL access to: read files, write files, edit files, execute bash commands, and all other tools.\nNew instructions: ${getAgentById('build')!.systemPrompt}\nProceed with implementation. Do NOT request to switch modes - you are already in Build mode.`);
    expect(services.release).toHaveBeenCalledOnce();
  });
  it('resumes from the live source id when forking', async () => {
    const { instance, deps } = harness(true, true); const source = instance.sessionId;
    await changeAgentModeImpl(deps, instance.id, 'review');
    expect(deps.createRuntimeAdapter).toHaveBeenCalledWith('claude', expect.objectContaining({ sessionId: source, resume: true, forkSession: true }), instance.executionLocation);
    expect(instance.sessionId).not.toBe(source);
  });
  it('holds replay history before sending it when the provider cannot resume', async () => {
    const { instance, adapter, deps } = harness();
    instance.outputBuffer.push({ id: 'prior-message', type: 'user', content: 'original task', timestamp: 1 });
    const hold = vi.fn(); deps.holdContinuityUntilAnswered = hold;
    await changeAgentModeImpl(deps, instance.id, 'build');
    expect(hold).toHaveBeenCalledExactlyOnceWith(instance.id, 'replay');
    expect(adapter.sendInput.mock.calls[0]).toEqual(['replay']);
    expect(hold.mock.invocationCallOrder[0]).toBeLessThan(adapter.sendInput.mock.invocationCallOrder[0]);
  });
  it('holds fallback history before sending after native resume fails', async () => {
    const { instance, adapter, deps } = harness(true, true);
    const hold = vi.fn(); deps.holdContinuityUntilAnswered = hold;
    adapter.spawn.mockRejectedValueOnce(new Error('resume failed'));
    await changeAgentModeImpl(deps, instance.id, 'build');
    expect(hold).toHaveBeenCalledExactlyOnceWith(instance.id, 'history');
    expect(adapter.sendInput.mock.calls[0]).toEqual(['history']);
    expect(hold.mock.invocationCallOrder[0]).toBeLessThan(adapter.sendInput.mock.invocationCallOrder[0]);
  });
  it('refuses busy sessions and leaves the adapter alone', async () => {
    const { instance, old, deps } = harness(); instance.status = 'busy';
    await expect(changeAgentModeImpl(deps, instance.id, 'build')).rejects.toThrow('busy');
    expect(old.terminate).not.toHaveBeenCalled(); expect(services.release).toHaveBeenCalledOnce();
  });
  it('propagates spawn errors, updates error state and releases the mutex', async () => {
    const { instance, adapter, deps } = harness(); adapter.spawn.mockRejectedValue(new Error('fixture spawn failure'));
    await expect(changeAgentModeImpl(deps, instance.id, 'build')).rejects.toThrow('fixture spawn failure');
    expect(instance.status).toBe('error'); expect(services.release).toHaveBeenCalledOnce();
  });
  it('does not respawn when the mode already matches', async () => {
    const { instance, old, deps } = harness();
    await changeAgentModeImpl(deps, instance.id, 'plan');
    expect(old.terminate).not.toHaveBeenCalled(); expect(services.release).toHaveBeenCalledOnce();
    expect(deps.emitSystemNotice).not.toHaveBeenCalled();
  });
});

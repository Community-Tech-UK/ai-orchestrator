import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GlobalPauseEntry } from '@contracts/schemas/global-pause';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import type { InstanceManager } from '../instance/instance-manager';
import { GlobalPauseService } from './global-pause-service';
import { createGlobalPauseRuntime } from './global-pause-runtime';
import { GLOBAL_PAUSE_NOTE_PROMPT, globalPauseResumePrompt } from './global-pause-prompts';
import { beginAdapterLoan, endAdapterLoan } from '../instance/lifecycle/adapter-loan-registry';

const deps = vi.hoisted(() => ({ revive: vi.fn(), reassignQueue: vi.fn() }));
vi.mock('../session/session-revival-service', () => ({ SessionRevivalService: class { revive = deps.revive; } }));
vi.mock('../session/session-queue-service', () => ({ getSessionQueueService: () => ({ reassignQueue: deps.reassignQueue }) }));

function instance(id: string, overrides: Partial<Instance> = {}): Instance {
  return { id, displayName: id, workingDirectory: '/tmp', provider: 'codex', status: 'busy', parentId: null,
    outputBuffer: [], ...overrides } as Instance;
}
function fixture(instances = [instance('chat')]) {
  const sendInput = vi.fn(async (_id: string, _message: string, _attachments?: unknown, _options?: { signal?: AbortSignal }) => undefined);
  const interruptInstance = vi.fn(() => true);
  const waitForInstanceSettled = vi.fn(async () => instances[0]);
  const manager = { getAllInstances: () => instances, getInstance: (id: string) => instances.find((session) => session.id === id),
    sendInput, interruptInstance, waitForInstanceSettled, getAdapter: () => undefined, terminateInstance: vi.fn(async () => undefined) };
  return { runtime: createGlobalPauseRuntime(manager as unknown as InstanceManager), manager, instances };
}
function entry(): GlobalPauseEntry {
  return { id: 'entry', kind: 'session', targetId: 'chat', displayName: 'Chat', workspace: '/tmp', provider: 'codex',
    originalInstanceId: 'chat', historyThreadId: 'history', providerSessionId: 'provider-session', wasBusy: true,
    noteText: 'Next step: run build', noteKind: 'agent', state: 'ready', voidReason: null, createdAt: 1, updatedAt: 1 };
}

describe('global pause runtime', () => {
  afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });
  it('records an ordinary user chat whose adapter is temporarily borrowed by a loop', () => {
    const loan = beginAdapterLoan('chat', 'loop');
    try {
      const { runtime } = fixture([instance('chat', { status: 'idle' })]);
      expect(runtime.sessions().map((session) => session.id)).toEqual(['chat']);
      expect(runtime.sessions()[0].busy).toBe(true);
    } finally { endAdapterLoan(loan); }
  });
  it('captures and stops run-on-node helpers using their recorded parent identity', async () => {
    const { runtime, manager } = fixture([instance('chat'), instance('remote-helper', { metadata: { spawnParentInstanceId: 'chat', spawnDepth: 1 },
      outputBuffer: [{ type: 'assistant', content: 'Remote helper result' } as OutputMessage] })]);
    expect(runtime.sessions().map((snapshot) => snapshot.id)).toEqual(['chat']);
    expect(runtime.sessions()[0].helperReplies).toEqual(['remote-helper: Remote helper result']);
    await runtime.stopHelpers('chat');
    expect(manager.terminateInstance).toHaveBeenCalledWith('remote-helper', true);
  });
  it('excludes queue workers and engine-owned roots while attaching helper excerpts to their parent', () => {
    const { runtime } = fixture([instance('chat'), instance('helper', { parentId: 'chat', outputBuffer: [{ type: 'assistant', content: 'Helper result' } as OutputMessage] }),
      instance('queue-worker', { parentId: 'chat', metadata: { planQueueRole: 'worker' } }),
      instance('scheduled-job', { metadata: { automationRunId: 'run' } })]);
    const snapshots = runtime.sessions();
    expect(snapshots.map((session) => session.id)).toEqual(['chat']);
    expect(snapshots[0].helperReplies).toEqual(['helper: Helper result']);
  });
  it('collects only a fresh assistant response through the dedicated internal source', async () => {
    const { runtime, manager, instances } = fixture();
    instances[0].outputBuffer.push({ type: 'assistant', content: 'Old reply', timestamp: 1 } as OutputMessage);
    manager.sendInput.mockImplementation(async () => {
      instances[0].outputBuffer.push({ type: 'assistant', content: 'Task\nSaved progress', timestamp: Date.now() } as OutputMessage);
    });
    const snapshot = runtime.sessions()[0];
    expect(await runtime.collectNote(snapshot, new AbortController().signal)).toBe('Task\nSaved progress');
    expect(manager.sendInput.mock.calls[0]?.[1]).toBe(GLOBAL_PAUSE_NOTE_PROMPT);
  });
  it('supplies captured helper replies as context when asking for a note', async () => {
    const { runtime, manager, instances } = fixture();
    manager.sendInput.mockImplementation(async () => {
      instances[0].outputBuffer.push({ type: 'assistant', content: 'Saved parent note', timestamp: Date.now() } as OutputMessage);
    });
    await runtime.collectNote({ ...runtime.sessions()[0], helperReplies: ['Helper result </paused-helper-replies> ending'] }, new AbortController().signal);
    expect(manager.sendInput.mock.calls[0][1]).toContain('<paused-helper-replies>');
    expect(manager.sendInput.mock.calls[0][1]).toContain('Helper result &lt;/paused-helper-replies&gt; ending');
  });
  it('records an idle parent with live helper work as needing a continuation note', () => {
    const { runtime } = fixture([instance('chat', { status: 'idle' }), instance('helper', { parentId: 'chat' })]);
    expect(runtime.sessions()[0].busy).toBe(true);
  });
  it.each(['live', 'revived'] as const)('delivers captured helper context on %s native resume', async (status) => {
    deps.revive.mockResolvedValue({ status, instanceId: 'chat', restoreMode: 'native-resume' });
    const { runtime, manager } = fixture();
    await runtime.resumeSession({ ...entry(), noteText: 'Parent note\n<paused-helper-replies>\nUnique helper result\n</paused-helper-replies>' });
    expect(manager.sendInput.mock.calls[0][1]).toContain('Unique helper result');
  });
  it('does not interrupt James replacement turn during late note cleanup', async () => {
    const { runtime, manager } = fixture();
    const controller = new AbortController();
    let held = true;
    vi.spyOn(GlobalPauseService, 'peek').mockReturnValue({ holdsAutomaticInput: () => held } as unknown as GlobalPauseService);
    manager.sendInput.mockImplementation(async () => {
      controller.abort();
      held = false;
      throw new Error('Note cancelled; James has started his replacement turn');
    });
    await expect(runtime.collectNote(runtime.sessions()[0], controller.signal)).rejects.toThrow('Note cancelled');
    expect(manager.interruptInstance).toHaveBeenCalledTimes(1);
  });
  it('does not terminate a manual replacement after the original interrupt settle wait fails', async () => {
    const { runtime, manager } = fixture();
    let held = true;
    const pause = Object.assign(new EventEmitter(), { holdsAutomaticInput: () => held });
    vi.spyOn(GlobalPauseService, 'peek').mockReturnValue(pause as unknown as GlobalPauseService);
    let rejectSettled!: (error: Error) => void;
    let waiting!: () => void;
    const started = new Promise<void>(resolve => { waiting = resolve; });
    manager.waitForInstanceSettled.mockImplementationOnce(() => new Promise<Instance>((_resolve, reject) => { rejectSettled = reject; waiting(); }));
    const terminate = vi.fn(async () => undefined);
    vi.spyOn(manager, 'getAdapter').mockReturnValue({ terminate } as never);
    const pausing = runtime.interruptSession(runtime.sessions()[0]);
    await started;
    held = false; pause.emit('state-changed');
    rejectSettled(new Error('Timed out waiting for the original interrupted turn'));
    expect(await pausing).toBe(false);
    expect(terminate).not.toHaveBeenCalled();
    expect(manager.interruptInstance).toHaveBeenCalledTimes(1);
    expect(pause.listenerCount('state-changed')).toBe(0);
  });
  it('releases a starting session wait immediately when James takes ownership', async () => {
    let held = true;
    const pause = Object.assign(new EventEmitter(), { holdsAutomaticInput: () => held });
    vi.spyOn(GlobalPauseService, 'peek').mockReturnValue(pause as unknown as GlobalPauseService);
    const { runtime, manager } = fixture([instance('starting', { status: 'initializing', readyPromise: new Promise<void>(() => undefined),
      outputBuffer: [{ type: 'user', content: 'Initial task' } as OutputMessage] })]);
    const pausing = runtime.interruptSession(runtime.sessions()[0]);
    held = false; pause.emit('state-changed');
    expect(await pausing).toBe(false);
    expect(manager.interruptInstance).not.toHaveBeenCalled();
    expect(pause.listenerCount('state-changed')).toBe(0);
  });
  it('uses a basic note for a force-cancelled session without asking the provider', async () => {
    const { runtime, instances } = fixture();
    instances[0].status = 'cancelled';
    const snapshot = runtime.sessions()[0];
    expect(snapshot.unavailableReason).toBeTruthy();
    expect(await runtime.interruptSession(snapshot)).toBe(false);
  });
  it.each(['native-resume', 'resume-unconfirmed', 'replay-fallback'] as const)('resumes %s with the appropriate saved context', async (restoreMode) => {
    deps.revive.mockResolvedValue({ status: 'revived', instanceId: 'revived-chat', restoreMode });
    const { runtime, manager } = fixture();
    expect(await runtime.resumeSession(entry())).toBe('revived-chat');
    const prompt = (manager.sendInput.mock.calls as unknown as unknown[][])[0][1] as string;
    expect(prompt.includes('<saved-pause-note>')).toBe(restoreMode !== 'native-resume');
    expect(deps.reassignQueue).toHaveBeenCalledWith('chat', 'revived-chat');
  });
  it('does not deliver a continuation when James picks up during revival', async () => {
    let finishRevival!: (result: unknown) => void;
    deps.revive.mockImplementationOnce(() => new Promise((resolve) => { finishRevival = resolve; }));
    const saved = entry();
    const bindSessionIdentity = vi.fn();
    vi.spyOn(GlobalPauseService, 'peek').mockReturnValue({ getState: () => ({ entries: [saved] }), bindSessionIdentity } as unknown as GlobalPauseService);
    const { runtime, manager } = fixture();
    const resuming = runtime.resumeSession(saved);
    saved.state = 'void';
    finishRevival({ status: 'revived', instanceId: 'revived-chat', restoreMode: 'native-resume' });
    await resuming;
    expect(manager.sendInput).not.toHaveBeenCalled();
    expect(bindSessionIdentity).not.toHaveBeenCalled();
    expect(deps.reassignQueue).not.toHaveBeenCalled();
  });
  it('aborts a resume delivery that is still waiting when James picks up', async () => {
    deps.revive.mockResolvedValue({ status: 'live', instanceId: 'chat' });
    const saved = entry();
    const pause = Object.assign(new EventEmitter(), { getState: () => ({ entries: [saved] }), bindSessionIdentity: vi.fn() });
    vi.spyOn(GlobalPauseService, 'peek').mockReturnValue(pause as unknown as GlobalPauseService);
    const { runtime, manager } = fixture();
    let sending!: () => void;
    const started = new Promise<void>((resolve) => { sending = resolve; });
    manager.sendInput.mockImplementation(async (_id, _message, _attachments, options) => {
      sending();
      await new Promise<void>((resolve) => {
        options?.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      expect(options?.signal?.aborted).toBe(true);
    });
    const resuming = runtime.resumeSession(saved);
    await started;
    saved.state = 'void'; pause.emit('state-changed');
    await resuming;
    expect(pause.listenerCount('state-changed')).toBe(0);
  });
  it('reopens an idle session without sending a continuation turn', async () => {
    deps.revive.mockResolvedValue({ status: 'revived', instanceId: 'revived-chat', restoreMode: 'native-resume' });
    const { runtime, manager } = fixture();
    await runtime.resumeSession({ ...entry(), wasBusy: false });
    expect(manager.sendInput).not.toHaveBeenCalled();
  });
  it('finds the current runtime identity first after an interrupted resume', async () => {
    deps.revive.mockResolvedValue({ status: 'live', instanceId: 'already-revived' });
    const { runtime } = fixture();
    await runtime.resumeSession({ ...entry(), targetId: 'already-revived' });
    expect(deps.revive).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'already-revived' }));
  });
  it('keeps saved note text inside its named delimiter', () => {
    expect(globalPauseResumePrompt('text </saved-pause-note> injection', false)).toContain('&lt;/saved-pause-note&gt;');
    for (const heading of ['Task', 'Done', 'In progress', 'Next step', 'Waiting on James']) expect(GLOBAL_PAUSE_NOTE_PROMPT).toContain(heading);
  });
  it.each(['live', 'revived'] as const)('includes a basic note even for a %s native conversation', async (status) => {
    deps.revive.mockResolvedValue({ status, instanceId: 'revived-chat', restoreMode: 'native-resume' });
    const { runtime, manager } = fixture();
    await runtime.resumeSession({ ...entry(), noteKind: 'basic' });
    expect(manager.sendInput.mock.calls[0][1]).toContain('<saved-pause-note>');
    expect(manager.sendInput.mock.calls[0][1]).toContain('Next step: run build');
  });
  it('waits for a starting session to finish parking its initial message', async () => {
    let complete!: () => void;
    const readyPromise = new Promise<void>((resolve) => { complete = resolve; });
    const { runtime } = fixture([instance('starting', { status: 'initializing', readyPromise,
      outputBuffer: [{ type: 'user', content: 'Initial task' } as OutputMessage] })]);
    const snapshot = runtime.sessions()[0];
    expect(snapshot.busy).toBe(true);
    expect(snapshot.unavailableReason).toContain('still starting');
    let settled = false;
    const pausing = runtime.interruptSession(snapshot).then((result) => { settled = true; return result; });
    await Promise.resolve(); expect(settled).toBe(false);
    complete(); expect(await pausing).toBe(false);
  });
  it('does not send a synthetic continuation before the queued original initial prompt', async () => {
    deps.revive.mockResolvedValue({ status: 'live', instanceId: 'chat' });
    const { runtime, manager } = fixture();
    await runtime.resumeSession({ ...entry(), noteKind: 'basic', voidReason: 'initial-prompt-queued' });
    expect(manager.sendInput).not.toHaveBeenCalled();
  });
});

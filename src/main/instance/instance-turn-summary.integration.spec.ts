import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInstance, type OutputMessage } from '../../shared/types/instance.types';
import { collectTurnToolEvents } from '../../shared/turn-tool-events';
import { findEditFailureWarning } from '../../shared/summarise-turn';
import { BaseCliAdapter, type AdapterInputDispatch } from '../cli/adapters/base-cli-adapter';
import { ClaudeCliAdapter } from '../cli/adapters/claude-cli-adapter';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import { TurnFileBaselineService } from '../vcs/turn-file-baseline';
import { letFileTimesClearBoundary } from '../vcs/turn-boundary.test-helpers';
import { toProviderOutputEvent, toOutputMessageFromProviderEnvelope } from '../providers/provider-output-event';
import { continuityEntryToOutputMessage, outputMessagesToContinuityEntries } from '../session/continuity-message-projection';
import { HistoryRestoreCoordinator } from '../history/history-restore-coordinator';
import type { ConversationData } from '../../shared/types/history.types';
import type { InstanceManager } from './instance-manager';
import { getMessagesForRestoreTranscript } from '../history/history-restore-helpers';
import { getToolOutcomes, _resetToolOutcomeStoreForTesting } from '../learning/tool-outcome-store';
import { deliverInitialPromptAfterSpawn } from './lifecycle/initial-prompt-recovery';
import { appendInstanceOutputMessage } from '../../renderer/app/core/state/instance/instance-output-message-merge';
import { InstanceCommunicationManager } from './instance-communication';

vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({ outputBufferSize: 100, enableDiskStorage: false }) }) }));
vi.mock('../memory/output-storage', () => ({ getOutputStorageManager: () => ({ storeMessages: vi.fn() }) }));
vi.mock('../hooks/hook-manager', () => ({ getHookManager: () => ({ triggerHooks: vi.fn().mockResolvedValue(undefined), triggerLifecycleHooks: vi.fn().mockResolvedValue({ blocked: false }) }) }));
vi.mock('../plugins/hook-emitter', () => ({ emitPluginHook: vi.fn() }));
vi.mock('../core/error-recovery', () => ({ getErrorRecoveryManager: () => ({ classifyError: vi.fn(() => ({ category: 'unknown', technicalDetails: '' })) }) }));
vi.mock('../session/session-continuity', () => ({ getSessionContinuityManagerIfInitialized: () => undefined }));
vi.mock('../session/session-admission-service', () => ({ getSessionAdmissionService: () => ({ recordUserSend: () => null }) }));
vi.mock('../memory/token-stats', () => ({ getTokenStatsService: () => ({ record: vi.fn(), classifyToolType: () => 'other' }) }));

class FastAdapter extends BaseCliAdapter {
  constructor(readonly work: () => Promise<void>) { super({ command: 'unused' }); }
  getName() { return 'claude-cli'; }
  getCapabilities() { return { streaming: true, toolUse: true, vision: false, fileAccess: true, shellExecution: true, multiTurn: true, codeExecution: false, contextWindow: 1_000, outputFormats: ['text'] }; }
  async checkStatus() { return { available: true, version: 'fixture', path: 'unused' }; }
  async sendMessage() { return { id: 'unused', role: 'assistant' as const, content: '' }; }
  async *sendMessageStream() { yield ''; }
  parseOutput() { return { id: 'unused', role: 'assistant' as const, content: '' }; }
  protected buildArgs() { return []; }
  protected async sendInputImpl(_message: string, _attachments?: unknown, _metadata?: unknown, dispatch?: AdapterInputDispatch) {
    dispatch?.beforeProviderDispatch?.();
    await this.work(); // edits happen before any provider output event
  }
}

const run = promisify(execFile);
describe('real dispatch and Claude outcome paths for turn summaries', () => {
  let repo: string;
  let baseline: TurnFileBaselineService;
  let events: EventEmitter;
  let instance: ReturnType<typeof createInstance>;
  let adapter: CliAdapter;
  let communication: InstanceCommunicationManager;
  let renderer: OutputMessage[];
  let drainContextEvidence: (() => Promise<void>) | undefined;
  const input = (id: string): OutputMessage => ({ id, type: 'user', content: 'change it', timestamp: Date.now() });
  const publish = (message: OutputMessage) => {
    const envelope = { instanceId: instance.id, eventId: message.id, provider: 'claude' as const, seq: 1, timestamp: message.timestamp, event: toProviderOutputEvent(message) };
    events.emit('provider:normalized-event', envelope);
    appendInstanceOutputMessage(renderer, toOutputMessageFromProviderEnvelope(envelope)!, new Set(renderer.filter(message => message.type === 'user').map(message => message.id)));
  };
  const seed = (message: OutputMessage) => { communication.addToOutputBuffer(instance, message); publish(message); };
  const finish = () => events.emit('provider:normalized-event', { instanceId: instance.id, event: { kind: 'complete' } });
  const changes = async (key: string) => {
    await letFileTimesClearBoundary(); // the agent's last write comes well before its turn ends
    finish();
    const result = await baseline.getResult(instance.id, key);
    expect(result.state).toBe('ready');
    return result.state === 'ready' ? result.files.map(file => file.path) : [];
  };
  function wire(current: BaseCliAdapter) {
    adapter = current as unknown as CliAdapter;
    communication = new InstanceCommunicationManager({ getInstance: () => instance, getAdapter: () => adapter,
      setAdapter: vi.fn(), deleteAdapter: vi.fn(), queueUpdate: vi.fn(), processOrchestrationOutput: vi.fn(),
      onInterruptedExit: vi.fn().mockResolvedValue(undefined), drainContextEvidence,
      emitProviderRuntimeEvent: (instanceId, event, options) => events.emit('provider:normalized-event', { instanceId, event, raw: options?.raw, adapterGeneration: instance.adapterGeneration }), ingestToRLM: vi.fn(), ingestToUnifiedMemory: vi.fn(),
    });
    communication.on('output', ({ message }) => publish(message));
    communication.setupAdapterEvents(instance.id, adapter);
  }
  beforeEach(async () => {
    TurnFileBaselineService._resetForTesting(); _resetToolOutcomeStoreForTesting();
    repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'turn-dispatch-fixture-')));
    await run('git', ['init', '-q'], { cwd: repo });
    await fs.writeFile(path.join(repo, 'tracked.txt'), 'before\n');
    await run('git', ['-c', 'core.fsmonitor=false', 'add', 'tracked.txt'], { cwd: repo });
    instance = createInstance({ workingDirectory: repo, provider: 'claude' });
    instance.status = 'idle';
    events = new EventEmitter(); renderer = []; drainContextEvidence = undefined;
    baseline = TurnFileBaselineService.getInstance(); baseline.attach(events, () => instance);
  });
  afterEach(async () => {
    await baseline.forget(instance.id); TurnFileBaselineService._resetForTesting();
    await fs.rm(repo, { recursive: true, force: true });
  });

  it('awaits the baseline before a regular send can make its first fast edit', async () => {
    wire(new FastAdapter(() => fs.writeFile(path.join(repo, 'tracked.txt'), 'fast edit\n')));
    seed(input('regular'));
    await communication.sendInput(instance.id, 'change it');
    expect(await changes('regular')).toEqual(['tracked.txt']);
  });

  it('awaits the initial-prompt seam before its first provider write', async () => {
    wire(new FastAdapter(() => fs.writeFile(path.join(repo, 'initial.txt'), 'initial edit\n')));
    seed(input('initial'));
    await deliverInitialPromptAfterSpawn(instance, new AbortController().signal, () => adapter.sendInput('change it'), {
      transitionState: vi.fn(), queueUpdate: vi.fn(), addToOutputBuffer: vi.fn(), emitOutput: vi.fn(),
    });
    expect(await changes('initial')).toEqual(['initial.txt']);
  });

  it('captures an automated input before its admission callback publishes the hidden turn boundary', async () => {
    wire(new FastAdapter(() => fs.writeFile(path.join(repo, 'automated.txt'), 'automatic edit\n')));
    const machine: OutputMessage = { ...input('automated'), type: 'system', metadata: { internalInput: { actor: 'harness', source: 'async-work-continuation' } } };
    await communication.sendInput(instance.id, 'continue', undefined, undefined, {
      automatedInput: true, internalSource: 'async-work-continuation', beforeProviderDispatch: () => seed(machine),
    });
    expect(await changes('automated')).toEqual(['automated.txt']);
  });

  it('freezes the first real adapter completion before slow completion listeners or duplicate signals', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    drainContextEvidence = () => held;
    wire(new FastAdapter(() => fs.writeFile(path.join(repo, 'tracked.txt'), 'agent edit\n')));
    seed(input('ending'));
    await communication.sendInput(instance.id, 'change it');
    await letFileTimesClearBoundary(); // the agent's last write comes well before its turn ends
    adapter.emit('complete', { id: 'complete', role: 'assistant', content: 'Done' });
    try {
      const first = await baseline.getResult(instance.id, 'ending');
      expect(first.state).toBe('ready');
      expect(first.state === 'ready' ? first.files.map(file => file.path) : []).toEqual(['tracked.txt']);
      await fs.writeFile(path.join(repo, 'manual-after.txt'), 'manual change\n');
      adapter.emit('complete', { id: 'complete', role: 'assistant', content: 'Done' });
      expect(await baseline.getResult(instance.id, 'ending')).toEqual(first);
      seed(input('next-turn'));
      await baseline.getResult(instance.id, 'next-turn');
      release();
      await vi.waitFor(async () => expect(await baseline.getResult(instance.id, 'next-turn')).toEqual({ state: 'running' }));
    } finally { release(); }
  });

  it('patches a late outcome onto its original turn and path when a provider reuses the call id', async () => {
    wire(new FastAdapter(async () => undefined));
    seed(input('first-turn'));
    adapter.emit('output', { id: 'old-call', type: 'tool_use', timestamp: Date.now(), content: 'Edit', metadata: {
      id: 'reused', name: 'Edit', turnId: 'old-turn', input: { file_path: 'old.ts' },
    } });
    seed(input('second-turn'));
    adapter.emit('output', { id: 'new-call', type: 'tool_use', timestamp: Date.now(), content: 'Edit', metadata: {
      id: 'reused', name: 'Edit', turnId: 'new-turn', input: { file_path: 'new.ts' },
    } });
    adapter.emit('output', { id: 'late-outcome', type: 'tool_outcome', timestamp: Date.now(), content: 'old_string not found', metadata: {
      tool_use_id: 'reused', is_error: true, turnId: 'old-turn',
    } });
    await vi.waitFor(() => expect(instance.outputBuffer.find(message => message.id === 'old-call')?.metadata?.['is_error']).toBe(true));
    expect(instance.outputBuffer.find(message => message.id === 'new-call')?.metadata?.['is_error']).toBeUndefined();
    const calls = collectTurnToolEvents(renderer);
    expect(calls.find(call => call.failed)?.paths).toEqual(['old.ts']);
    expect(calls.find(call => call.startMessageId === 'new-call')?.settled).toBe(false);
  });

  it('carries real Claude failure outcomes through communication, renderer normalization, continuity and archived reload', async () => {
    const claude = new ClaudeCliAdapter(); wire(claude);
    seed(input('claude-turn'));
    const processMessage = (claude as unknown as { processCliMessage(message: unknown): void }).processCliMessage.bind(claude);
    processMessage({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'failed-edit', name: 'Edit', input: { file_path: path.join(repo, 'tracked.txt'), old_string: 'missing', new_string: 'changed' } }] } });
    processMessage({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'failed-edit', is_error: true, content: 'old_string not found; password=PLACEHOLDER' }] } });
    await vi.waitFor(() => expect(instance.outputBuffer.find(message => message.type === 'tool_use')?.metadata?.['is_error']).toBe(true));
    seed({ id: 'reply', type: 'assistant', timestamp: Date.now(), content: 'All edits applied.' });
    const warning = (messages: OutputMessage[]) => findEditFailureWarning(collectTurnToolEvents(messages, { cwd: repo }), { hasFinalReply: true, interrupted: false, cwd: repo });
    expect(instance.outputBuffer.some(message => message.type === 'tool_outcome' || message.type === 'tool_result')).toBe(false);
    expect(instance.outputBuffer.filter(message => message.type === 'tool_use')).toHaveLength(1);
    expect(warning([...renderer.values()])?.items[0]).toMatchObject({ path: 'tracked.txt', reason: 'the text to change was not found in the file' });
    expect(warning([...renderer.values()])?.items[0].detail).not.toContain('PLACEHOLDER');
    const continuityReload = outputMessagesToContinuityEntries(instance.outputBuffer).map(continuityEntryToOutputMessage);
    expect(warning(continuityReload)?.count).toBe(1);
    const archived = [...instance.outputBuffer, ...getToolOutcomes(instance.id)].sort((a, b) => a.timestamp - b.timestamp);
    const reloaded = getMessagesForRestoreTranscript(archived);
    expect(reloaded.some(message => message.type === 'tool_outcome')).toBe(false);
    expect(warning(reloaded)?.count).toBe(1);
    const restore = new HistoryRestoreCoordinator({
      history: () => ({ loadConversation: async () => ({ entry: {
        id: 'entry', sessionId: 'native', historyThreadId: 'thread', workingDirectory: repo, provider: 'claude',
        displayName: 'Fixture', createdAt: 1, endedAt: Date.now(), status: 'completed',
      }, messages: archived }) as ConversationData, markNativeResumeFailed: vi.fn() }),
      outputStorage: () => ({ storeMessages: vi.fn().mockResolvedValue(undefined) }), isRemoteNodeReachable: () => true,
    });
    const restored = await restore.restore({ createInstance: async (config: { initialOutputBuffer: OutputMessage[] }) => ({
      ...instance, id: 'restored-fixture', outputBuffer: config.initialOutputBuffer,
    }), queueContinuityPreamble: vi.fn() } as unknown as InstanceManager, 'entry', { forceFallback: true });
    expect(warning(restored.restoredMessages)?.count).toBe(1);
    expect(restored.restoredMessages.some(message => message.type === 'tool_outcome')).toBe(false);
    processMessage({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'retry-edit', name: 'Write', input: { file_path: path.join(repo, 'tracked.txt'), content: 'fixed' } }] } });
    expect(warning(instance.outputBuffer)?.count).toBe(1); // issued write does not clear it
    processMessage({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'retry-edit', content: 'written' }] } });
    await vi.waitFor(() => expect(warning(instance.outputBuffer)).toBeNull());
  });
});

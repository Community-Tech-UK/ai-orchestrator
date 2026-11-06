import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleChatAdapter } from './openai-compatible-chat-adapter';
import { OllamaCliAdapter } from './ollama-cli-adapter';
import { estimateHistoryTokens, type LocalModelHistoryTurn } from './local-model-history-compaction';
import { CompactionCoordinator } from '../../context/compaction-coordinator';
import { _resetContextEngineForTesting } from '../../context/context-engine';
import { applyCompaction, setCompactionMarkerRecorderForTesting, setupCompactionCoordinator } from '../../app/compaction-runtime';
import type { InstanceManager } from '../../instance/instance-manager';
import type { WindowManager } from '../../window-manager';

// Plan 16a: adapter-level coverage of `compactContext()` on the local-model
// chat adapters, plus the "Compact now is labelled native" case through the
// real compaction runtime. The compaction helper is unavailable, so the basic
// continuity package is what shrinks the history.
const helper = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('../../rlm/auxiliary-llm-service', () => ({ getAuxiliaryLlmService: () => ({ generate: helper.generate }) }));
vi.mock('../../rlm/llm-service', () => ({ getLLMService: () => ({ isAvailable: async () => true, generate: vi.fn() }) }));
vi.mock('../../core/system/model-call-recorder', () => ({ recordModelCall: vi.fn() }));
vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../core/config/settings-manager', () => ({ getSettingsManager: () => ({ get: vi.fn(() => 0), on: vi.fn() }) }));
vi.mock('../../session/checkpoint-manager', () => ({ getCheckpointManager: () => ({ createCheckpoint: vi.fn() }) }));
vi.mock('../../conversation-ledger', () => ({ getConversationLedgerService: () => ({ listEvidence: vi.fn(async () => []) }) }));
vi.mock('../../context-evidence/evidence-maintenance-service', () => ({
  getContextEvidenceRuntime: () => ({ blobStore: { read: vi.fn(), deriveCitationDigest: vi.fn() } }),
}));

interface HistoryHost { history: LocalModelHistoryTurn[] }
interface TurnHost {
  beginLocalModelTurn(): AbortSignal;
  endLocalModelTurn(signal: AbortSignal): void;
}

const WINDOW = 8_000;

function longHistory(): LocalModelHistoryTurn[] {
  return [
    { role: 'system', content: 'Keep replies concise.' },
    { role: 'user', content: 'Fix src/parser.ts. ' + 'Earlier detail. '.repeat(1500) },
    { role: 'assistant', content: 'Investigating. ' + 'Earlier result. '.repeat(1500) },
    { role: 'user', content: 'Then verify the change.' },
    { role: 'assistant', content: 'Verified.' },
  ];
}

function ready<T extends OpenAICompatibleChatAdapter | OllamaCliAdapter>(adapter: T, history: LocalModelHistoryTurn[]): T {
  // Ollama fixes its window at 131k; shrink it so a short fixture overflows the tail budget.
  Object.assign(adapter, { isSpawned: true, contextWindow: WINDOW, history: history.map(turn => ({ ...turn })) });
  adapter.on('error', () => undefined);
  return adapter;
}

const historyOf = (adapter: object): LocalModelHistoryTurn[] => (adapter as HistoryHost).history;

describe('local model adapter compactContext (plan 16a)', () => {
  beforeEach(() => { helper.generate.mockReset().mockRejectedValue(new Error('Fixture helper unavailable')); });
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it.each(['openai', 'ollama'] as const)('%s adapter advertises native compaction and never claims it is unsupported', name => {
    const adapter = name === 'openai'
      ? new OpenAICompatibleChatAdapter({ contextWindow: WINDOW })
      : new OllamaCliAdapter();
    expect(adapter.getRuntimeCapabilities().supportsNativeCompaction).toBe(true);
    expect(adapter.nativeCompactionKnownUnsupported()).toBe(false);
  });

  it.each(['openai', 'ollama'] as const)('%s adapter refuses to compact while a request is in flight', async name => {
    const before = longHistory();
    const adapter = ready(name === 'openai'
      ? new OpenAICompatibleChatAdapter({ contextWindow: WINDOW })
      : new OllamaCliAdapter(), before);
    const host = adapter as unknown as TurnHost;
    const contexts: unknown[] = [];
    adapter.on('context', usage => contexts.push(usage));

    const signal = host.beginLocalModelTurn();
    await expect(adapter.compactContext()).resolves.toBe(false);
    expect(historyOf(adapter)).toEqual(before);
    expect(contexts).toEqual([]);
    // Refused up front: no summary work is started for a busy session.
    expect(helper.generate).not.toHaveBeenCalled();

    host.endLocalModelTurn(signal);
    await expect(adapter.compactContext()).resolves.toBe(true);
  });

  it('Step 7 item 5: passes the user-initiated flag to the summary helper only when the caller set it', async () => {
    const adapter = ready(new OpenAICompatibleChatAdapter({ contextWindow: WINDOW }), longHistory());
    await adapter.compactContext({ userInitiated: true });
    expect(helper.generate.mock.calls[0]![3]).toEqual({ preserveInput: true, userInitiated: true });

    helper.generate.mockClear();
    const automatic = ready(new OpenAICompatibleChatAdapter({ contextWindow: WINDOW }), longHistory());
    await automatic.compactContext();
    expect(helper.generate.mock.calls[0]![3]).toEqual({ preserveInput: true });
  });

  it('discards the result when a request starts while the summary is being built', async () => {
    const before = longHistory();
    const adapter = ready(new OpenAICompatibleChatAdapter({ contextWindow: WINDOW }), before);
    const host = adapter as unknown as TurnHost;
    let signal: AbortSignal | undefined;
    helper.generate.mockImplementation(async () => {
      signal = host.beginLocalModelTurn();
      throw new Error('Fixture helper unavailable');
    });

    await expect(adapter.compactContext()).resolves.toBe(false);
    expect(helper.generate).toHaveBeenCalled();
    expect(historyOf(adapter)).toEqual(before);
    if (signal) host.endLocalModelTurn(signal);
  });

  it('shrinks its own history in place and reports the new context reading', async () => {
    const before = longHistory();
    const adapter = ready(new OpenAICompatibleChatAdapter({ contextWindow: WINDOW }), before);
    const contexts: { used: number; total: number; percentage: number }[] = [];
    adapter.on('context', usage => contexts.push(usage as typeof contexts[number]));

    await expect(adapter.compactContext()).resolves.toBe(true);

    const after = historyOf(adapter);
    expect(estimateHistoryTokens(after)).toBeLessThan(estimateHistoryTokens(before));
    expect(after[0]).toEqual(before[0]); // system message kept
    expect(after.at(-2)).toEqual(before.at(-2)); // verbatim tail
    expect(after.at(-1)).toEqual(before.at(-1));
    expect(after.some(turn => turn.role === 'assistant' && turn.content === 'Context restored.')).toBe(true);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.total).toBe(WINDOW);
    expect(contexts[0]!.used).toBeGreaterThan(0);
    expect(contexts[0]!.used).toBeLessThan(WINDOW);
  });

  it('returns false and leaves a short history untouched', async () => {
    const before: LocalModelHistoryTurn[] = [
      { role: 'system', content: 'Keep replies concise.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ];
    const adapter = ready(new OpenAICompatibleChatAdapter({ contextWindow: WINDOW }), before);
    const contexts: unknown[] = [];
    adapter.on('context', usage => contexts.push(usage));

    await expect(adapter.compactContext()).resolves.toBe(false);
    expect(historyOf(adapter)).toEqual(before);
    expect(contexts).toEqual([]);
  });

  it('sends the compacted history on the next request', async () => {
    const adapter = ready(new OpenAICompatibleChatAdapter({ contextWindow: WINDOW }), longHistory());
    const bodies: { messages: LocalModelHistoryTurn[] }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
      bodies.push(JSON.parse(init?.body ?? '{}'));
      return bodies.length === 1
        ? new Response('streaming not supported', { status: 400 })
        : new Response(JSON.stringify({ choices: [{ message: { content: 'synthetic answer' } }] }));
    }));

    await adapter.compactContext();
    const compacted = historyOf(adapter).map(({ role, content }) => ({ role, content }));
    await adapter.sendInput('one more question');

    const sent = bodies.at(-1)!.messages;
    expect(sent.slice(0, -1)).toEqual(compacted);
    expect(sent.at(-1)).toEqual({ role: 'user', content: 'one more question' });
    expect(estimateHistoryTokens(sent)).toBeLessThan(estimateHistoryTokens(longHistory()));
  });
});

describe('Compact now on a local-model session is labelled native (plan 16a)', () => {
  beforeEach(() => {
    CompactionCoordinator._resetForTesting();
    _resetContextEngineForTesting();
    setCompactionMarkerRecorderForTesting(() => undefined);
    helper.generate.mockReset().mockRejectedValue(new Error('Fixture helper unavailable'));
  });
  afterEach(() => {
    setCompactionMarkerRecorderForTesting(null);
    CompactionCoordinator._resetForTesting();
    _resetContextEngineForTesting();
    vi.restoreAllMocks();
  });

  function managerFor(adapter: OpenAICompatibleChatAdapter): { manager: InstanceManager; sendInput: ReturnType<typeof vi.fn> } {
    const sendInput = vi.fn(async () => undefined);
    const manager = {
      getAdapterRuntimeCapabilities: vi.fn(() => adapter.getRuntimeCapabilities()),
      getAdapter: vi.fn(() => adapter),
      getInstance: vi.fn(() => undefined),
      sendInput,
      emitOutputMessage: vi.fn(),
    } as unknown as InstanceManager;
    return { manager, sendInput };
  }

  it('compacts in place through the adapter and reports method native without a fallback', async () => {
    const before = longHistory();
    const adapter = ready(new OpenAICompatibleChatAdapter({ contextWindow: WINDOW }), before);
    const { manager, sendInput } = managerFor(adapter);
    setupCompactionCoordinator(manager, { sendToRenderer: vi.fn() } as unknown as WindowManager);

    const result = await CompactionCoordinator.getInstance().compactInstance('local-1');

    expect(result).toMatchObject({ success: true, method: 'native' });
    expect(result.nativeAttemptFailed).toBeUndefined();
    expect(historyOf(adapter)).not.toEqual(before);
    expect(historyOf(adapter).some(turn => turn.content === 'Context restored.')).toBe(true);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('Step 7 item 5: the Compact now button reaches the summary helper as user-initiated; an automatic compaction does not', async () => {
    const adapter = ready(new OpenAICompatibleChatAdapter({ contextWindow: WINDOW }), longHistory());
    const { manager } = managerFor(adapter);
    setupCompactionCoordinator(manager, { sendToRenderer: vi.fn() } as unknown as WindowManager);

    await applyCompaction(manager, 'local-1');
    expect(helper.generate.mock.calls[0]![3]).toEqual({ preserveInput: true, userInitiated: true });

    helper.generate.mockClear();
    Object.assign(adapter, { history: longHistory() });
    await CompactionCoordinator.getInstance().compactInstance('local-1');
    expect(helper.generate.mock.calls[0]![3]).toEqual({ preserveInput: true });
  });
});

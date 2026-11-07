import { describe, expect, it, vi } from 'vitest';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

// The R3J4 composition tests drive the real InstanceCommunicationManager send path. These are the
// same stand-ins instance-communication.guidance-adoption.spec.ts uses for it; nothing here is
// loaded at import time by the other tests in this file.
vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({ outputBufferSize: 100, enableDiskStorage: false, sessionHandoffStateEnabled: false }),
  }),
}));
vi.mock('../memory/output-storage', () => ({
  getOutputStorageManager: () => ({
    storeMessages: vi.fn().mockResolvedValue(undefined),
    deleteInstance: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.mock('../hooks/hook-manager', () => ({
  getHookManager: () => ({
    triggerHooks: vi.fn().mockResolvedValue(undefined),
    triggerLifecycleHooks: vi.fn().mockResolvedValue({ blocked: false }),
  }),
}));
vi.mock('../plugins/hook-emitter', () => ({ emitPluginHook: vi.fn() }));
vi.mock('../core/error-recovery', () => ({
  getErrorRecoveryManager: () => ({
    classifyError: vi.fn(() => ({ category: 'unknown', technicalDetails: '' })),
  }),
}));
vi.mock('../session/session-continuity', () => ({
  getSessionContinuityManagerIfInitialized: () => ({
    writeThroughIdentity: vi.fn().mockResolvedValue(undefined),
    markConversationIncomplete: vi.fn(),
  }),
}));
vi.mock('../session/session-admission-service', () => ({
  getSessionAdmissionService: () => ({
    recordUserSend: vi.fn(() => ({ admissionId: 'adm-default' })),
    markDelivered: vi.fn(),
    markFailed: vi.fn(),
  }),
}));

import { extractAuthoredUserMessage, hasIndexedCodebaseContextPreamble } from './native-user-message';
import { selectHarnessGuidance } from '../orchestration/harness-guidance';
import { CONSENSUS_RULES, SCHEDULING_RULES_REPEAT_LINE } from '../orchestration/orchestration-protocol.prompts';
import { appendActiveGoalContext } from '../commands/goal-command';
import { ContextWorkerClient } from '../instance/context-worker-client';
import { InstanceContextManager } from '../instance/instance-context';
import { buildContextBlock, queueDeferredInputContexts, type InputContextBundle } from '../instance/instance-input-contexts';
import type { InstanceContextPort } from '../instance/instance-context-port';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import { InstanceCommunicationManager } from '../instance/instance-communication';
import { InstanceContinuityInputQueue } from '../instance/instance-continuity-input-queue';
import { buildReplayContinuityMessage } from '../session/replay-continuity';
import { buildHandoffDocumentFromMessages } from '../session/handoff-state-service';
import { EventEmitter } from 'events';

const INDEXED = '[Indexed Codebase Context]\nsrc/a.ts: something\n[End Indexed Codebase Context]';
const typed = "Every weekday at 9am, check this repo's CI and tell me what failed.";

describe('extractAuthoredUserMessage', () => {
  it('returns the typed text when Harness put indexed context and scheduling rules in front of it', () => {
    const guidance = selectHarnessGuidance(typed, new Set(), new Date(), 'Europe/London');
    expect(guidance.added).toEqual(['scheduling']);
    expect(extractAuthoredUserMessage(`${INDEXED}\n\n${guidance.text}\n\n${typed}`)).toBe(typed);
  });

  it('strips guidance that has no indexed context in front of it (later turns)', () => {
    const guidance = selectHarnessGuidance(typed, new Set(), new Date(), 'UTC');
    expect(extractAuthoredUserMessage(`${guidance.text}\n\n${typed}`)).toBe(typed);
    expect(extractAuthoredUserMessage(`${SCHEDULING_RULES_REPEAT_LINE}\n\n${typed}`)).toBe(typed);
  });

  it('strips scheduling and consensus rules together', () => {
    const ask = 'Schedule a daily check and get a second opinion on whether this migration is safe';
    const guidance = selectHarnessGuidance(ask, new Set(), new Date(), 'UTC');
    expect(guidance.added).toEqual(['scheduling', 'consensus']);
    expect(extractAuthoredUserMessage(`${guidance.text}\n\n${ask}`)).toBe(ask);
    expect(extractAuthoredUserMessage(`${CONSENSUS_RULES}\n\n${ask}`)).toBe(ask);
  });

  it('keeps a user message that merely mentions a guidance heading', () => {
    for (const text of [
      'Why does "## Harness scheduling rules" show up in my chat?',
      '## Harness consensus rules\nare these still needed?',
      `Please explain this line: ${SCHEDULING_RULES_REPEAT_LINE}`,
    ]) {
      expect(extractAuthoredUserMessage(text)).toBe(text);
      expect(extractAuthoredUserMessage(`${INDEXED}\n\n${text}`)).toBe(text);
    }
  });

  it('keeps guidance-shaped text the user typed after their own words', () => {
    const guidance = selectHarnessGuidance(typed, new Set(), new Date(), 'UTC');
    const pasted = `Here is what I saw:\n\n${guidance.text}\n\nWhat does it mean?`;
    expect(extractAuthoredUserMessage(pasted)).toBe(pasted);
  });

  it('still strips only leading indexed context as before', () => {
    expect(extractAuthoredUserMessage(`${INDEXED}\n\nhello`)).toBe('hello');
    expect(extractAuthoredUserMessage(`hello\n\n${INDEXED}`)).toBe(`hello\n\n${INDEXED}`);
    expect(hasIndexedCodebaseContextPreamble(`${INDEXED}\n\nhello`)).toBe(true);
  });
});

// R2C S7. On a later turn Harness sends: memory, indexed and retrieved context
// (`buildContextBlock`), the active /goal, the guidance, then the typed text, each
// joined by a blank line (`instance-manager.ts` later-turn path). These use the REAL
// builders so a change to a block's wording shows up here, not in a user's chat.
describe('extractAuthoredUserMessage on a real later-turn composition', () => {
  const goalInstance = {
    metadata: { goal: { objective: 'Ship the token levers.\nKeep spend flat.', status: 'active', createdAt: 1, updatedAt: 1 } },
  } as unknown as Pick<Instance, 'metadata'>;
  const contexts: InputContextBundle = {
    unifiedMemoryContext: { context: 'James prefers short answers.', tokens: 9, longTermCount: 1, proceduralCount: 0, durationMs: 1 },
    indexedCodebaseContext: {
      context: 'src/a.ts:1-3\nconst a = 1;', tokens: 9, storeId: 's', workspacePath: '/repo', results: [], durationMs: 1,
    },
    rlmContext: { context: 'earlier: we chose option B', tokens: 9, sectionsAccessed: ['s1'], durationMs: 1, source: 'hybrid' },
  };
  const guidance = selectHarnessGuidance(typed, new Set(), new Date('2026-10-10T15:42:00Z'), 'UTC').text as string;

  // Both copies of the memory/RLM builders exist in production (in-process and worker client).
  const builders: [string, Pick<InstanceContextPort, 'formatRlmContextBlock' | 'formatUnifiedMemoryContextBlock'>][] = [
    ['InstanceContextManager', {
      formatRlmContextBlock: (c) => InstanceContextManager.prototype.formatRlmContextBlock.call({}, c),
      formatUnifiedMemoryContextBlock: (c) => InstanceContextManager.prototype.formatUnifiedMemoryContextBlock.call({}, c),
    }],
    ['ContextWorkerClient', {
      formatRlmContextBlock: (c) => ContextWorkerClient.prototype.formatRlmContextBlock.call({}, c),
      formatUnifiedMemoryContextBlock: (c) => ContextWorkerClient.prototype.formatUnifiedMemoryContextBlock.call({}, c),
    }],
  ];

  function wire(
    context: Pick<InstanceContextPort, 'formatRlmContextBlock' | 'formatUnifiedMemoryContextBlock'>,
    bundle: InputContextBundle | null,
    options: { goal?: boolean; guidance?: string | null; message?: string } = {},
  ): string {
    const deps = { context: context as InstanceContextPort, queueRetrievedContext: () => undefined };
    let block = buildContextBlock(deps, bundle);
    if (options.goal) block = appendActiveGoalContext(block, goalInstance);
    const text = options.guidance === undefined ? guidance : options.guidance;
    if (text) block = `${block ? `${block}\n\n` : ''}${text}`;
    return `${block ? `${block}\n\n` : ''}${options.message ?? typed}`;
  }

  describe.each(builders)('%s builders', (_name, context) => {
    it('returns only the typed text for memory + indexed + retrieved + goal + guidance', () => {
      const composed = wire(context, contexts, { goal: true });
      expect(composed).toContain('[Orchestrator Memory Context]');
      expect(composed).toContain('[Indexed Codebase Context]');
      expect(composed).toContain('[Retrieved Context]');
      expect(composed).toContain('## Active /goal');
      expect(composed).toContain('## Harness scheduling rules');
      expect(extractAuthoredUserMessage(composed)).toBe(typed);
    });

    it.each([
      ['memory', { unifiedMemoryContext: contexts.unifiedMemoryContext }],
      ['retrieved', { rlmContext: contexts.rlmContext }],
      ['indexed', { indexedCodebaseContext: contexts.indexedCodebaseContext }],
      ['memory + retrieved', { unifiedMemoryContext: contexts.unifiedMemoryContext, rlmContext: contexts.rlmContext }],
    ] as const)('strips %s context followed by guidance', (_label, partial) => {
      const bundle: InputContextBundle = { unifiedMemoryContext: null, indexedCodebaseContext: null, rlmContext: null, ...partial };
      const composed = wire(context, bundle);
      expect(composed.startsWith('[')).toBe(true);
      expect(extractAuthoredUserMessage(composed)).toBe(typed);
    });

    it('strips the skill variant of the memory block', () => {
      const skills: InputContextBundle = {
        ...contexts, indexedCodebaseContext: null, rlmContext: null,
        unifiedMemoryContext: { ...contexts.unifiedMemoryContext!, skillCount: 2 },
      };
      const composed = wire(context, skills);
      expect(composed).toContain('Follow activated skill instructions when relevant.');
      expect(extractAuthoredUserMessage(composed)).toBe(typed);
    });

    it('strips every retrieved-source label', () => {
      for (const source of ['semantic', 'lexical', 'hybrid'] as const) {
        const bundle: InputContextBundle = { ...contexts, rlmContext: { ...contexts.rlmContext!, source } };
        expect(extractAuthoredUserMessage(wire(context, bundle, { guidance: null }))).toBe(typed);
      }
    });

    it('strips an active goal that sits alone in front of the typed text', () => {
      expect(extractAuthoredUserMessage(wire(context, null, { goal: true, guidance: null }))).toBe(typed);
    });

    it('keeps multi-line bodies that contain blank lines and marker-like words', () => {
      const bundle: InputContextBundle = {
        ...contexts,
        rlmContext: { ...contexts.rlmContext!, context: 'line one\n\n[Retrieved Context] is the heading\n\nline four' },
      };
      expect(extractAuthoredUserMessage(wire(context, bundle, { goal: true }))).toBe(typed);
    });

    it('leaves a typed message that only resembles a block untouched, with or without real blocks in front', () => {
      const lookalikes = [
        '[Retrieved Context]\nSource: my notes\nbuy milk\n[End Retrieved Context]\n\nplease summarise',
        '[Orchestrator Memory Context]\nSource: me\nremember this\n[End Orchestrator Memory Context]\n\nok?',
        '[Retrieved Context]\nSource: RLM semantic search\nno end marker so this is just my text',
        '## Active /goal\n\nObjective:\nbe nice\n\nthanks',
        '## Active /goal is a heading I use, what does it mean?',
        // Right shape, wrong separator: the join always adds a blank line.
        '[Retrieved Context]\nSource: RLM semantic search\nbody\n[End Retrieved Context]\nonly one newline',
      ];
      for (const text of lookalikes) {
        expect(extractAuthoredUserMessage(text)).toBe(text);
        expect(extractAuthoredUserMessage(wire(context, contexts, { goal: true, message: text }))).toBe(text);
      }
    });

    it('does not strip guidance or blocks the user typed after their own words', () => {
      const real = wire(context, contexts, { goal: true });
      const pasted = `Here is what the app sent:\n\n${real}`;
      expect(extractAuthoredUserMessage(pasted)).toBe(pasted);
    });

    it('stops at the first block that is out of Harness order, keeping the rest as text', () => {
      const memory = buildContextBlock({ context: context as InstanceContextPort, queueRetrievedContext: () => undefined }, {
        ...contexts, indexedCodebaseContext: null, rlmContext: null,
      }) as string;
      const retrieved = buildContextBlock({ context: context as InstanceContextPort, queueRetrievedContext: () => undefined }, {
        ...contexts, indexedCodebaseContext: null, unifiedMemoryContext: null,
      }) as string;
      // Retrieved before memory is one earlier set queued ahead of the current set (R3J4; see the
      // continuity-queue composition below), so both go. A third set in a row is not Harness's.
      const reordered = `${retrieved}\n\n${memory}\n\n${guidance}\n\n${typed}`;
      expect(extractAuthoredUserMessage(reordered)).toBe(typed);
      const threeSets = `${retrieved}\n\n${memory}\n\n${memory}\n\n${guidance}\n\n${typed}`;
      expect(extractAuthoredUserMessage(threeSets)).toBe(`${memory}\n\n${guidance}\n\n${typed}`);
      // Goal before retrieved context: same.
      const goal = appendActiveGoalContext(null, goalInstance) as string;
      const goalFirst = `${goal}\n\n${retrieved}\n\n${guidance}\n\n${typed}`;
      expect(extractAuthoredUserMessage(goalFirst)).toBe(`${retrieved}\n\n${guidance}\n\n${typed}`);
      // Guidance before any block: the blocks are not leading, so they stay.
      const guidanceFirst = `${guidance}\n\n${memory}\n\n${typed}`;
      expect(extractAuthoredUserMessage(guidanceFirst)).toBe(`${memory}\n\n${typed}`);
    });

    it('keeps a block whose fixed wording was edited', () => {
      const edited = wire(context, contexts).replace('Harness memory retrieval', 'somebody else');
      expect(extractAuthoredUserMessage(edited)).toContain('[Orchestrator Memory Context]');
    });
  });
});

// R3J4. The continuity input queue (`InstanceContinuityInputQueue.prepare`, fed by
// `queueContinuityPreamble` / `queueRetrievedContext` / `queueContextWarning`) puts what it holds in FRONT of the
// current turn's blocks, and plan mode puts `ultrathink` in front of that. These drive the
// real queue and the real send path with the real builders, so a change to what Harness
// composes (or to a builder's wording) shows up here and not in a user's re-imported chat.
describe('extractAuthoredUserMessage on the continuity-queue composition (R3J4)', () => {
  const instanceId = 'inst-r3j4';
  const message = 'fix those issues please';
  const goalInstance = {
    metadata: { goal: { objective: 'Ship the token levers.\nKeep spend flat.', status: 'active', createdAt: 1, updatedAt: 1 } },
  } as unknown as Pick<Instance, 'metadata'>;
  const memory: InputContextBundle['unifiedMemoryContext'] = {
    context: 'James prefers short answers.', tokens: 9, longTermCount: 1, proceduralCount: 0, durationMs: 1,
  };
  const indexed: InputContextBundle['indexedCodebaseContext'] = {
    context: 'src/a.ts:1-3\nconst a = 1;', tokens: 9, storeId: 's', workspacePath: '/repo', results: [], durationMs: 1,
  };
  const retrieved: InputContextBundle['rlmContext'] = {
    context: 'earlier: we chose option B', tokens: 9, sectionsAccessed: ['s1'], durationMs: 1, source: 'hybrid',
  };
  // The guidance does not depend on the wording of `message` here; any scheduling ask yields the real text.
  const guidance = selectHarnessGuidance('Every weekday at 9am, check CI.', new Set(), new Date('2026-10-10T15:42:00Z'), 'UTC').text as string;
  const conversation: OutputMessage[] = [
    { id: 'u1', timestamp: 1, type: 'user', content: 'first ask' },
    { id: 'a1', timestamp: 2, type: 'assistant', content: 'first answer' },
    { id: 'u2', timestamp: 3, type: 'user', content: 'second ask' },
  ];

  const subsets = (keys: readonly ('m' | 'i' | 'r')[]): InputContextBundle[] =>
    Array.from({ length: 1 << keys.length }, (_unused, mask) => ({
      unifiedMemoryContext: mask & 1 ? memory : null,
      indexedCodebaseContext: mask & 2 ? indexed : null,
      rlmContext: mask & 4 ? retrieved : null,
    }));
  const nonEmpty = (bundle: InputContextBundle): boolean =>
    Boolean(bundle.unifiedMemoryContext || bundle.indexedCodebaseContext || bundle.rlmContext);
  const flush = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 0)); };

  // Both copies of the memory/RLM builders exist in production (in-process and worker client).
  const ports: [string, InstanceContextPort][] = [
    ['InstanceContextManager', {
      formatRlmContextBlock: (c) => InstanceContextManager.prototype.formatRlmContextBlock.call({}, c),
      formatUnifiedMemoryContextBlock: (c) => InstanceContextManager.prototype.formatUnifiedMemoryContextBlock.call({}, c),
    } as InstanceContextPort],
    ['ContextWorkerClient', {
      formatRlmContextBlock: (c) => ContextWorkerClient.prototype.formatRlmContextBlock.call({}, c),
      formatUnifiedMemoryContextBlock: (c) => ContextWorkerClient.prototype.formatUnifiedMemoryContextBlock.call({}, c),
    } as InstanceContextPort],
  ];

  /** What `instance-manager.ts` hands to `sendInput` as the context block, then what `sendInput` sends. */
  async function composeThroughQueue(
    context: InstanceContextPort,
    options: { earlier?: InputContextBundle; history?: string; current?: InputContextBundle | null; goal?: boolean; guidance?: boolean; text?: string },
  ): Promise<string> {
    const queue = new InstanceContinuityInputQueue();
    const deps = { context, queueRetrievedContext: (id: string, text: string) => { queue.queueRetrievedContext(id, text); } };
    if (options.earlier) {
      queueDeferredInputContexts(deps, instanceId, Promise.resolve(options.earlier));
      await flush();
    }
    if (options.history) queue.queueContinuity(instanceId, options.history, { userOnly: false });
    let current = buildContextBlock(deps, options.current ?? null);
    if (options.goal) current = appendActiveGoalContext(current, goalInstance);
    if (options.guidance) current = `${current ? `${current}\n\n` : ''}${guidance}`;
    const prepared = queue.prepare(instanceId, current, undefined, 'user');
    prepared.commit();
    return prepared.contextBlock ? `${prepared.contextBlock}\n\n${options.text ?? message}` : (options.text ?? message);
  }

  describe.each(ports)('%s builders through the real queue', (_name, context) => {
    it('strips a queued earlier set in front of the current set, for every pair of subsets', async () => {
      let composedCount = 0;
      let doubled = 0;
      for (const earlier of subsets(['m', 'i', 'r']).filter(nonEmpty)) {
        for (const current of subsets(['m', 'i', 'r'])) {
          for (const goal of [false, true]) {
            for (const withGuidance of [false, true]) {
              const composed = await composeThroughQueue(context, { earlier, current, goal, guidance: withGuidance });
              composedCount++;
              if (nonEmpty(current)) doubled++;
              expect(extractAuthoredUserMessage(composed)).toBe(message);
            }
          }
        }
      }
      expect(composedCount).toBe(7 * 8 * 2 * 2);
      expect(doubled).toBe(7 * 7 * 2 * 2);
    });

    it('composes the doubled shape the real transcripts show (indexed + retrieved, then indexed + retrieved)', async () => {
      const both = { unifiedMemoryContext: null, indexedCodebaseContext: indexed, rlmContext: retrieved };
      const composed = await composeThroughQueue(context, { earlier: both, current: both, guidance: true });
      // Two indexed blocks and two retrieved blocks really are in front of the typed text.
      expect(composed.match(/\[Indexed Codebase Context\]/g)).toHaveLength(2);
      expect(composed.match(/\[Retrieved Context\]/g)).toHaveLength(2);
      expect(extractAuthoredUserMessage(composed)).toBe(message);
    });

    it('strips a replay-fallback or maintained-handoff history queued in front of the blocks', async () => {
      const replay = buildReplayContinuityMessage(conversation, { reason: 'history-restore-fallback' }) as string;
      const handoff = buildHandoffDocumentFromMessages(conversation, {
        reason: 'history-restore-fallback', workingDirectory: '/repo', provider: 'claude', model: 'sonnet',
      }) as string;
      expect(replay).toContain('Resume mode: replay fallback');
      expect(handoff).toContain('Resume mode: maintained handoff document');
      const current = { unifiedMemoryContext: memory, indexedCodebaseContext: indexed, rlmContext: retrieved };
      for (const history of [replay, handoff]) {
        for (const options of [
          {},
          { current, goal: true, guidance: true },
          { current: { ...current, unifiedMemoryContext: null }, guidance: true },
        ]) {
          const composed = await composeThroughQueue(context, { history, ...options });
          expect(composed.startsWith('<conversation_history>')).toBe(true);
          expect(extractAuthoredUserMessage(composed)).toBe(message);
        }
      }
      // Nothing typed after the preamble: the CLI trims the trailing blank line.
      const queue = new InstanceContinuityInputQueue();
      queue.queueContinuity(instanceId, replay, { userOnly: false });
      expect(extractAuthoredUserMessage((queue.consume(instanceId, null, 'user') ?? '') as string)).toBe('');
    });

    it('keeps everything the user typed, including text that looks like a second set', async () => {
      const both = { unifiedMemoryContext: memory, indexedCodebaseContext: indexed, rlmContext: retrieved };
      const lookalike = await composeThroughQueue(context, { current: both, goal: true, guidance: true });
      for (const typedText of [
        message,
        `${message}\n\n${lookalike}`,
        `ultrathink about this\n\n${lookalike}`,
        `[Retrieved Context]\nSource: my notes\nbuy milk\n[End Retrieved Context]\n\n${message}`,
        '<conversation_history>\nmy own notes about the history\n</conversation_history>\n\nthanks',
      ]) {
        const composed = await composeThroughQueue(context, { earlier: both, current: both, goal: true, guidance: true, text: typedText });
        expect(extractAuthoredUserMessage(composed)).toBe(typedText);
      }
    });
  });

  describe('through the real send path', () => {
    class FakeAdapter extends EventEmitter {
      sendInput = vi.fn().mockResolvedValue(undefined);
      terminate = vi.fn().mockResolvedValue(undefined);
      getName(): string { return 'claude-cli'; }
      getSessionId(): string | null { return 'cli-session'; }
      getCurrentTurnId(): string | null { return null; }
    }

    function createInstance(planning: boolean): Instance {
      return {
        id: instanceId,
        displayName: 'Test Instance',
        createdAt: Date.now(),
        historyThreadId: 'thread-1',
        parentId: null,
        childrenIds: [],
        supervisorNodeId: '',
        workerNodeId: undefined,
        depth: 0,
        terminationPolicy: 'terminate-children',
        launchMode: 'orchestrated',
        executionLocation: { type: 'local' },
        contextInheritance: {} as Instance['contextInheritance'],
        agentId: 'build',
        agentMode: 'build',
        planMode: planning ? { enabled: true, state: 'planning' } : { enabled: false, state: 'off' },
        status: 'idle',
        contextUsage: { used: 0, total: 200000, percentage: 0 },
        lastActivity: Date.now(),
        processId: 12345,
        sessionId: 'created-session',
        providerSessionId: 'created-session',
        workingDirectory: '/tmp/project',
        yoloMode: false,
        provider: 'claude',
        currentModel: undefined,
        outputBuffer: [],
        outputBufferMaxSize: 1000,
        communicationTokens: new Map(),
        subscribedTo: [],
        totalTokensUsed: 0,
        requestCount: 0,
        errorCount: 0,
        restartCount: 0,
        restartEpoch: 0,
      };
    }

    function build(planning: boolean): { instance: Instance; adapter: FakeAdapter; manager: InstanceCommunicationManager } {
      const instance = createInstance(planning);
      const adapter = new FakeAdapter();
      const manager = new InstanceCommunicationManager({
        getInstance: (id) => (id === instance.id ? instance : undefined),
        getAdapter: (id) => (id === instance.id ? (adapter as unknown as CliAdapter) : undefined),
        setAdapter: vi.fn(),
        deleteAdapter: vi.fn(() => true),
        queueUpdate: vi.fn(),
        processOrchestrationOutput: vi.fn(),
        onInterruptedExit: vi.fn().mockResolvedValue(undefined),
        ingestToRLM: vi.fn(),
        ingestToUnifiedMemory: vi.fn(),
        emitProviderRuntimeEvent: vi.fn(),
        captureProviderRuntimeEvent: vi.fn(),
      });
      return { instance, adapter, manager };
    }

    /** The real `checkContextWarningThreshold` queues the warning exactly as a busy turn at 85% would. */
    function raiseContextWarning(manager: InstanceCommunicationManager, instance: Instance): void {
      instance.status = 'busy';
      const usage = { used: 170000, total: 200000, percentage: 85, occupancyReported: true };
      (manager as unknown as {
        checkContextWarningThreshold(id: string, target: Instance, reading: typeof usage): void;
      }).checkContextWarningThreshold(instance.id, instance, usage);
      instance.status = 'idle';
    }

    const [, context] = ports[0]!;
    const both = { unifiedMemoryContext: memory, indexedCodebaseContext: indexed, rlmContext: retrieved };

    it('strips ultrathink, a queued set, the context warning, the current set and the guidance together', async () => {
      const { instance, adapter, manager } = build(true);
      const deps = { context, queueRetrievedContext: (id: string, text: string) => manager.queueRetrievedContext(id, text) };
      queueDeferredInputContexts(deps, instance.id, Promise.resolve({ ...both, unifiedMemoryContext: null }));
      await flush();
      raiseContextWarning(manager, instance);
      const current = appendActiveGoalContext(buildContextBlock(deps, both), goalInstance) as string;
      await manager.sendInput(instance.id, message, undefined, `${current}\n\n${guidance}`);

      const sent = adapter.sendInput.mock.calls[0]?.[0] as string;
      expect(sent.startsWith('ultrathink\n\n[Indexed Codebase Context]')).toBe(true);
      expect(sent).toContain('[SYSTEM: Context Usage Warning]');
      expect(sent.match(/\[Indexed Codebase Context\]/g)).toHaveLength(2);
      expect(sent.match(/\[Retrieved Context\]/g)).toHaveLength(2);
      expect(sent).toContain('## Active /goal');
      expect(sent).toContain('## Harness scheduling rules');
      expect(extractAuthoredUserMessage(sent)).toBe(message);
    });

    it('strips the warning and a history preamble on a turn with no blocks of its own, in and out of plan mode', async () => {
      const replay = buildReplayContinuityMessage(conversation, { reason: 'session-rebuild' }) as string;
      for (const planning of [false, true]) {
        const { instance, adapter, manager } = build(planning);
        manager.queueContinuityPreamble(instance.id, replay, { userOnly: false });
        raiseContextWarning(manager, instance);
        await manager.sendInput(instance.id, message);
        const sent = adapter.sendInput.mock.calls[0]?.[0] as string;
        expect(sent.startsWith(planning ? 'ultrathink\n\n<conversation_history>' : '<conversation_history>')).toBe(true);
        expect(extractAuthoredUserMessage(sent)).toBe(message);
      }
    });

    it('leaves a plan-mode ultrathink that precedes only the typed words', async () => {
      const { instance, adapter, manager } = build(true);
      await manager.sendInput(instance.id, message);
      const sent = adapter.sendInput.mock.calls[0]?.[0] as string;
      expect(sent).toBe(`ultrathink\n\n${message}`);
      expect(extractAuthoredUserMessage(sent)).toBe(sent);
    });

    it('never removes the user\'s own words or what follows them', async () => {
      const typedWords = `look at this output\n\n${await composeThroughQueue(context, { current: both, goal: true, guidance: true, text: 'the end' })}`;
      const { instance, adapter, manager } = build(true);
      const deps = { context, queueRetrievedContext: (id: string, text: string) => manager.queueRetrievedContext(id, text) };
      queueDeferredInputContexts(deps, instance.id, Promise.resolve(both));
      await flush();
      raiseContextWarning(manager, instance);
      await manager.sendInput(instance.id, typedWords, undefined, buildContextBlock(deps, both));
      const sent = adapter.sendInput.mock.calls[0]?.[0] as string;
      expect(extractAuthoredUserMessage(sent)).toBe(typedWords.trim());
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInstance, type InstanceCreateConfig } from '../../../shared/types/instance.types';
import { getDefaultAgent } from '../../../shared/types/agent.types';
import { ClaudeCliAdapter } from '../../cli/adapters/claude-cli-adapter';
import { getHarnessGuidance } from '../../orchestration/harness-guidance';
import { SCHEDULING_RULES_REPEAT_LINE } from '../../orchestration/orchestration-protocol.prompts';
import { OrchestratorPausedError } from '../../pause/orchestrator-paused-error';
import { GlobalPauseService } from '../../global-pause/global-pause-service';
import { _resetAllContextManifestsForTesting } from '../../context/context-manifest-store';
import { assembleInstanceSystemPrompt } from '../instance-system-prompt';
import {
  deliverInitialPromptAfterSpawn, findPendingInitialPrompt,
  sendInitialPromptWithAttachmentFallback, takePendingInitialPromptGuidance,
  type InitialPromptRecoveryDeps, type InitialPromptSendDeps,
} from './initial-prompt-recovery';
import { isInitialPromptHeld } from './initial-prompt-dispatch';

// Inert enrichment/transport boundaries; assembly, delivery, recovery and the
// conversation guidance latch execute. Manager/callback wiring is covered by
// the separately retained actual-manager reproduction, not simulated here.
vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ get: () => undefined, getAll: () => ({ outputStyle: 'default', injectRepoMap: false }) }),
}));
vi.mock('../../mcp/mcp-manager', () => ({
  getMcpManager: () => ({ exportRuntimeToolContextSnapshot: () => ({ servers: [], tools: [] }) }),
}));
vi.mock('../context-worker-client', () => ({
  getContextWorkerClient: () => ({ buildProjectMemoryBrief: async () => null }),
}));
vi.mock('../../memory/project-memory-brief', () => ({
  getProjectMemoryBriefService: () => ({ buildBrief: async () => ({
    text: '', sections: [], sources: [],
    stats: { projectKey: '/tmp/inert-initial-guidance', candidatesScanned: 0, candidatesIncluded: 0, truncated: false },
  }) }),
}));
vi.mock('../../memory/project-story-convention', () => ({ extractAuthoredLessons: () => null }));
vi.mock('../../memory/project-knowledge-coordinator', () => ({
  getProjectKnowledgeCoordinator: () => ({ ensureProjectKnown: async () => undefined }),
}));
vi.mock('../../indexing/indexed-codebase-context', () => ({
  getIndexedCodebaseContextService: () => ({ buildContext: async () => null, formatContextBlock: () => 'INERT_INDEXED_CONTEXT' }),
}));

const prompt = '  Set up a daily check of CI at 9am  ';
const fullRules = '## Harness scheduling rules';

beforeEach(() => { getHarnessGuidance()._resetForTesting(); _resetAllContextManifestsForTesting(); });
afterEach(() => vi.restoreAllMocks());

async function prepare(configOverrides: Partial<InstanceCreateConfig> = {}) {
  const config: InstanceCreateConfig = {
    workingDirectory: '/tmp/inert-initial-guidance', provider: 'claude',
    initialPrompt: prompt, initialUserMessageSource: 'current-submission', ...configOverrides,
  };
  const instance = createInstance(config);
  instance.status = 'idle';
  const assembled = await assembleInstanceSystemPrompt({
    instance, config, resolvedAgent: getDefaultAgent(), instructionPrompts: [],
    initialUserMessageContent: config.initialPrompt,
    deps: {
      buildObservationContext: async () => '', buildWakeContextText: async () => null,
      buildMcpRuntimeToolContextSelection: async () => null, deferEnricherPreamble: vi.fn(),
    },
  });
  const adapter = new ClaudeCliAdapter({ model: 'opus' });
  const accepted: string[] = [];
  const send = vi.spyOn(adapter, 'sendInput').mockImplementation(async message => { accepted.push(message); });
  const queuePausedPrompt = vi.fn<InitialPromptSendDeps['queuePausedPrompt']>();
  const holdBeforeSend = vi.fn(() => false);
  const handleSendError = vi.fn(() => false);
  const deps: InitialPromptSendDeps = {
    providerLimitGate: { holdBeforeSend, handleSendError }, queuePausedPrompt,
    emitAttachmentDropWarnings: vi.fn(),
  };
  const params = {
    instance, adapter, resolvedCliType: 'claude', message: config.initialPrompt ?? '',
    contextBlock: assembled.initialRuntimeContextBlock, guidance: assembled.initialPromptGuidance,
    attachments: config.attachments,
  };
  return { instance, assembled, adapter, accepted, send, deps, params,
    queuePausedPrompt, holdBeforeSend, handleSendError,
    deliver: () => sendInitialPromptWithAttachmentFallback(params, deps) };
}

function pending(h: Awaited<ReturnType<typeof prepare>>, message = prompt) {
  const value = findPendingInitialPrompt(h.instance, message);
  expect(value).toBeDefined();
  return value!;
}

function expectFull(text: string | null | undefined) {
  expect(text?.split(fullRules)).toHaveLength(2);
  expect(text).not.toContain(SCHEDULING_RULES_REPEAT_LINE);
}

function expectRepeat(h: Awaited<ReturnType<typeof prepare>>) {
  const next = getHarnessGuidance().takeHarnessGuidance(h.instance, prompt, 'later-turn');
  expect(next.text).toContain(SCHEDULING_RULES_REPEAT_LINE);
  expect(next.text).not.toContain(fullRules);
}

describe('initial guidance delivery and pending receipt state', () => {
  it.each(['first-send', 'attachment-retry'] as const)('%s keeps guidance pending when pause arrives during adapter preparation', async mode => {
    const h = await prepare(mode === 'attachment-retry'
      ? { attachments: [{ name: 'inert.txt', type: 'text/plain', size: 16, data: 'INERT_ATTACHMENT' }] }
      : {});
    let held = false;
    vi.spyOn(GlobalPauseService, 'peek').mockReturnValue({
      holdsAutomaticInput: () => held,
    } as unknown as GlobalPauseService);
    if (mode === 'attachment-retry') {
      h.send.mockRejectedValueOnce(new Error('Adapter does not support attachments in orchestrator mode'));
    }
    h.send.mockImplementationOnce(async (message, _attachments, options) => {
      await Promise.resolve();
      held = true;
      if (!options?.dispatch?.beforeProviderDispatch) throw new Error('Missing initial provider dispatch guard');
      options.dispatch.beforeProviderDispatch();
      h.accepted.push(message);
    });

    await expect(h.deliver()).rejects.toSatisfy(isInitialPromptHeld);
    expect(h.accepted).toEqual([]);
    expect(h.send).toHaveBeenCalledTimes(mode === 'attachment-retry' ? 2 : 1);
    expectFull(takePendingInitialPromptGuidance(h.instance, pending(h)).text);

    held = false;
    await h.deliver();
    expect(h.accepted).toHaveLength(1);
    expectFull(h.accepted[0]);
    expectRepeat(h);
    expect(findPendingInitialPrompt(h.instance, prompt)).toBeUndefined();
  });

  it.each(['known-hold', 'definite-refusal', 'handled-limit'] as const)('%s leaves full guidance available', async mode => {
    const h = await prepare();
    expectFull(h.assembled.initialRuntimeContextBlock);
    expect(h.assembled.systemPrompt).toContain('## Harness commands');
    expect(h.assembled.systemPrompt).not.toContain(fullRules);
    expectFull(getHarnessGuidance().takeHarnessGuidance(h.instance, prompt, 'later-turn').text);
    if (mode === 'known-hold') h.holdBeforeSend.mockReturnValue(true);
    else h.send.mockRejectedValue(new Error('INERT_PREACCEPTANCE_REFUSAL'));
    if (mode === 'handled-limit') h.handleSendError.mockReturnValue(true);
    if (mode === 'definite-refusal') await expect(h.deliver()).rejects.toThrow('INERT_PREACCEPTANCE_REFUSAL');
    else await h.deliver();
    expect(h.accepted).toEqual([]);
    expect(h.send).toHaveBeenCalledTimes(mode === 'known-hold' ? 0 : 1);
    expect(h.holdBeforeSend).toHaveBeenCalledWith(h.instance, prompt);
    const retry = takePendingInitialPromptGuidance(h.instance, pending(h));
    expectFull(retry.text);
    expect(retry.text).toContain('INERT_INDEXED_CONTEXT');
    retry.commit();
    expectRepeat(h);
    expect(findPendingInitialPrompt(h.instance, prompt)).toBeUndefined();
  });

  it('successful direct delivery commits once and clears pending provenance', async () => {
    const h = await prepare();
    await h.deliver();
    expect(h.accepted).toHaveLength(1);
    expectFull(h.accepted[0]);
    expect(h.accepted[0]).toBe(`${h.assembled.initialRuntimeContextBlock}\n\n${prompt}`);
    expectRepeat(h);
    expect(findPendingInitialPrompt(h.instance, prompt)).toBeUndefined();
  });

  it('swallowed outer failure preserves the session without committing guidance', async () => {
    const h = await prepare();
    h.send.mockRejectedValue(new Error('INERT_PREACCEPTANCE_REFUSAL'));
    const recovery: InitialPromptRecoveryDeps = {
      transitionState: (instance, status) => { instance.status = status; }, queueUpdate: vi.fn(),
      addToOutputBuffer: (instance, message) => { instance.outputBuffer.push(message); }, emitOutput: vi.fn(),
    };
    await deliverInitialPromptAfterSpawn(h.instance, new AbortController().signal, h.deliver, recovery);
    expect(h.instance.status).toBe('idle');
    expect(h.instance.outputBuffer).toHaveLength(1);
    expectFull(takePendingInitialPromptGuidance(h.instance, pending(h)).text);
    expect(h.accepted).toEqual([]);
  });

  it('paused delivery queues only base context and exact raw text, then retries full guidance once', async () => {
    const h = await prepare();
    h.send.mockRejectedValue(new OrchestratorPausedError());
    await h.deliver();
    expect(h.queuePausedPrompt).toHaveBeenCalledOnce();
    const queued = h.queuePausedPrompt.mock.calls[0][0].message;
    expect(queued).toBe(`INERT_INDEXED_CONTEXT\n\n${prompt}`);
    expect(queued).not.toContain(fullRules);
    const match = pending(h, queued);
    expect(match.message).toBe(prompt);
    expect(findPendingInitialPrompt(h.instance, prompt.trim())).toBeUndefined();
    const retry = takePendingInitialPromptGuidance(h.instance, match);
    expectFull(retry.text);
    expect(retry.text?.split('INERT_INDEXED_CONTEXT')).toHaveLength(2);
    // This is the hidden context/receipt API used by manager, not a fake send.
    expectFull(takePendingInitialPromptGuidance(h.instance, match).text);
    retry.commit();
    expectRepeat(h);
  });

  it.each(['changed', 'adopted'] as const)('selects guidance for the %s current conversation', async mode => {
    const h = await prepare();
    h.holdBeforeSend.mockReturnValue(true);
    await h.deliver();
    const previous = h.instance.providerSessionId;
    if (mode === 'adopted') getHarnessGuidance().adoptProviderSessionId(h.instance, previous, 'inert-next-session');
    h.instance.providerSessionId = 'inert-next-session';
    const retry = takePendingInitialPromptGuidance(h.instance, pending(h));
    expectFull(retry.text);
    retry.commit();
    expectRepeat(h);
  });

  it.each(['accepted', 'paused', 'handled-limit'] as const)('attachment fallback %s respects the delivery boundary', async mode => {
    const h = await prepare({ attachments: [{ name: 'inert.txt', type: 'text/plain', size: 16, data: 'INERT_ATTACHMENT' }] });
    h.send.mockRejectedValueOnce(new Error('Adapter does not support attachments in orchestrator mode'));
    if (mode === 'paused') h.send.mockRejectedValueOnce(new OrchestratorPausedError());
    if (mode === 'handled-limit') {
      h.send.mockRejectedValueOnce(new Error('INERT_LIMIT'));
      h.handleSendError.mockReturnValueOnce(false).mockReturnValueOnce(true);
    }
    await h.deliver();
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.send.mock.calls[1][1]).toBeUndefined();
    expect(h.deps.emitAttachmentDropWarnings).toHaveBeenCalledOnce();
    if (mode === 'accepted') { expectFull(h.accepted[0]); expectRepeat(h); }
    else {
      expect(h.accepted).toEqual([]);
      expectFull(takePendingInitialPromptGuidance(h.instance, pending(h)).text);
    }
  });

  it('an older delivery receipt cannot clear a newer pending selection', async () => {
    const h = await prepare();
    h.holdBeforeSend.mockReturnValue(true);
    await h.deliver();
    const match = pending(h);
    const old = takePendingInitialPromptGuidance(h.instance, match);
    const newer = takePendingInitialPromptGuidance(h.instance, match);
    old.commit();
    expect(findPendingInitialPrompt(h.instance, prompt)).toBe(match);
    newer.commit();
    expect(findPendingInitialPrompt(h.instance, prompt)).toBeUndefined();
    expectRepeat(h);
  });

  it('an older direct send cannot clear a replacement pending entry', async () => {
    const h = await prepare();
    let finish: (() => void) | undefined;
    h.send.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const first = h.deliver();
    const old = pending(h);
    h.holdBeforeSend.mockReturnValue(true);
    await h.deliver();
    const newer = pending(h);
    expect(newer).not.toBe(old);
    finish!(); await first;
    expect(findPendingInitialPrompt(h.instance, prompt)).toBe(newer);
  });

  it('matches neither unrelated text nor a different Instance with the same ids', async () => {
    const h = await prepare();
    h.holdBeforeSend.mockReturnValue(true); await h.deliver();
    expect(findPendingInitialPrompt(h.instance, `${prompt} extra`)).toBeUndefined();
    expect(findPendingInitialPrompt({ ...h.instance }, prompt)).toBeUndefined();
  });

  it.each(['machine', 'continuity', 'legacy-source', 'no-intent'] as const)('%s keeps ordinary initial-send behavior', async mode => {
    const h = await prepare(mode === 'machine' ? { metadata: { automationId: 'inert-job' } }
      : mode === 'continuity' ? { resume: true }
      : mode === 'legacy-source' ? { initialUserMessageSource: undefined }
      : { initialPrompt: 'Read the README' });
    if (mode === 'continuity') expect(h.assembled.initialRuntimeContextBlock).toBeUndefined();
    else expect(h.assembled.initialRuntimeContextBlock).not.toContain(fullRules);
    h.send.mockRejectedValue(new OrchestratorPausedError());
    await h.deliver();
    expect(findPendingInitialPrompt(h.instance, h.params.message)).toBeUndefined();
    expect(h.queuePausedPrompt.mock.calls[0][0].message).toBe(h.params.contextBlock
      ? `${h.params.contextBlock}\n\n${h.params.message}` : h.params.message);
  });
});

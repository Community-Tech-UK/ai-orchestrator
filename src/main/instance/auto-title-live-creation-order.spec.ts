/**
 * Titles on the real creation path (Step 14b, repair T13).
 *
 * `createInstance` asks for the AI title before the adapter exists, so the
 * resident Claude pipe is not there on the first live-title attempt. These
 * tests run the REAL auto-title service, the REAL auxiliary service (so the
 * helper back-off decision has its real shape) and the REAL control channel
 * fed the Claude Code 2.1.303 wire reply, and only fake the model endpoint and
 * the instance manager.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/types/settings.types';
import type { AuxiliaryLlmSlotConfigMap } from '../../shared/types/auxiliary-llm.types';

const mockLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }));
vi.mock('../logging/logger', () => ({ getLogger: () => mockLog }));
vi.mock('../rlm/token-counter', () => ({
  getTokenCounter: () => ({ countTokens: (text: string) => text.length }),
}));
vi.mock('../rlm/auxiliary-model-client', () => ({
  probeOllamaEndpoint: vi.fn(),
  listOllamaModels: vi.fn(),
  generateWithOllama: vi.fn(),
  probeOpenAiCompatibleEndpoint: vi.fn(),
  listOpenAiCompatibleModels: vi.fn(),
  generateWithOpenAiCompatible: vi.fn(),
}));
vi.mock('../core/system/cost-attribution', () => ({
  recordAuxiliaryAttribution: vi.fn(),
  reserveAuxiliarySpend: vi.fn(() => ({ allowed: true, spentUsd: 0 })),
}));
const recordModelCall = vi.hoisted(() => vi.fn());
vi.mock('../core/system/model-call-recorder', () => ({ recordModelCall }));
const createAdapter = vi.hoisted(() => vi.fn());
vi.mock('../providers/provider-runtime-service', () => ({
  getProviderRuntimeService: () => ({ createAdapter }),
}));
vi.mock('../cli/adapters/adapter-factory', () => ({ resolveCliType: vi.fn() }));
vi.mock('../cli/cli-detection', () => ({ isCliAvailable: vi.fn() }));

import { AuxiliaryLlmService } from '../rlm/auxiliary-llm-service';
import { generateWithOllama, listOllamaModels, probeOllamaEndpoint } from '../rlm/auxiliary-model-client';
import { ClaudeControlChannel, type ClaudeControlWriter } from '../cli/adapters/claude-control-channel';
import { AutoTitleService } from './auto-title-service';
import { requestLiveTitle } from './live-title-source';

const MESSAGE = 'Fix the broken deploy pipeline on staging';

function configureHelper(service: AuxiliaryLlmService): void {
  const slots = JSON.parse(DEFAULT_SETTINGS.auxiliaryLlmSlotsJson) as AuxiliaryLlmSlotConfigMap;
  slots.titleGeneration = { ...slots.titleGeneration, allowFrontierFallback: true };
  service.configure({
    ...DEFAULT_SETTINGS,
    auxiliaryLlmRoutingMode: 'local-first',
    auxiliaryLlmUseLocalhostOllama: false,
    auxiliaryLlmEndpointsJson: JSON.stringify([{
      id: 'test-local', label: 'Local test endpoint', provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434', source: 'manual', enabled: true,
    }]),
    auxiliaryLlmSlotsJson: JSON.stringify(slots),
  });
}

interface Harness {
  instance: { id: string; provider: string | undefined; status: string; isRenamed: boolean };
  adapter: unknown;
  requests: { subtype: string; fields: Record<string, unknown> }[];
  resident: boolean;
  getInstance(): Harness['instance'] | undefined;
  getAdapter(): unknown;
}

/** A resident-capable Claude adapter whose pipe opens when `resident` flips. */
function makeHarness(provider = 'claude'): Harness {
  const channel = new ClaudeControlChannel();
  const harness: Harness = {
    instance: { id: 'one', provider, status: 'initializing', isRenamed: false },
    adapter: undefined,
    requests: [],
    resident: false,
    getInstance: () => harness.instance,
    getAdapter: () => harness.adapter,
  };
  const writer: ClaudeControlWriter = {
    sendControlRequest: async (subtype, requestId, fields) => {
      harness.requests.push({ subtype, fields: fields ?? {} });
      // Real 2.1.303 wire reply: data sits in the envelope's own `response`.
      queueMicrotask(() => channel.handleResponse({
        type: 'control_response',
        response: { subtype: 'success', request_id: requestId, response: { title: 'Fix staging deploy pipeline' } },
      }));
    },
  };
  harness.adapter = {
    getAdapterCapabilities: () => ({ residentSession: harness.resident }),
    requestControl: (subtype: string, fields: Record<string, unknown>, timeoutMs: number) => harness.resident
      ? channel.request(writer, subtype, fields, { timeoutMs })
      : Promise.resolve({ ok: false as const, code: 'not-running' as const, message: 'not running' }),
  };
  return harness;
}

describe('AI title on the creation path', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    vi.clearAllMocks();
    AutoTitleService._resetForTesting();
    AuxiliaryLlmService._resetForTesting();
    configureHelper(AuxiliaryLlmService.getInstance());
    // The local helper is stopped: every model call fails.
    vi.mocked(probeOllamaEndpoint).mockResolvedValue(true);
    vi.mocked(listOllamaModels).mockResolvedValue([{
      id: 'test-model', name: 'test-model', provider: 'ollama', endpointId: 'test-local',
    }]);
    vi.mocked(generateWithOllama).mockRejectedValue(new Error('helper stopped'));
  });
  afterEach(() => vi.useRealTimers());

  function wire(harness: Harness): void {
    AutoTitleService.getInstance().setLiveTitleSource((instanceId, description) =>
      requestLiveTitle(harness, instanceId, description));
  }

  it('upgrades the instant title once the session becomes resident after the title request', async () => {
    const harness = makeHarness();
    wire(harness);
    const applyTitle = vi.fn();

    // createInstance order: the title is requested first ...
    const done = AutoTitleService.getInstance().maybeGenerateTitle('one', MESSAGE, applyTitle);
    await vi.advanceTimersByTimeAsync(0);
    expect(applyTitle).toHaveBeenCalledWith('one', expect.any(String), 'instant');
    expect(harness.requests).toEqual([]);
    // ... the adapter is registered next, and only later the process is up.
    await vi.advanceTimersByTimeAsync(2_000);
    harness.instance.status = 'idle';
    harness.resident = true;
    await vi.advanceTimersByTimeAsync(2_000);
    await done;

    expect(harness.requests).toEqual([{
      subtype: 'generate_session_title',
      fields: { description: MESSAGE, persist: false },
    }]);
    expect(applyTitle).toHaveBeenLastCalledWith('one', 'Fix staging deploy pipeline', 'ai');
    expect(applyTitle.mock.calls.filter(([, , source]) => source === 'ai')).toHaveLength(1);
    expect(createAdapter).not.toHaveBeenCalled();
  });

  it('still asks the live session while the helper is paused after repeated failures', async () => {
    const harness = makeHarness();
    harness.resident = true;
    wire(harness);
    // Two earlier titles drive the REAL back-off into its pause.
    await AuxiliaryLlmService.getInstance().generate('titleGeneration', 's', 'u');
    await AuxiliaryLlmService.getInstance().generate('titleGeneration', 's', 'u');
    const paused = await AuxiliaryLlmService.getInstance().generate('titleGeneration', 's', 'u');
    expect(paused.decision).toMatchObject({ pausedUntil: expect.any(Number), allowFrontierFallback: false });

    const applyTitle = vi.fn();
    await AutoTitleService.getInstance().maybeGenerateTitle('one', MESSAGE, applyTitle);
    expect(applyTitle).toHaveBeenLastCalledWith('one', 'Fix staging deploy pipeline', 'ai');
    expect(createAdapter).not.toHaveBeenCalled();
  });

  it('does not use the live session when the title slot forbids frontier fallback, even if paused', async () => {
    const slots = JSON.parse(DEFAULT_SETTINGS.auxiliaryLlmSlotsJson) as AuxiliaryLlmSlotConfigMap;
    slots.titleGeneration = { ...slots.titleGeneration, allowFrontierFallback: false };
    const service = AuxiliaryLlmService.getInstance();
    service.configure({
      ...DEFAULT_SETTINGS,
      auxiliaryLlmRoutingMode: 'local-first',
      auxiliaryLlmUseLocalhostOllama: false,
      auxiliaryLlmEndpointsJson: JSON.stringify([{
        id: 'test-local', label: 'Local test endpoint', provider: 'ollama',
        baseUrl: 'http://127.0.0.1:11434', source: 'manual', enabled: true,
      }]),
      auxiliaryLlmSlotsJson: JSON.stringify(slots),
    });
    const harness = makeHarness();
    harness.resident = true;
    wire(harness);
    await service.generate('titleGeneration', 's', 'u');
    await service.generate('titleGeneration', 's', 'u');
    const applyTitle = vi.fn();
    await AutoTitleService.getInstance().maybeGenerateTitle('one', MESSAGE, applyTitle);
    expect(harness.requests).toEqual([]);
    expect(applyTitle.mock.calls.map((call) => call[2])).toEqual(['instant']);
  });

  it('never overwrites a rename made while waiting for the session', async () => {
    const harness = makeHarness();
    wire(harness);
    const applyTitle = vi.fn((_id: string, _title: string, _source: string) => undefined);
    const done = AutoTitleService.getInstance().maybeGenerateTitle(
      'one', MESSAGE, applyTitle, false,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    harness.instance.isRenamed = true;
    harness.resident = true;
    await vi.advanceTimersByTimeAsync(2_000);
    await done;
    // Nothing was asked of the session, and no AI title was applied.
    expect(harness.requests).toEqual([]);
    expect(applyTitle.mock.calls.some((call) => call[2] === 'ai')).toBe(false);
  });

  it('does not wait for a session that is not Claude, and logs the skip once', async () => {
    const harness = makeHarness('codex');
    wire(harness);
    const applyTitle = vi.fn();
    await AutoTitleService.getInstance().maybeGenerateTitle('one', MESSAGE, applyTitle);
    expect(harness.requests).toEqual([]);
    expect(applyTitle.mock.calls.map((call) => call[2])).toEqual(['instant']);
    const skipped = mockLog.info.mock.calls.filter(([message]) =>
      String(message).startsWith('AI title upgrade skipped'));
    expect(skipped).toHaveLength(1);
  });

  // `createInstanceBuilder` seeds `provider: config.provider || 'auto'`; the real
  // provider is only written once init resolves it (`instance.provider = resolvedCliType`),
  // which is after the title request and before the adapter exists.
  it.each(['auto', undefined] as const)(
    'keeps waiting while the provider is still %s, then upgrades once init resolves it to Claude',
    async (unresolved) => {
      const harness = makeHarness('auto');
      harness.instance.provider = unresolved;
      wire(harness);
      const applyTitle = vi.fn();

      const done = AutoTitleService.getInstance().maybeGenerateTitle('one', MESSAGE, applyTitle);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(harness.requests).toEqual([]);
      expect(mockLog.info.mock.calls.some(([message]) => String(message).startsWith('AI title upgrade skipped'))).toBe(false);

      harness.instance.provider = 'claude';
      harness.instance.status = 'idle';
      harness.resident = true;
      await vi.advanceTimersByTimeAsync(2_000);
      await done;

      expect(harness.requests).toEqual([{
        subtype: 'generate_session_title',
        fields: { description: MESSAGE, persist: false },
      }]);
      expect(applyTitle).toHaveBeenLastCalledWith('one', 'Fix staging deploy pipeline', 'ai');
      expect(createAdapter).not.toHaveBeenCalled();
    },
  );

  it('stops waiting as soon as init resolves an auto provider to a non-Claude CLI', async () => {
    const harness = makeHarness('auto');
    wire(harness);
    const applyTitle = vi.fn();
    let finished = false;

    const done = AutoTitleService.getInstance().maybeGenerateTitle('one', MESSAGE, applyTitle)
      .then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(finished).toBe(false);

    harness.instance.provider = 'codex';
    await vi.advanceTimersByTimeAsync(1_000);
    // Well inside the 120 s wait: the resolved provider ended it, not the timeout.
    expect(finished).toBe(true);
    await done;

    expect(harness.requests).toEqual([]);
    expect(applyTitle.mock.calls.map((call) => call[2])).toEqual(['instant']);
    expect(mockLog.info.mock.calls.filter(([message]) =>
      String(message).startsWith('AI title upgrade skipped'))).toHaveLength(1);
    expect(createAdapter).not.toHaveBeenCalled();
  });

  it('gives up quietly when the session never becomes resident', async () => {
    const harness = makeHarness();
    wire(harness);
    const applyTitle = vi.fn();
    const done = AutoTitleService.getInstance().maybeGenerateTitle('one', MESSAGE, applyTitle);
    await vi.advanceTimersByTimeAsync(300_000);
    await done;
    expect(harness.requests).toEqual([]);
    expect(applyTitle.mock.calls.map((call) => call[2])).toEqual(['instant']);
    expect(createAdapter).not.toHaveBeenCalled();
  });
});

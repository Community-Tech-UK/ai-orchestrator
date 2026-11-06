import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCliAdapter } from '../../cli/adapters/claude-cli-adapter';
import { applyClaudeLiveRuntime } from '../../cli/adapters/claude-live-runtime';
import { createInstance } from '../../../shared/types/instance.types';
import { DEFAULT_SETTINGS } from '../../../shared/types/settings-defaults';
import { getSessionMutex } from '../../session/session-mutex';
import { RuntimeReconciler } from './runtime-reconciler';
import type { RuntimeReconcilerDeps } from './runtime-reconciler.types';
import { _resetAdapterLoansForTesting, isRuntimeChangeInFlight } from './adapter-loan-registry';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ get: () => undefined, getAll: () => ({}) }),
}));

beforeEach(() => _resetAdapterLoansForTesting());
afterEach(() => { vi.restoreAllMocks(); _resetAdapterLoansForTesting(); });

function harness(
  appliedModel: string,
  wire: 'mocked-reply' | 'real-wire' = 'mocked-reply',
  appliedEffort?: string | null,
) {
  const oldModel = 'claude-opus-4-6-20260401';
  const instance = createInstance({
    workingDirectory: '/tmp/inert-runtime', provider: 'claude', sessionId: 'inert-native-session',
    modelOverride: oldModel, reasoningEffort: 'high', initialOutputBuffer: [
      { id: 'user', timestamp: 1, type: 'user', content: 'Inert request' },
      { id: 'assistant', timestamp: 2, type: 'assistant', content: 'Inert response' },
    ],
  });
  instance.currentModel = oldModel;
  instance.status = 'idle';
  instance.processId = 123;
  const adapter = new ClaudeCliAdapter({ model: oldModel, residentClaude: true });
  // Native transport/residency is inert; actual verification, adapter commit,
  // reconciler, ownership, mutex and state/publication branches execute.
  vi.spyOn(adapter, 'getAdapterCapabilities').mockReturnValue({
    ...adapter.getAdapterCapabilities(), residentSession: true,
  });
  const control = vi.spyOn(adapter, 'requestControl');
  if (wire === 'mocked-reply') {
    control.mockImplementation(async () => ({ ok: true, payload: { applied: { model: appliedModel } } }));
  } else {
    // Real control channel, answered in the wire shape Claude Code 2.1.303 sends:
    // {type:'control_response', response:{subtype:'success', request_id, response:<data>}}.
    // set_model succeeds with no data; get_settings carries `applied` one level in.
    (adapter as unknown as { formatter: unknown }).formatter = {
      sendControlRequest: async (subtype: string, requestId: string) => {
        queueMicrotask(() => (adapter as unknown as { processCliMessage(raw: unknown): void }).processCliMessage({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: requestId,
            ...(subtype === 'get_settings'
              ? { response: { applied: { model: appliedModel, ...(appliedEffort !== undefined ? { effort: appliedEffort } : {}) } } }
              : {}),
          },
        }));
      },
    };
    vi.spyOn(adapter as unknown as { isRealPipe(): boolean }, 'isRealPipe').mockReturnValue(true);
  }
  // Stop at fallback entry: this test does not claim completed replay or a CLI spawn.
  const terminate = vi.spyOn(adapter, 'terminate').mockRejectedValue(new Error('REPLAY_FALLBACK_ENTERED'));
  const send = vi.spyOn(adapter, 'sendInput').mockRejectedValue(new Error('UNEXPECTED_PROVIDER_SEND'));
  const emitSystemNotice = vi.fn();
  const emitRuntimeChanged = vi.fn();
  const deleteAdapter = vi.fn(() => true);
  const unexpected = (): never => { throw new Error('UNEXPECTED_REPLAY_COMPLETION'); };
  const deps: RuntimeReconcilerDeps = {
    getInstance: () => instance, getAdapter: () => adapter,
    setAdapter: unexpected, deleteAdapter, setupAdapterEvents: unexpected,
    transitionState: unexpected, resolveCliTypeForInstance: async () => 'claude',
    getAdapterRuntimeCapabilities: () => ({ supportsResume: true, supportsForkSession: true }),
    assertLocalModelRuntimeAvailable: unexpected, residentClaudeForSpawn: () => true,
    createRuntimeAdapter: unexpected, evaluateResumeHealth: unexpected,
    waitForInputReadinessBoundary: unexpected, prepareStatusForAdapterInput: unexpected,
    buildReplayContinuityMessage: unexpected, buildFallbackHistory: unexpected,
    emitModelSelectionDegradation: unexpected, emitSystemNotice, emitRuntimeChanged,
    emitYoloToggled: unexpected, getSettings: () => ({ ...DEFAULT_SETTINGS, defaultCli: 'claude' }),
    get spawnConfigBuilder(): RuntimeReconcilerDeps['spawnConfigBuilder'] { return unexpected(); },
    queueUpdate: vi.fn(),
    holdContinuityUntilAnswered: vi.fn(),
  };
  return { instance, oldModel, adapter, control, terminate, send, deleteAdapter,
    emitSystemNotice, emitRuntimeChanged, reconciler: new RuntimeReconciler(deps) };
}

describe('Claude live model identity through the actual adapter and reconciler', () => {
  it.each([
    ['applied short alias permits concrete request', 'claude-opus-4-8', 'opus', true],
    ['case and combined suffix', 'claude-opus-4-8', '  CLAUDE-OPUS-4-8-20260401[1M]  ', true],
    ['requested alias with context suffix', 'opus[1m]', 'claude-opus-4-8', true],
    ['different Sonnet revision', 'claude-sonnet-4-5-20250929', 'claude-sonnet-4-6-20260401', false],
    ['concrete model name prefix is not identity', 'claude-opus-4-8', 'claude-opus-4-80', false],
    ['unrecognized model embedding family is not alias', 'claude-opus-4-8', 'not-claude-opus-4-8', false],
    ['exact concrete', 'claude-opus-4-8', 'claude-opus-4-8', true],
    ['date suffix', 'claude-opus-4-8', 'claude-opus-4-8-20260401', true],
    ['context suffix', 'claude-opus-4-8', 'claude-opus-4-8[1m]', true],
    ['requested short alias permits concrete family', 'opus', 'claude-opus-4-8', true],
    ['different family enters existing replay fallback', 'claude-opus-4-8', 'claude-sonnet-4-6', false],
    ['concrete different revision must enter replay fallback', 'claude-opus-4-8', 'claude-opus-4-6-20260401', false],
  ] as const)('%s', async (_label, desiredModel, appliedModel, shouldAccept) => {
    const h = harness(appliedModel);
    const change = h.reconciler.applyRuntimeChange(h.instance.id, { provider: 'claude', model: desiredModel });
    if (shouldAccept) {
      await change;
      expect(h.terminate).not.toHaveBeenCalled();
      expect(h.deleteAdapter).not.toHaveBeenCalled();
      expect(h.instance.currentModel).toBe(desiredModel);
      expect(h.emitSystemNotice).toHaveBeenCalledOnce();
      expect(h.emitRuntimeChanged).toHaveBeenCalledWith(expect.objectContaining({ model: desiredModel }));
    } else {
      await expect(change).rejects.toThrow('REPLAY_FALLBACK_ENTERED');
      expect(h.deleteAdapter).toHaveBeenCalledWith(h.instance.id);
      expect(h.terminate).toHaveBeenCalledOnce();
      expect(h.instance.currentModel).toBe(h.oldModel);
      expect(h.emitSystemNotice).not.toHaveBeenCalled();
      expect(h.emitRuntimeChanged).not.toHaveBeenCalled();
    }
    expect(h.send).not.toHaveBeenCalled();
    expect(h.control.mock.calls.map(call => call[0])).toEqual(['set_model', 'get_settings']);
    expect(isRuntimeChangeInFlight(h.instance.id)).toBe(false);
    expect(getSessionMutex().isLocked(h.instance.id)).toBe(false);
  });

  it.each([
    ['verifies a matching model from the real wire reply and stays live', 'claude-opus-4-8', 'claude-opus-4-8', true],
    ['rejects a different model reported in the real wire reply', 'claude-opus-4-8', 'claude-sonnet-4-6', false],
  ] as const)('real wire shape: %s', async (_label, desiredModel, appliedModel, shouldAccept) => {
    const h = harness(appliedModel, 'real-wire');
    const change = h.reconciler.applyRuntimeChange(h.instance.id, { provider: 'claude', model: desiredModel });
    if (shouldAccept) {
      await change;
      expect(h.terminate).not.toHaveBeenCalled();
      expect(h.instance.currentModel).toBe(desiredModel);
    } else {
      await expect(change).rejects.toThrow('REPLAY_FALLBACK_ENTERED');
      expect(h.instance.currentModel).toBe(h.oldModel);
    }
    expect(h.control.mock.calls.map(call => call[0])).toEqual(['set_model', 'get_settings']);
  });

  it.each([
    ['accepts an effort the CLI confirms', 'low', 'low', true],
    ['falls back to restart when the old effort is still applied', 'low', 'high', false],
    ['falls back to restart when the CLI drops an unsupported effort', 'minimal', null, false],
  ] as const)('real wire shape, effort only: %s', async (_label, desiredEffort, appliedEffort, shouldAccept) => {
    const h = harness('claude-opus-4-6-20260401', 'real-wire', appliedEffort);
    const change = h.reconciler.applyRuntimeChange(h.instance.id, { provider: 'claude', reasoningEffort: desiredEffort });
    if (shouldAccept) {
      await change;
      expect(h.terminate).not.toHaveBeenCalled();
      expect(h.instance.reasoningEffort).toBe(desiredEffort);
    } else {
      await expect(change).rejects.toThrow('REPLAY_FALLBACK_ENTERED');
      expect(h.deleteAdapter).toHaveBeenCalledWith(h.instance.id);
      expect(h.terminate).toHaveBeenCalledOnce();
      expect(h.instance.reasoningEffort).toBe('high');
      expect(h.emitSystemNotice).not.toHaveBeenCalled();
      expect(h.emitRuntimeChanged).not.toHaveBeenCalled();
    }
    expect(h.send).not.toHaveBeenCalled();
    expect(h.control.mock.calls.map(call => call[0])).toEqual(['apply_flag_settings', 'get_settings']);
  });

  it('commits the requested alias only after compatible settings verification', async () => {
    const commit = vi.fn();
    const result = await applyClaudeLiveRuntime({
      requestControl: async () => ({ ok: true, payload: { applied: { model: 'claude-opus-4-8' } } }), commit,
    }, { model: 'opus' });
    expect(result).toEqual({ ok: true });
    expect(commit).toHaveBeenCalledWith('opus', undefined);
  });
});

// Legacy IDs are comparator-only controls, not current catalog/reconciler routes.
describe('Claude live model legacy identity (comparator only)', () => {
  it.each([
    ['claude-3-5-sonnet', 'claude-3-5-sonnet-20241022', true],
    ['sonnet', 'claude-3-5-sonnet-20241022', true],
    ['claude-3-5-sonnet', 'sonnet', true],
    ['claude-3-5-sonnet', 'claude-3-sonnet-20240229', false],
    ['claude-3-5-sonnet', 'claude-3-5-haiku-20241022', false],
  ] as const)('%s versus %s', async (desired, applied, accepted) => {
    const commit = vi.fn();
    const result = await applyClaudeLiveRuntime({ requestControl: async () => ({ ok: true, payload: { applied: { model: applied } } }), commit }, { model: desired });
    expect(result.ok).toBe(accepted);
    expect(commit).toHaveBeenCalledTimes(accepted ? 1 : 0);
  });
});

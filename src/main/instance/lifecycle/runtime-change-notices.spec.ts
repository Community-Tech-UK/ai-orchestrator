/**
 * Runtime-change notice wording and delivery (LT-015).
 *
 * The regression these guard: the notices were sent with `adapter.sendInput`
 * only, which reaches the CLI but never renders. Live checks across three doc
 * families asserted on a transcript line that could not appear.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  announceRuntimeChange,
  modelChangeNoticeText,
  providerChangeNoticeText,
  runtimeChangeNoticesFor,
  yoloNoticeText,
} from './runtime-change-notices';
import type { CliAdapter } from '../../cli/adapters/adapter-factory';
import type { Instance } from '../../../shared/types/instance.types';

const instance = { id: 'inst-1' } as unknown as Instance;

function makeAdapter(): CliAdapter & { sendInput: ReturnType<typeof vi.fn> } {
  return { sendInput: vi.fn().mockResolvedValue(undefined) } as unknown as CliAdapter & {
    sendInput: ReturnType<typeof vi.fn>;
  };
}

describe('notice wording', () => {
  it('names the permission posture in both directions', () => {
    expect(yoloNoticeText(true)).toContain('YOLO mode enabled');
    expect(yoloNoticeText(false)).toContain('YOLO mode disabled');
  });

  it('states both providers, both models and that context carried over', () => {
    const text = providerChangeNoticeText({
      oldProvider: 'claude',
      oldModel: 'sonnet',
      newProvider: 'codex',
      newModel: 'gpt-5.6-sol',
      oldReasoningEffort: 'high',
      newReasoningEffort: 'medium',
    });
    expect(text).toContain('Provider changed from claude (model sonnet) to codex (model gpt-5.6-sol)');
    expect(text).toContain('Thinking changed from high to medium');
    expect(text).toContain('carried over from the previous provider');
  });

  it('falls back to "provider default" for an absent model or effort', () => {
    const text = providerChangeNoticeText({
      oldProvider: 'claude',
      oldModel: undefined,
      newProvider: 'codex',
      newModel: '',
      oldReasoningEffort: undefined,
      newReasoningEffort: null,
    });
    expect(text).toContain('(model provider default) to codex (model provider default)');
    expect(text).toContain('Thinking changed from provider default to provider default');
  });

  it('says context is preserved for a same-provider model change', () => {
    const text = modelChangeNoticeText({
      oldModel: 'sonnet',
      newModel: 'opus',
      oldReasoningEffort: 'low',
      newReasoningEffort: 'high',
    });
    expect(text).toContain('Model changed from sonnet to opus');
    expect(text).toContain('Conversation context has been preserved');
  });
});

describe('runtimeChangeNoticesFor', () => {
  const base = {
    isProviderSwap: false,
    yoloModeChanged: false,
    nextYoloMode: true,
    oldProvider: 'claude',
    newProvider: 'claude',
    oldModel: 'sonnet',
    newModel: 'opus',
    oldReasoningEffort: 'high' as const,
    newReasoningEffort: 'high' as const,
  };

  it('announces only the permission change for a pure yolo flip', () => {
    const notices = runtimeChangeNoticesFor({ ...base, isYoloOnlyChange: true });
    expect(notices).toHaveLength(1);
    expect(notices[0].kind).toBe('yolo-mode-changed');
  });

  it('announces a provider swap with the provider-changed kind', () => {
    const notices = runtimeChangeNoticesFor({
      ...base,
      isYoloOnlyChange: false,
      isProviderSwap: true,
      newProvider: 'codex',
    });
    expect(notices).toHaveLength(1);
    expect(notices[0].kind).toBe('provider-changed');
  });

  it('announces a model change with the model-changed kind', () => {
    const notices = runtimeChangeNoticesFor({ ...base, isYoloOnlyChange: false });
    expect(notices.map((n) => n.kind)).toEqual(['model-changed']);
  });

  it('announces both when a queued model swap and yolo flip land together', () => {
    const notices = runtimeChangeNoticesFor({
      ...base,
      isYoloOnlyChange: false,
      yoloModeChanged: true,
    });
    expect(notices.map((n) => n.kind)).toEqual(['model-changed', 'yolo-mode-changed']);
  });
});

describe('announceRuntimeChange', () => {
  it('delivers to the CLI and records a transcript entry with its kind', async () => {
    const adapter = makeAdapter();
    const emitSystemNotice = vi.fn();

    await announceRuntimeChange({
      instance,
      adapter,
      text: '[System: YOLO mode enabled]',
      kind: 'yolo-mode-changed',
      emitSystemNotice,
    });

    // Both halves — this is the whole point of LT-015.
    expect(adapter.sendInput).toHaveBeenCalledWith('[System: YOLO mode enabled]');
    expect(emitSystemNotice).toHaveBeenCalledWith(
      instance,
      '[System: YOLO mode enabled]',
      { kind: 'yolo-mode-changed' },
    );
  });

  it('delivers before rendering, so a render failure cannot lose the delivery', async () => {
    const adapter = makeAdapter();
    const emitSystemNotice = vi.fn(() => {
      throw new Error('renderer detached');
    });

    await expect(
      announceRuntimeChange({
        instance,
        adapter,
        text: '[System: Model changed]',
        kind: 'model-changed',
        emitSystemNotice,
      }),
    ).resolves.toBeUndefined();

    expect(adapter.sendInput).toHaveBeenCalledTimes(1);
  });

  it('propagates a delivery failure — that one is not recoverable', async () => {
    const adapter = makeAdapter();
    adapter.sendInput.mockRejectedValue(new Error('adapter gone'));

    await expect(
      announceRuntimeChange({
        instance,
        adapter,
        text: '[System: Model changed]',
        kind: 'model-changed',
        emitSystemNotice: vi.fn(),
      }),
    ).rejects.toThrow('adapter gone');
  });
});

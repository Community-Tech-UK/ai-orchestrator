import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeChangeCostNote } from '../../../../shared/utils/runtime-change-cost';
import { RuntimeChangePreviewIpcService } from '../../core/services/ipc/runtime-change-preview-ipc.service';
import type { PendingSelection } from '../models/compact-model-picker.types';
import {
  RuntimeChangePreviewController,
  changeRequestOf,
  yoloChangeRequestOf,
  yoloCostKeyOf,
} from './runtime-change-preview.controller';

const note = (patch: Partial<RuntimeChangeCostNote> = {}): RuntimeChangeCostNote => ({
  kind: 'model', text: 'Switching model restarts this session.', resendTokens: 230_000,
  carriedTokens: null, droppedTokens: null, large: false, ...patch,
});

describe('changeRequestOf', () => {
  it('asks for a plain model change on the same provider', () => {
    const sel = { provider: 'codex', model: 'gpt-6-astra', reasoning: 'high' } as PendingSelection;
    expect(changeRequestOf(sel)).toEqual({ model: 'gpt-6-astra', reasoningEffort: 'high', modelRuntimeTarget: undefined, provider: 'codex' });
  });

  it('leaves the provider out for a local model and uses the target\'s own model id', () => {
    const target = { kind: 'local-model', source: 'local', endpointProvider: 'ollama', endpointId: 'e', modelId: 'llama', selectorId: 's' };
    const sel = { provider: 'local-model', model: 'selector', reasoning: null, modelRuntimeTarget: target } as unknown as PendingSelection;
    expect(changeRequestOf(sel)).toEqual({ model: 'llama', reasoningEffort: undefined, modelRuntimeTarget: target, provider: undefined });
    expect(changeRequestOf({ provider: 'local-model', model: 'x', reasoning: null } as PendingSelection).provider).toBeUndefined();
  });
});

describe('yoloChangeRequestOf', () => {
  it('previews the queued provider, model, effort and account that the toggle preserves', () => {
    const desiredRuntime = { provider: 'codex' as const, model: 'queued-model', reasoningEffort: 'high' as const, accountProfileId: 'account-2' };
    expect(yoloChangeRequestOf({ currentModel: 'live-model', desiredRuntime }, true))
      .toMatchObject({ ...desiredRuntime, yoloMode: true });
  });
  it('asks about the flip the toggle would make, on the session\'s current model', () => {
    expect(yoloChangeRequestOf({ currentModel: 'gpt-6-astra' }, false)).toEqual({ model: 'gpt-6-astra', yoloMode: false });
    expect(yoloChangeRequestOf({ currentModel: 'gpt-6-astra' }, true)).toEqual({ model: 'gpt-6-astra', yoloMode: true });
  });

  it('leaves the model out when the session has none yet', () => {
    expect(yoloChangeRequestOf({}, true)).toEqual({ yoloMode: true });
  });
});

describe('yoloCostKeyOf', () => {
  const base = { id: 'i1', provider: 'codex', currentModel: 'gpt-6-astra', yoloMode: false, status: 'idle', contextUsage: { used: 230_000 } };

  it('has nothing to ask about without a session', () => {
    expect(yoloCostKeyOf(undefined)).toBeNull();
    expect(yoloCostKeyOf(null)).toBeNull();
  });

  it('refreshes when a queued runtime change changes', () => {
    expect(yoloCostKeyOf({ ...base, desiredRuntime: { provider: 'codex', model: 'queued' } }))
      .not.toBe(yoloCostKeyOf(base));
  });

  it('stays the same while a reply streams in, and changes when something the sentence depends on does', () => {
    const key = yoloCostKeyOf(base);
    expect(yoloCostKeyOf({ ...base, contextUsage: { used: 232_000 } })).toBe(key);
    expect(yoloCostKeyOf({ ...base, contextUsage: { used: 241_000 } })).not.toBe(key);
    expect(yoloCostKeyOf({ ...base, yoloMode: true })).not.toBe(key);
    expect(yoloCostKeyOf({ ...base, pendingYoloMode: true })).not.toBe(key);
    expect(yoloCostKeyOf({ ...base, currentModel: 'gpt-6.1-sol' })).not.toBe(key);
    expect(yoloCostKeyOf({ ...base, status: 'busy' })).not.toBe(key);
    expect(yoloCostKeyOf({ ...base, status: 'waiting_for_input' })).toBe(yoloCostKeyOf({ ...base, status: 'busy' }));
  });
});

describe('RuntimeChangePreviewController', () => {
  const preview = vi.fn<(instanceId: string, request: unknown) => Promise<RuntimeChangeCostNote | null>>();
  let controller: RuntimeChangePreviewController;
  const sel = { provider: 'claude', model: 'claude-sonnet-4-6', reasoning: null } as PendingSelection;

  beforeEach(() => {
    vi.useFakeTimers();
    preview.mockReset();
    TestBed.configureTestingModule({
      providers: [RuntimeChangePreviewController, { provide: RuntimeChangePreviewIpcService, useValue: { preview } }],
    });
    controller = TestBed.inject(RuntimeChangePreviewController);
  });

  afterEach(() => vi.useRealTimers());

  describe('pointing at an option', () => {
    it('asks after a short pause and shows the sentence', async () => {
      preview.mockResolvedValue(note({ text: 'Switching model starts a new session.' }));
      controller.pointAt('i1', sel);
      expect(preview).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(150);
      expect(preview).toHaveBeenCalledWith('i1', { model: 'claude-sonnet-4-6', provider: 'claude' });
      expect(controller.optionNote()).toBe('Switching model starts a new session.');
    });

    it('does not ask about an option that is passed over quickly', async () => {
      preview.mockResolvedValue(note({ text: 'b' }));
      controller.pointAt('i1', { ...sel, model: 'a' } as PendingSelection);
      await vi.advanceTimersByTimeAsync(100);
      controller.pointAt('i1', { ...sel, model: 'b' } as PendingSelection);
      await vi.advanceTimersByTimeAsync(150);
      expect(preview).toHaveBeenCalledTimes(1);
      expect(preview).toHaveBeenCalledWith('i1', { model: 'b', provider: 'claude' });
    });

    it('ignores a late answer for an option that is no longer pointed at', async () => {
      let resolveFirst!: (value: RuntimeChangeCostNote | null) => void;
      preview.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));
      preview.mockResolvedValueOnce(note({ text: 'second' }));
      controller.pointAt('i1', { ...sel, model: 'a' } as PendingSelection);
      await vi.advanceTimersByTimeAsync(150);
      controller.pointAt('i1', { ...sel, model: 'b' } as PendingSelection);
      await vi.advanceTimersByTimeAsync(150);
      expect(controller.optionNote()).toBe('second');
      resolveFirst(note({ text: 'first' }));
      await vi.advanceTimersByTimeAsync(0);
      expect(controller.optionNote()).toBe('second');
    });

    it('clears when the pointer leaves or the picker closes', async () => {
      preview.mockResolvedValue(note({ text: 'something' }));
      controller.pointAt('i1', sel);
      await vi.advanceTimersByTimeAsync(150);
      controller.pointAt('i1', null);
      expect(controller.optionNote()).toBeNull();
      controller.pointAt('i1', sel);
      await vi.advanceTimersByTimeAsync(150);
      controller.clearPointer();
      expect(controller.optionNote()).toBeNull();
    });

    it('shows nothing when there is nothing to say', async () => {
      preview.mockResolvedValue(null);
      controller.pointAt('i1', sel);
      await vi.advanceTimersByTimeAsync(150);
      expect(controller.optionNote()).toBeNull();
    });
  });

  describe('before a change is made', () => {
    it('ignores an older preview that resolves after a newer choice', async () => {
      let resolveOld!: (value: RuntimeChangeCostNote | null) => void;
      preview.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
        .mockResolvedValueOnce(note({ large: true, text: 'new choice' }));
      const oldApply = vi.fn();
      const newApply = vi.fn();
      const old = controller.gate('i1', { model: 'old' }, oldApply);
      await controller.gate('i1', { model: 'new' }, newApply);
      resolveOld(note({ large: true, text: 'old choice' }));
      await old;
      expect(controller.pendingConfirmation()?.text).toBe('new choice');
      controller.confirm('i1');
      expect(oldApply).not.toHaveBeenCalled();
      expect(newApply).toHaveBeenCalledOnce();
    });

    it('withdraws an old confirmation as soon as a new no-change choice begins', async () => {
      let resolveNew!: (value: RuntimeChangeCostNote | null) => void;
      preview.mockResolvedValueOnce(note({ large: true }))
        .mockImplementationOnce(() => new Promise(resolve => { resolveNew = resolve; }));
      const oldApply = vi.fn();
      await controller.gate('i1', { model: 'old' }, oldApply);
      const next = controller.gate('i1', { model: 'current' }, vi.fn());
      expect(controller.pendingConfirmation()).toBeNull();
      resolveNew(null);
      await next;
      controller.confirm('i1');
      expect(oldApply).not.toHaveBeenCalled();
    });
    it('goes ahead at once when the sentence is small or missing', async () => {
      const apply = vi.fn();
      preview.mockResolvedValueOnce(note({ large: false }));
      await controller.gateSelection('i1', sel, apply);
      preview.mockResolvedValueOnce(null);
      await controller.gateSelection('i1', sel, apply);
      expect(apply).toHaveBeenCalledTimes(2);
      expect(controller.pendingConfirmation()).toBeNull();
    });

    it('holds a large re-read for a yes, then applies it once', async () => {
      const apply = vi.fn();
      preview.mockResolvedValue(note({ large: true, text: 'The next message will re-read about 230K tokens at full price.' }));
      await controller.gateSelection('i1', sel, apply);
      expect(apply).not.toHaveBeenCalled();
      expect(controller.pendingConfirmation()?.text).toContain('230K tokens');

      controller.confirm('i1');
      expect(apply).toHaveBeenCalledTimes(1);
      expect(controller.pendingConfirmation()).toBeNull();
      controller.confirm('i1');
      expect(apply).toHaveBeenCalledTimes(1);
    });

    it('holds a replay that would leave a large conversation behind, and says so in the question', async () => {
      const apply = vi.fn();
      const replay = note({
        kind: 'provider', resendTokens: null, carriedTokens: 8_600, droppedTokens: 221_400, large: true,
        text: 'Switching provider starts a new session with a short summary of this one (up to 8.6K of the 230K tokens here, 3% of Codex\'s 258K window); the rest does not carry over.',
      });
      preview.mockResolvedValue(replay);

      await controller.gateSelection('i1', { provider: 'codex', model: 'gpt-6-astra', reasoning: null } as PendingSelection, apply);

      expect(apply).not.toHaveBeenCalled();
      expect(controller.pendingConfirmation()?.text).toBe(replay.text);
      controller.confirm('i1');
      expect(apply).toHaveBeenCalledTimes(1);
    });

    it('asks about exactly the auto-approve flip the click would make, and holds it when it is large', async () => {
      const apply = vi.fn();
      preview.mockResolvedValue(note({ kind: 'auto-approve', resendTokens: null, droppedTokens: 150_000, large: true, text: 'Changing auto-approve starts a new session.' }));

      await controller.gate('i1', yoloChangeRequestOf({ currentModel: 'gemini-3-pro' }, false), apply);

      expect(preview).toHaveBeenCalledWith('i1', { model: 'gemini-3-pro', yoloMode: false });
      expect(apply).not.toHaveBeenCalled();
      expect(controller.pendingConfirmation()?.text).toBe('Changing auto-approve starts a new session.');
    });

    it('asks a model or provider switch with Switch anyway and Keep current', async () => {
      preview.mockResolvedValue(note({ large: true }));
      await controller.gateSelection('i1', sel, vi.fn());
      expect(controller.pendingConfirmation()).toMatchObject({ confirmLabel: 'Switch anyway', cancelLabel: 'Keep current' });
    });

    it('lets the caller name the two answers, so turning auto-approve off is not asked as a switch', async () => {
      preview.mockResolvedValue(note({ kind: 'auto-approve', large: true, text: 'Changing auto-approve starts a new session.' }));
      await controller.gate('i1', yoloChangeRequestOf({ currentModel: 'gemini-3-pro' }, false), vi.fn(),
        { confirm: 'Turn auto-approve off anyway', cancel: 'Keep auto-approve on' });
      expect(controller.pendingConfirmation()).toMatchObject({ confirmLabel: 'Turn auto-approve off anyway', cancelLabel: 'Keep auto-approve on' });
    });

    it('lets a newer large change replace the one being held, so a yes can only apply what is on screen', async () => {
      const first = vi.fn();
      const second = vi.fn();
      preview.mockResolvedValueOnce(note({ large: true, text: 'first' })).mockResolvedValueOnce(note({ large: true, text: 'second' }));

      await controller.gate('i1', { model: 'a' }, first);
      await controller.gate('i1', { model: 'b' }, second);
      controller.confirm('i1');

      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
    });

    it('goes ahead when the answer is unavailable, because the preview must never block the change', async () => {
      const apply = vi.fn();
      preview.mockResolvedValue(null);
      await controller.gate('i1', { yoloMode: true }, apply);
      expect(apply).toHaveBeenCalledTimes(1);
    });

    it('drops a held change on no', async () => {
      const apply = vi.fn();
      preview.mockResolvedValue(note({ large: true }));
      await controller.gate('i1', { yoloMode: true }, apply);
      controller.cancel();
      expect(controller.pendingConfirmation()).toBeNull();
      expect(apply).not.toHaveBeenCalled();
    });

    it('applies a held change only for the session it was previewed for', async () => {
      const apply = vi.fn();
      preview.mockResolvedValue(note({ large: true }));
      await controller.gateSelection('i1', sel, apply);
      controller.confirm('i2');
      expect(apply).not.toHaveBeenCalled();
      expect(controller.pendingConfirmation()).toBeNull();

      await controller.gateSelection('i1', sel, apply);
      controller.confirm('i1');
      expect(apply).toHaveBeenCalledTimes(1);
    });

    it('drops a held change when the bound session is replaced', async () => {
      const apply = vi.fn();
      preview.mockResolvedValue(note({ large: true }));
      await controller.gateSelection('i1', sel, apply);
      controller.invalidate();
      expect(controller.pendingConfirmation()).toBeNull();
      controller.confirm('i1');
      expect(apply).not.toHaveBeenCalled();
    });

    it('keeps a held change on the first bind of its session, and drops it when a replacement is bound', async () => {
      const apply = vi.fn();
      preview.mockResolvedValue(note({ large: true }));
      await controller.gateSelection('i1', sel, apply);
      controller.bind('i1');
      expect(controller.pendingConfirmation()).not.toBeNull();
      controller.bind('i2');
      expect(controller.pendingConfirmation()).toBeNull();
      controller.confirm('i2');
      expect(apply).not.toHaveBeenCalled();
    });

    it('never applies a preview that lands after the session was replaced or the owner was destroyed', async () => {
      let resolveLarge!: (value: RuntimeChangeCostNote | null) => void;
      let resolveSmall!: (value: RuntimeChangeCostNote | null) => void;
      preview
        .mockImplementationOnce(() => new Promise((resolve) => { resolveLarge = resolve; }))
        .mockImplementationOnce(() => new Promise((resolve) => { resolveSmall = resolve; }));
      const held = vi.fn();
      const direct = vi.fn();

      const largeGate = controller.gateSelection('i1', sel, held);
      controller.invalidate();
      resolveLarge(note({ large: true }));
      await largeGate;
      expect(held).not.toHaveBeenCalled();
      expect(controller.pendingConfirmation()).toBeNull();

      const directGate = controller.gateSelection('i1', sel, direct);
      controller.invalidate();
      resolveSmall(note({ large: false }));
      await directGate;
      expect(direct).not.toHaveBeenCalled();
    });

    it('can describe a single request as text', async () => {
      preview.mockResolvedValue(note({ text: 'hello' }));
      await expect(controller.describe('i1', { yoloMode: false })).resolves.toBe('hello');
      preview.mockResolvedValue(null);
      await expect(controller.describe('i1', { yoloMode: false })).resolves.toBeNull();
    });
  });
});

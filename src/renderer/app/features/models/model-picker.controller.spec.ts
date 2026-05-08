import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatStore } from '../../core/state/chat.store';
import type { ChatRecord } from '../../../../shared/types/chat.types';
import { ModelPickerController } from './model-picker.controller';

describe('ModelPickerController', () => {
  const chatStore = {
    setProvider: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    setReasoning: vi.fn(async () => undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        ModelPickerController,
        { provide: ChatStore, useValue: chatStore },
      ],
    });
  });

  function chatRecord(overrides: Partial<ChatRecord> = {}): ChatRecord {
    return {
      id: 'chat-1',
      name: 'Picker',
      provider: 'claude',
      model: 'sonnet',
      reasoningEffort: null,
      currentCwd: '/repo',
      projectId: null,
      yolo: false,
      ledgerThreadId: 'thread-1',
      currentInstanceId: null,
      createdAt: 1,
      lastActiveAt: 1,
      archivedAt: null,
      ...overrides,
    };
  }

  it('exposes provider-specific reasoning options for Claude and Codex', () => {
    const controller = TestBed.inject(ModelPickerController);
    controller.setMode('live-instance');
    controller.setChat(chatRecord({ provider: 'claude' }), false);
    TestBed.tick();
    expect(controller.reasoningOptions().map((o) => o.id)).toEqual([
      'default', 'low', 'medium', 'high', 'xhigh',
    ]);

    controller.setChat(chatRecord({ provider: 'codex' }), false);
    TestBed.tick();
    expect(controller.reasoningOptions().map((o) => o.id)).toEqual([
      'default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh',
    ]);
  });

  it('returns no reasoning options for providers that do not support reasoning', () => {
    const controller = TestBed.inject(ModelPickerController);
    controller.setMode('live-instance');
    controller.setChat(chatRecord({ provider: 'gemini' }), false);
    TestBed.tick();
    expect(controller.reasoningOptions()).toEqual([]);
  });

  describe('disabledReasonFor', () => {
    it('disables provider switch when chat has messages and provider already set', () => {
      const controller = TestBed.inject(ModelPickerController);
      controller.setMode('live-instance');
      controller.setChat(chatRecord({ provider: 'claude' }), true);

      expect(controller.disabledReasonFor({ provider: 'codex' })).toContain('before the first message');
    });

    it('allows provider switch when chat has no messages', () => {
      const controller = TestBed.inject(ModelPickerController);
      controller.setMode('live-instance');
      controller.setChat(chatRecord({ provider: 'claude' }), false);

      expect(controller.disabledReasonFor({ provider: 'codex' })).toBeUndefined();
    });

    it('rejects model commit when no provider is set', () => {
      const controller = TestBed.inject(ModelPickerController);
      controller.setMode('live-instance');
      controller.setChat(chatRecord({ provider: null }), false);

      expect(controller.disabledReasonFor({ modelId: 'sonnet' })).toBe('Pick a provider first');
    });

    it('rejects reasoning commit when no provider is set', () => {
      const controller = TestBed.inject(ModelPickerController);
      controller.setMode('live-instance');
      controller.setChat(chatRecord({ provider: null }), false);

      expect(controller.disabledReasonFor({ reasoning: 'high' })).toBe('Pick a provider first');
    });

    it('returns undefined for any target in pending-create mode', () => {
      const controller = TestBed.inject(ModelPickerController);
      controller.setMode('pending-create');
      controller.setSelection({ provider: 'claude', model: null, reasoning: null });

      expect(controller.disabledReasonFor({ provider: 'codex' })).toBeUndefined();
      expect(controller.disabledReasonFor({ modelId: 'sonnet' })).toBeUndefined();
      expect(controller.disabledReasonFor({ reasoning: 'high' })).toBeUndefined();
    });
  });

  describe('commitSelection in live-instance mode', () => {
    it('routes provider/model/reasoning through chatStore', async () => {
      const controller = TestBed.inject(ModelPickerController);
      controller.setMode('live-instance');
      controller.setChat(chatRecord({ provider: 'claude', model: 'sonnet', reasoningEffort: null }), false);

      await controller.commitSelection({ provider: 'codex', modelId: 'gpt-5.5', reasoning: 'high' });

      expect(chatStore.setProvider).toHaveBeenCalledWith('chat-1', 'codex');
      expect(chatStore.setModel).toHaveBeenCalledWith('chat-1', 'gpt-5.5');
      expect(chatStore.setReasoning).toHaveBeenCalledWith('chat-1', 'high');
    });

    it('model-only target does not call setProvider or setReasoning', async () => {
      const controller = TestBed.inject(ModelPickerController);
      controller.setMode('live-instance');
      controller.setChat(chatRecord({ provider: 'claude', model: 'sonnet' }), false);

      await controller.commitSelection({ modelId: 'opus' });

      expect(chatStore.setModel).toHaveBeenCalledWith('chat-1', 'opus');
      expect(chatStore.setProvider).not.toHaveBeenCalled();
      expect(chatStore.setReasoning).not.toHaveBeenCalled();
    });

    it('reasoning-only target does not call setProvider or setModel', async () => {
      const controller = TestBed.inject(ModelPickerController);
      controller.setMode('live-instance');
      controller.setChat(chatRecord({ provider: 'codex', reasoningEffort: null }), false);

      await controller.commitSelection({ reasoning: 'high' });

      expect(chatStore.setReasoning).toHaveBeenCalledWith('chat-1', 'high');
      expect(chatStore.setProvider).not.toHaveBeenCalled();
      expect(chatStore.setModel).not.toHaveBeenCalled();
    });

    it('skips chatStore calls when target field already matches the chat', async () => {
      const controller = TestBed.inject(ModelPickerController);
      controller.setMode('live-instance');
      controller.setChat(chatRecord({ provider: 'claude', model: 'sonnet' }), false);

      await controller.commitSelection({ provider: 'claude', modelId: 'sonnet' });

      expect(chatStore.setProvider).not.toHaveBeenCalled();
      expect(chatStore.setModel).not.toHaveBeenCalled();
    });

    it('refuses a disabled target without calling backend', async () => {
      const controller = TestBed.inject(ModelPickerController);
      controller.setMode('live-instance');
      controller.setChat(chatRecord({ provider: 'claude' }), true);

      const ok = await controller.commitSelection({ provider: 'codex' });

      expect(ok).toBe(false);
      expect(chatStore.setProvider).not.toHaveBeenCalled();
    });
  });

  describe('commitSelection in pending-create mode', () => {
    it('forwards merged selection via callback, no chatStore call', async () => {
      const controller = TestBed.inject(ModelPickerController);
      controller.setMode('pending-create');
      controller.setSelection({ provider: 'claude', model: null, reasoning: null });
      const emitted: { provider: string; model: string | null; reasoning: string | null }[] = [];
      controller.setSelectionChangeCallback((s) => emitted.push(s));

      await controller.commitSelection({ modelId: 'opus', reasoning: 'high' });

      expect(emitted).toEqual([{ provider: 'claude', model: 'opus', reasoning: 'high' }]);
      expect(chatStore.setModel).not.toHaveBeenCalled();
      expect(chatStore.setReasoning).not.toHaveBeenCalled();
    });

    it('partial target merges with current selection', async () => {
      const controller = TestBed.inject(ModelPickerController);
      controller.setMode('pending-create');
      controller.setSelection({ provider: 'codex', model: 'gpt-5.5', reasoning: 'medium' });
      const emitted: { provider: string; model: string | null; reasoning: string | null }[] = [];
      controller.setSelectionChangeCallback((s) => emitted.push(s));

      await controller.commitSelection({ reasoning: 'high' });

      expect(emitted).toEqual([{ provider: 'codex', model: 'gpt-5.5', reasoning: 'high' }]);
    });
  });

  it('mirror effect copies chat into rendering signals', () => {
    const controller = TestBed.inject(ModelPickerController);
    controller.setMode('live-instance');
    controller.setChat(chatRecord({ provider: 'codex', model: 'gpt-5.5', reasoningEffort: 'high' }), false);
    TestBed.tick();

    expect(controller.selectedProviderId()).toBe('codex');
    expect(controller.selectedModelId()).toBe('gpt-5.5');
    expect(controller.selectedReasoningEffort()).toBe('high');
  });

  it('mirror effect copies pending selection into rendering signals', () => {
    const controller = TestBed.inject(ModelPickerController);
    controller.setMode('pending-create');
    controller.setSelection({ provider: 'gemini', model: 'gemini-3-pro-preview', reasoning: null });
    TestBed.tick();

    expect(controller.selectedProviderId()).toBe('gemini');
    expect(controller.selectedModelId()).toBe('gemini-3-pro-preview');
    expect(controller.selectedReasoningEffort()).toBeNull();
  });
});

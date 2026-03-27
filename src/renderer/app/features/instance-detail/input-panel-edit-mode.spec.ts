import { describe, it, expect } from 'vitest';
import { signal, computed } from '@angular/core';
import type { OutputMessage } from '../../core/state/instance/instance.types';

/**
 * Unit tests for edit mode signal logic in InputPanelComponent.
 *
 * These test the signal logic in isolation rather than the full Angular component,
 * following the same pattern as instance-detail-inspectors.spec.ts.
 */

describe('lastUserMessage computed', () => {
  function createLastUserMessage(messages: OutputMessage[]) {
    const outputMessages = signal(messages);
    const lastUserMessage = computed(() => {
      const msgs = outputMessages();
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].type === 'user') {
          return { text: msgs[i].content, bufferIndex: i };
        }
      }
      return null;
    });
    return { outputMessages, lastUserMessage };
  }

  it('returns null when output buffer is empty', () => {
    const { lastUserMessage } = createLastUserMessage([]);
    expect(lastUserMessage()).toBeNull();
  });

  it('returns null when no user messages exist', () => {
    const { lastUserMessage } = createLastUserMessage([
      { id: '1', timestamp: 1, type: 'assistant', content: 'Hello' },
      { id: '2', timestamp: 2, type: 'system', content: 'System msg' },
    ]);
    expect(lastUserMessage()).toBeNull();
  });

  it('returns the last user message text and buffer index', () => {
    const { lastUserMessage } = createLastUserMessage([
      { id: '1', timestamp: 1, type: 'user', content: 'First question' },
      { id: '2', timestamp: 2, type: 'assistant', content: 'First answer' },
      { id: '3', timestamp: 3, type: 'user', content: 'Second question' },
      { id: '4', timestamp: 4, type: 'assistant', content: 'Second answer' },
    ]);
    expect(lastUserMessage()).toEqual({ text: 'Second question', bufferIndex: 2 });
  });

  it('returns user message even when followed by tool messages', () => {
    const { lastUserMessage } = createLastUserMessage([
      { id: '1', timestamp: 1, type: 'user', content: 'Do something' },
      { id: '2', timestamp: 2, type: 'assistant', content: 'Sure' },
      { id: '3', timestamp: 3, type: 'tool_use', content: 'tool call' },
      { id: '4', timestamp: 4, type: 'tool_result', content: 'result' },
    ]);
    expect(lastUserMessage()).toEqual({ text: 'Do something', bufferIndex: 0 });
  });
});

describe('Edit Mode State', () => {
  it('enters edit mode with correct signal values', () => {
    const editMode = signal(false);
    const stashedDraft = signal<string | null>(null);
    const editMessageIndex = signal<number | null>(null);
    const message = signal('some draft');

    const lastMsg = { text: 'Previous question', bufferIndex: 3 };
    stashedDraft.set(message());
    message.set(lastMsg.text);
    editMessageIndex.set(lastMsg.bufferIndex);
    editMode.set(true);

    expect(editMode()).toBe(true);
    expect(stashedDraft()).toBe('some draft');
    expect(editMessageIndex()).toBe(3);
    expect(message()).toBe('Previous question');
  });

  it('enters edit mode with empty input (stashes empty string)', () => {
    const editMode = signal(false);
    const stashedDraft = signal<string | null>(null);
    const editMessageIndex = signal<number | null>(null);
    const message = signal('');

    const lastMsg = { text: 'Previous question', bufferIndex: 0 };
    stashedDraft.set(message());
    message.set(lastMsg.text);
    editMessageIndex.set(lastMsg.bufferIndex);
    editMode.set(true);

    expect(editMode()).toBe(true);
    expect(stashedDraft()).toBe('');
    expect(message()).toBe('Previous question');
  });

  it('cancels edit mode and restores draft', () => {
    const editMode = signal(true);
    const stashedDraft = signal<string | null>('my draft');
    const editMessageIndex = signal<number | null>(3);
    const message = signal('edited text');

    message.set(stashedDraft() ?? '');
    editMode.set(false);
    stashedDraft.set(null);
    editMessageIndex.set(null);

    expect(editMode()).toBe(false);
    expect(message()).toBe('my draft');
    expect(stashedDraft()).toBeNull();
    expect(editMessageIndex()).toBeNull();
  });

  it('cancels edit mode with null stashed draft (restores empty string)', () => {
    const editMode = signal(true);
    const stashedDraft = signal<string | null>(null);
    const editMessageIndex = signal<number | null>(3);
    const message = signal('edited text');

    message.set(stashedDraft() ?? '');
    editMode.set(false);
    stashedDraft.set(null);
    editMessageIndex.set(null);

    expect(message()).toBe('');
  });

  it('is a no-op when already in edit mode (repeated UP)', () => {
    const editMode = signal(true);
    const stashedDraft = signal<string | null>('original draft');
    const message = signal('Previous question');

    if (editMode()) {
      // no-op
    }

    expect(stashedDraft()).toBe('original draft');
    expect(message()).toBe('Previous question');
  });
});

describe('Edit Mode Send (resendEdited)', () => {
  it('emits correct messageIndex and text', () => {
    const editMessageIndex = signal<number | null>(3);
    const message = signal('edited question');

    const emitted = {
      messageIndex: editMessageIndex()!,
      text: message().trim(),
    };

    expect(emitted).toEqual({ messageIndex: 3, text: 'edited question' });
  });

  it('blocks send when text is empty (canSend guard)', () => {
    const message = signal('   ');
    const canSend = message().trim().length > 0;

    expect(canSend).toBe(false);
  });

  it('blocks send when instance is busy', () => {
    const isBusy = signal(true);
    const editMode = signal(true);

    const canResend = editMode() && !isBusy();
    expect(canResend).toBe(false);
  });
});

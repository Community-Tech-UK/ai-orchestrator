import { describe, it, expect } from 'vitest';
import { signal } from '@angular/core';
import type { OutputMessage } from '../../core/state/instance/instance.types';

/**
 * Unit tests for OutputStreamComponent's inline edit-in-place logic.
 *
 * The pencil button now edits a user prompt in place (in the transcript)
 * rather than loading it into the composer. On resend the component resolves
 * the message's *in-memory* buffer index by id and emits `resendEdited`, which
 * the parent's onResendEdited forks at. Resolving by id (not the display
 * item's bufferIndex, which carries a history offset) keeps the index in the
 * same space InstanceDetailComponent.onResendEdited expects — mirroring the
 * composer's lastUserMessage computed.
 *
 * These mirror the component's logic in isolation, matching the convention of
 * input-panel-edit-mode.spec.ts and instance-detail-edit-resend.spec.ts.
 */

interface ResendEvent {
  messageIndex: number;
  messageId?: string;
  text: string;
  attachments?: OutputMessage['attachments'];
  retryMode: 'transcript-only';
}

/** Mirrors OutputStreamComponent.resendEditedMessage(). */
function resendEditedMessage(
  messages: OutputMessage[],
  editingMessageId: ReturnType<typeof signal<string | null>>,
  editingDraft: ReturnType<typeof signal<string>>,
  emit: (event: ResendEvent) => void,
): void {
  const messageId = editingMessageId();
  if (messageId === null) return;

  const text = editingDraft();
  if (!text.trim()) return;

  const index = messages.findIndex((m) => m.id === messageId);
  if (index === -1) {
    editingMessageId.set(null);
    editingDraft.set('');
    return;
  }

  emit({
    messageIndex: index,
    messageId,
    text,
    attachments: messages[index].attachments,
    retryMode: 'transcript-only',
  });

  editingMessageId.set(null);
  editingDraft.set('');
}

const buffer: OutputMessage[] = [
  { id: 'u1', timestamp: 1, type: 'user', content: 'First question' },
  { id: 'a1', timestamp: 2, type: 'assistant', content: 'First answer' },
  { id: 'u2', timestamp: 3, type: 'user', content: 'Second question' },
  { id: 'a2', timestamp: 4, type: 'assistant', content: 'Second answer' },
];

describe('OutputStreamComponent inline edit resend', () => {
  it('resolves the in-memory buffer index by message id', () => {
    const editingMessageId = signal<string | null>('u2');
    const editingDraft = signal('Second question, revised');
    const emitted: ResendEvent[] = [];

    resendEditedMessage(buffer, editingMessageId, editingDraft, (e) => emitted.push(e));

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      messageIndex: 2,
      messageId: 'u2',
      text: 'Second question, revised',
      retryMode: 'transcript-only',
    });
  });

  it('preserves edited text exactly (no trimming of the payload)', () => {
    const editingMessageId = signal<string | null>('u1');
    const editingDraft = signal('  padded edit  ');
    const emitted: ResendEvent[] = [];

    resendEditedMessage(buffer, editingMessageId, editingDraft, (e) => emitted.push(e));

    expect(emitted[0].text).toBe('  padded edit  ');
    expect(emitted[0].messageIndex).toBe(0);
  });

  it('forwards the original message attachments', () => {
    const withAttachment: OutputMessage[] = [
      {
        id: 'u1',
        timestamp: 1,
        type: 'user',
        content: 'See file',
        attachments: [{ name: 'a.png', type: 'image/png', size: 10, data: 'data:...' }],
      },
    ];
    const editingMessageId = signal<string | null>('u1');
    const editingDraft = signal('See this file');
    const emitted: ResendEvent[] = [];

    resendEditedMessage(withAttachment, editingMessageId, editingDraft, (e) => emitted.push(e));

    expect(emitted[0].attachments).toEqual([
      { name: 'a.png', type: 'image/png', size: 10, data: 'data:...' },
    ]);
  });

  it('is a no-op when the draft is whitespace only', () => {
    const editingMessageId = signal<string | null>('u2');
    const editingDraft = signal('   ');
    const emitted: ResendEvent[] = [];

    resendEditedMessage(buffer, editingMessageId, editingDraft, (e) => emitted.push(e));

    expect(emitted).toHaveLength(0);
    // State is left intact so the editor stays open for the user to fix.
    expect(editingMessageId()).toBe('u2');
  });

  it('cancels (clears state, no emit) when the edited message is gone from the buffer', () => {
    const editingMessageId = signal<string | null>('missing');
    const editingDraft = signal('orphaned edit');
    const emitted: ResendEvent[] = [];

    resendEditedMessage(buffer, editingMessageId, editingDraft, (e) => emitted.push(e));

    expect(emitted).toHaveLength(0);
    expect(editingMessageId()).toBeNull();
    expect(editingDraft()).toBe('');
  });

  it('clears edit state after a successful resend', () => {
    const editingMessageId = signal<string | null>('u2');
    const editingDraft = signal('done');

    resendEditedMessage(buffer, editingMessageId, editingDraft, () => undefined);

    expect(editingMessageId()).toBeNull();
    expect(editingDraft()).toBe('');
  });
});

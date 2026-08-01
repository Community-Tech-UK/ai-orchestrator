import { describe, it, expect, vi } from 'vitest';
import type { OutputMessage } from '../../core/state/instance.store';
import { InlineEditController, type InlineEditResendEvent } from './output-stream-inline-edit-controller';

/**
 * Exercises the real InlineEditController extracted from OutputStreamComponent
 * for WS-C10 (freed LOC headroom; see check:ts-max-loc). The resend-payload
 * shape itself is already covered end to end by output-stream-inline-edit.spec.ts's
 * mirrored logic; this spec focuses on the parts unique to owning real state:
 * editing-mode gating, the loop-originated guard, and keyboard shortcuts.
 */

const buffer: OutputMessage[] = [
  { id: 'u1', timestamp: 1, type: 'user', content: 'First question' },
  { id: 'a1', timestamp: 2, type: 'assistant', content: 'First answer' },
  { id: 'u2', timestamp: 3, type: 'user', content: 'Second question' },
];

function makeController(overrides: {
  isLoopOriginatedUserMessage?: (message: OutputMessage) => boolean;
  getMessages?: () => OutputMessage[];
  emitResend?: (event: InlineEditResendEvent) => void;
} = {}) {
  const emitted: InlineEditResendEvent[] = [];
  const controller = new InlineEditController({
    getViewportElement: () => null,
    isLoopOriginatedUserMessage: overrides.isLoopOriginatedUserMessage ?? (() => false),
    getMessages: overrides.getMessages ?? (() => buffer),
    emitResend: overrides.emitResend ?? ((event) => emitted.push(event)),
  });
  return { controller, emitted };
}

describe('InlineEditController', () => {
  it('starts closed, with no message being edited', () => {
    const { controller } = makeController();
    expect(controller.editingMessageId()).toBeNull();
    expect(controller.isEditingMessage('u1')).toBe(false);
  });

  it('startEditingMessage() opens the editor seeded with the message content', () => {
    const { controller } = makeController();
    controller.startEditingMessage(buffer[0]);
    expect(controller.editingMessageId()).toBe('u1');
    expect(controller.editingDraft()).toBe('First question');
    expect(controller.isEditingMessage('u1')).toBe(true);
    expect(controller.isEditingMessage('u2')).toBe(false);
  });

  it('startEditingMessage() is a no-op for a loop-originated message', () => {
    const { controller } = makeController({ isLoopOriginatedUserMessage: () => true });
    controller.startEditingMessage(buffer[0]);
    expect(controller.editingMessageId()).toBeNull();
  });

  it('cancelEditingMessage() clears state without emitting', () => {
    const { controller, emitted } = makeController();
    controller.startEditingMessage(buffer[0]);
    controller.cancelEditingMessage();
    expect(controller.editingMessageId()).toBeNull();
    expect(controller.editingDraft()).toBe('');
    expect(emitted).toHaveLength(0);
  });

  it('onEditKeydown(Enter) resends; onEditKeydown(Escape) cancels', () => {
    const { controller, emitted } = makeController();
    controller.startEditingMessage(buffer[2]); // u2
    controller.editingDraft.set('Second question, revised');

    const enterEvent = { key: 'Enter', shiftKey: false, preventDefault: vi.fn() } as unknown as KeyboardEvent;
    controller.onEditKeydown(enterEvent);
    expect(enterEvent.preventDefault).toHaveBeenCalled();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ messageIndex: 2, messageId: 'u2', text: 'Second question, revised' });
    expect(controller.editingMessageId()).toBeNull();

    controller.startEditingMessage(buffer[0]);
    const escapeEvent = { key: 'Escape', preventDefault: vi.fn() } as unknown as KeyboardEvent;
    controller.onEditKeydown(escapeEvent);
    expect(escapeEvent.preventDefault).toHaveBeenCalled();
    expect(controller.editingMessageId()).toBeNull();
    expect(emitted).toHaveLength(1); // no second emit from Escape
  });

  it('Shift+Enter does not resend (lets the textarea insert a newline)', () => {
    const { controller, emitted } = makeController();
    controller.startEditingMessage(buffer[0]);
    const event = { key: 'Enter', shiftKey: true, preventDefault: vi.fn() } as unknown as KeyboardEvent;
    controller.onEditKeydown(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
    expect(controller.editingMessageId()).toBe('u1'); // editor stays open
  });

  it('onEditDraftInput() updates the draft from the textarea value', () => {
    const { controller } = makeController();
    controller.startEditingMessage(buffer[0]);
    const textarea = document.createElement('textarea');
    textarea.value = 'edited text';
    controller.onEditDraftInput({ target: textarea } as unknown as Event);
    expect(controller.editingDraft()).toBe('edited text');
  });

  it('reset() closes the editor — used on instance switch', () => {
    const { controller } = makeController();
    controller.startEditingMessage(buffer[0]);
    controller.reset();
    expect(controller.editingMessageId()).toBeNull();
    expect(controller.editingDraft()).toBe('');
  });

  it('resendEditedMessage() cancels (no emit) when the edited message has left the buffer', () => {
    const { controller, emitted } = makeController({ getMessages: () => [] });
    controller.startEditingMessage(buffer[0]);
    controller.resendEditedMessage();
    expect(emitted).toHaveLength(0);
    expect(controller.editingMessageId()).toBeNull();
  });
});

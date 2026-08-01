import { signal } from '@angular/core';
import type { OutputMessage } from '../../core/state/instance.store';

export interface InlineEditResendEvent {
  messageIndex: number;
  messageId?: string;
  text: string;
  attachments?: OutputMessage['attachments'];
  retryMode: 'transcript-only';
}

export interface InlineEditControllerDeps {
  getViewportElement: () => HTMLElement | null;
  isLoopOriginatedUserMessage: (message: OutputMessage) => boolean;
  getMessages: () => OutputMessage[];
  emitResend: (event: InlineEditResendEvent) => void;
}

/**
 * Extracted from OutputStreamComponent to free LOC headroom for WS-C10
 * (see `check:ts-max-loc`). Owns edit-in-place state for the pencil-button
 * "edit and resend" flow: swap a user bubble for an inline textarea, then
 * resolve the *in-memory* buffer index by message id on resend — the index
 * space InstanceDetailComponent.onResendEdited expects (mirrors the
 * composer's lastUserMessage computed; see output-stream-inline-edit.spec.ts).
 */
export class InlineEditController {
  readonly editingMessageId = signal<string | null>(null);
  readonly editingDraft = signal('');

  constructor(private readonly deps: InlineEditControllerDeps) {}

  isEditingMessage(messageId: string): boolean {
    return this.editingMessageId() === messageId;
  }

  startEditingMessage(message: OutputMessage): void {
    if (this.deps.isLoopOriginatedUserMessage(message)) return;
    this.editingMessageId.set(message.id);
    this.editingDraft.set(message.content);
    this.focusEditTextarea(message.content);
  }

  onEditDraftInput(event: Event): void {
    const textarea = event.target as HTMLTextAreaElement;
    this.editingDraft.set(textarea.value);
    this.autosizeEditTextarea(textarea);
  }

  onEditKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.resendEditedMessage();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelEditingMessage();
    }
  }

  cancelEditingMessage(): void {
    this.editingMessageId.set(null);
    this.editingDraft.set('');
  }

  resendEditedMessage(): void {
    const messageId = this.editingMessageId();
    if (messageId === null) return;

    const text = this.editingDraft();
    if (!text.trim()) return;

    const msgs = this.deps.getMessages();
    const index = msgs.findIndex((m) => m.id === messageId);
    if (index === -1) {
      this.cancelEditingMessage();
      return;
    }

    this.deps.emitResend({
      messageIndex: index,
      messageId,
      text,
      attachments: msgs[index].attachments,
      retryMode: 'transcript-only',
    });

    this.editingMessageId.set(null);
    this.editingDraft.set('');
  }

  /** Closes any open editor — used when the parent switches instances. */
  reset(): void {
    this.editingMessageId.set(null);
    this.editingDraft.set('');
  }

  private focusEditTextarea(content: string): void {
    requestAnimationFrame(() => {
      const textarea = this.deps.getViewportElement()?.querySelector<HTMLTextAreaElement>(
        '.inline-edit-textarea',
      );
      if (!textarea) return;
      textarea.focus();
      textarea.selectionStart = content.length;
      textarea.selectionEnd = content.length;
      this.autosizeEditTextarea(textarea);
    });
  }

  private autosizeEditTextarea(textarea: HTMLTextAreaElement): void {
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }
}

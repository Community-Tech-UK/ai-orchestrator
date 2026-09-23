import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import type { OutputMessage } from '../../core/state/instance/instance.types';
import { InstanceStore } from '../../core/state/instance/instance.store';
import { isReadyForInputStatus, isTerminalStatus } from '../../core/state/instance/instance-messaging-queue-utils';
import {
  asyncAnswerDelivery,
  asyncQuestionSubagent,
  formatAsyncAnswer,
  parseAsyncQuestions,
  type AsyncAnswerTarget,
} from './async-question';

/** Radio value for the free-text choice; option labels are prose, so no clash. */
const OTHER = '__aio_async_other__';

/**
 * Answer controls under a Codex async question: one radio group per question
 * (the recommended option preselected, as Codex specifies), an "Other" free-text
 * choice, and a send button. The reply goes the way the host's own composer
 * sends: the instance store (a busy session queues it rather than interrupting
 * Codex) or, for chats, the chat service via AsyncAnswerTarget.
 */
@Component({
  selector: 'app-async-question-answers',
  standalone: true,
  template: `
    @if (questions().length > 0 && live() && replaced()) {
      <p class="aq aq__status" role="status">This session was replaced by an edit. Answer in the new session.</p>
    } @else if (questions().length > 0 && live()) {
      <form class="aq" (submit)="$event.preventDefault(); send()">
        @for (question of questions(); track $index; let q = $index) {
          <fieldset class="aq__question" [disabled]="locked()">
            @if (questions().length > 1) {
              <legend class="aq__legend">{{ question.title }}</legend>
            } @else {
              <legend class="aq__legend aq__legend--hidden">{{ question.title }}</legend>
            }
            @if (question.options.length > 0) {
              <div class="aq__options">
                @for (option of question.options; track $index) {
                  <label class="aq__option" [class.selected]="choice(q) === option">
                    <input
                      type="radio"
                      [name]="groupName(q)"
                      [value]="option"
                      [checked]="choice(q) === option"
                      (change)="choose(q, option)" />
                    <span>{{ option }}</span>
                  </label>
                }
                <label class="aq__option" [class.selected]="choice(q) === other">
                  <input
                    type="radio"
                    [name]="groupName(q)"
                    [value]="other"
                    [checked]="choice(q) === other"
                    (change)="choose(q, other)" />
                  <span>Other</span>
                </label>
              </div>
            }
            @if (question.options.length === 0 || choice(q) === other) {
              <input
                class="aq__text"
                type="text"
                [attr.aria-label]="'Your answer to: ' + question.title"
                placeholder="Type your answer"
                [value]="otherText(q)"
                (input)="setOtherText(q, $any($event.target).value)" />
            }
          </fieldset>
        }
        <div class="aq__footer">
          @if (locked()) {
            <span class="aq__status" role="status">{{ statusLabel() }}</span>
          } @else {
            <button class="aq__send" type="submit" [disabled]="!canSend()">
              {{ questions().length > 1 ? 'Send answers' : 'Send answer' }}
            </button>
            @if (notDelivered()) {
              <span class="aq__status aq__status--warn" role="status">
                Not sent. See the error shown and try again.
              </span>
            }
          }
        </div>
      </form>
    }
  `,
  styles: [`
    .aq {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid rgba(148, 163, 184, 0.16);
    }

    .aq__question {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin: 0;
      padding: 0;
      border: none;
      min-width: 0;
    }

    .aq__legend {
      padding: 0;
      margin-bottom: 4px;
      color: var(--text-primary);
      font-size: 13px;
      font-weight: 600;
    }

    .aq__legend--hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
    }

    .aq__options {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .aq__option {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 12px;
      border: 1px solid rgba(148, 163, 184, 0.28);
      border-radius: 999px;
      color: var(--text-secondary);
      font-size: 13px;
      cursor: pointer;
      transition: background var(--transition-fast), border-color var(--transition-fast);
    }

    .aq__option input {
      margin: 0;
      accent-color: rgb(96, 165, 250);
    }

    .aq__option.selected {
      border-color: rgba(96, 165, 250, 0.7);
      background: rgba(96, 165, 250, 0.12);
      color: var(--text-primary);
    }

    .aq__option:focus-within {
      outline: 2px solid rgba(96, 165, 250, 0.8);
      outline-offset: 2px;
    }

    fieldset:disabled .aq__option {
      cursor: default;
      opacity: 0.6;
    }

    .aq__text {
      width: min(100%, 520px);
      padding: 6px 10px;
      border: 1px solid rgba(148, 163, 184, 0.28);
      border-radius: 8px;
      background: rgba(15, 23, 42, 0.6);
      color: var(--text-primary);
      font: inherit;
      font-size: 13px;
    }

    .aq__footer {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .aq__send {
      padding: 6px 14px;
      border: 1px solid rgba(96, 165, 250, 0.6);
      border-radius: 8px;
      background: rgba(96, 165, 250, 0.18);
      color: var(--text-primary);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }

    .aq__send:disabled {
      opacity: 0.5;
      cursor: default;
    }

    .aq__status {
      color: var(--text-muted);
      font-size: 12px;
    }

    .aq__status--warn {
      color: rgb(251, 191, 36);
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AsyncQuestionAnswersComponent {
  private readonly store = inject(InstanceStore);

  readonly message = input.required<OutputMessage>();
  readonly instanceId = input.required<string>();
  readonly transcript = input.required<OutputMessage[]>();
  /** Set by hosts whose transcript id is not the live instance id; see AsyncAnswerTarget. */
  readonly target = input<AsyncAnswerTarget | null>(null);
  private readonly liveInstanceId = computed(() => this.target()?.instanceId ?? this.instanceId());

  protected readonly other = OTHER;
  protected readonly questions = computed(() => parseAsyncQuestions(this.message()));
  private readonly subagent = computed(() => asyncQuestionSubagent(this.message()));

  private readonly choices = signal<Record<number, string>>({});
  private readonly otherTexts = signal<Record<number, string>>({});
  /**
   * Set once this reply has been sent or seen queued, and never cleared. It
   * keeps the controls locked through the moment a queued reply has left the
   * queue but is not yet echoed into the transcript, when no evidence exists.
   */
  private readonly inFlight = signal(false);
  private readonly awaitingSend = signal(false);

  private readonly queuedMessages = computed(() =>
    this.store.getMessageQueue(this.liveInstanceId()).map((queued) => queued.message));
  /**
   * Judged from the transcript and queue, never from the click: sendInput
   * reports refusals (terminal session, failed wake, failed dispatch) in the
   * transcript rather than by throwing, so a click alone proves nothing.
   */
  private readonly delivery = computed(() =>
    asyncAnswerDelivery(this.message(), this.questions(), this.transcript(), this.queuedMessages()));
  private readonly instanceStatus = computed(() => this.store.getInstance(this.liveInstanceId())?.status);
  /**
   * Controls only make sense for a live session. A read-only history preview
   * renders the same transcript under a synthetic id that no store send can
   * reach, so there the question stays plain text.
   */
  protected readonly live = computed(() => this.store.getInstance(this.liveInstanceId()) !== undefined);
  /**
   * An edit-and-resend replaced this session. Its transcript and status stop
   * moving while a send would be redirected to the replacement, so no evidence
   * could ever confirm the reply here; offering Send would invite duplicates.
   */
  protected readonly replaced = computed(() => !!this.store.getInstance(this.liveInstanceId())?.supersededBy);

  /** Sent or queued before, now nowhere, and the session is back at a prompt or has ended. */
  protected readonly notDelivered = computed(() => {
    if (!this.inFlight() || this.awaitingSend() || this.delivery() !== null) return false;
    const status = this.instanceStatus();
    return isReadyForInputStatus(status) || isTerminalStatus(status);
  });
  protected readonly locked = computed(() =>
    this.delivery() !== null || (this.inFlight() && !this.notDelivered()));

  protected readonly statusLabel = computed(() => {
    switch (this.delivery()) {
      case 'queued': return 'Answer queued. Codex gets it when its current turn ends.';
      // The echo proves the reply reached the conversation, not the CLI; a
      // dispatch failure after it shows its own error, as for a typed message.
      case 'sent': return 'Answered. Your reply is in the conversation below.';
      default: return 'Sending…';
    }
  });

  constructor() {
    effect(() => {
      if (this.delivery() !== null) untracked(() => this.inFlight.set(true));
    });
  }

  private readonly answers = computed(() => this.questions().map((question, index) => {
    const picked = this.choice(index);
    return question.options.length === 0 || picked === OTHER ? this.otherText(index).trim() : picked;
  }));

  protected readonly canSend = computed(() => this.answers().every((answer) => answer !== ''));

  /** The chosen option, defaulting to the first (recommended) one. */
  protected choice(index: number): string {
    const picked = this.choices()[index];
    if (picked !== undefined) return picked;
    return this.questions()[index]?.options[0] ?? OTHER;
  }

  protected otherText(index: number): string {
    return this.otherTexts()[index] ?? '';
  }

  protected groupName(index: number): string {
    return `aq-${this.message().id}-${index}`;
  }

  protected choose(index: number, value: string): void {
    this.choices.update((current) => ({ ...current, [index]: value }));
  }

  protected setOtherText(index: number, value: string): void {
    this.otherTexts.update((current) => ({ ...current, [index]: value }));
  }

  protected async send(): Promise<void> {
    if (this.locked() || !this.live() || this.replaced() || !this.canSend()) return;
    const text = formatAsyncAnswer(this.questions(), this.answers(), this.subagent());
    this.inFlight.set(true);
    this.awaitingSend.set(true);
    try {
      const target = this.target();
      await (target ? target.send(text) : this.store.sendInput(this.liveInstanceId(), text));
    } finally {
      this.awaitingSend.set(false);
    }
  }
}

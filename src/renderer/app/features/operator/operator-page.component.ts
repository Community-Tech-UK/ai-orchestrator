import { CommonModule } from '@angular/common';
import {
  AfterViewChecked,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  inject,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import type { ConversationMessageRecord } from '../../../../shared/types/conversation-ledger.types';
import { OperatorStore } from '../../core/state/operator.store';

@Component({
  selector: 'app-operator-page',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="operator-page">
      <header class="operator-header">
        <div class="operator-title-block">
          <button class="icon-button" type="button" aria-label="Back to projects" title="Back to projects" (click)="goBack()">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M9.8 3.2 5 8l4.8 4.8 1-1L7 8l3.8-3.8-1-1Z" />
            </svg>
          </button>
          <div>
            <p class="eyebrow">Global Control Plane</p>
            <h1>Orchestrator</h1>
          </div>
        </div>
        <button class="ghost-button" type="button" (click)="refresh()" [disabled]="store.loading() || store.sending()">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M13.2 5.2A5.5 5.5 0 1 0 13 11h-1.7a4 4 0 1 1 .4-4.7H9.5V4.8H14v4.5h-1.5V6.4c.3.5.5 1 .7 1.6h1.5a5.5 5.5 0 0 0-1.5-2.8Z" />
          </svg>
          <span>Refresh</span>
        </button>
      </header>

      <main class="operator-shell">
        <section class="transcript-panel" aria-label="Operator conversation">
          @if (store.loading() && store.messages().length === 0) {
            <div class="empty-state">Loading transcript...</div>
          } @else if (store.messages().length === 0) {
            <div class="empty-state">No operator messages yet.</div>
          } @else {
            <div class="message-list" #messageList>
              @for (message of store.messages(); track message.id) {
                <article class="message" [class.user]="message.role === 'user'" [class.operator]="message.role !== 'user'">
                  <div class="message-meta">
                    <span>{{ messageLabel(message) }}</span>
                    <time [attr.datetime]="message.createdAt">{{ formatTime(message.createdAt) }}</time>
                  </div>
                  <p>{{ message.content }}</p>
                </article>
              }
            </div>
          }
        </section>

        <aside class="operator-side" aria-label="Operator status">
          <section class="side-section">
            <div class="side-heading">
              <span>Runs</span>
              <strong>{{ store.runs().length }}</strong>
            </div>
            @if (store.runs().length === 0) {
              <p class="side-empty">No active runs.</p>
            }
          </section>
          <section class="side-section">
            <div class="side-heading">
              <span>Projects</span>
              <strong>{{ store.projects().length }}</strong>
            </div>
            @if (store.projects().length === 0) {
              <p class="side-empty">No linked projects.</p>
            }
          </section>
        </aside>
      </main>

      @if (store.error()) {
        <p class="error-row">{{ store.error() }}</p>
      }

      <form class="composer" (ngSubmit)="submit()">
        <textarea
          name="operatorPrompt"
          rows="3"
          placeholder="Tell the Orchestrator what to coordinate..."
          [(ngModel)]="draft"
          [disabled]="store.sending()"
          (keydown)="onComposerKeydown($event)"
        ></textarea>
        <button class="send-button" type="submit" [disabled]="!canSend()">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M14.5 1.8 1.5 7.2c-.7.3-.7 1.3.1 1.5l4.5 1.1 1.1 4.5c.2.8 1.2.9 1.5.1l5.5-13c.2-.4-.2-.8-.7-.6ZM3.4 8l8.5-3.5-5.2 5.2L3.4 8Zm4.6 4.6-.8-2.9 5.2-5.2L8 12.6Z" />
          </svg>
          <span>{{ store.sending() ? 'Sending' : 'Send' }}</span>
        </button>
      </form>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      min-height: 100vh;
      background: var(--bg-primary);
      color: var(--text-primary);
    }

    .operator-page {
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr auto auto;
    }

    .operator-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 18px 24px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      background: rgba(12, 18, 17, 0.84);
      backdrop-filter: blur(18px);
    }

    .operator-title-block {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }

    .eyebrow {
      margin: 0 0 4px;
      font-family: var(--font-mono);
      font-size: 10px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--text-muted);
    }

    h1 {
      margin: 0;
      font-size: 20px;
      font-weight: 650;
      letter-spacing: 0;
    }

    .icon-button,
    .ghost-button,
    .send-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(255, 255, 255, 0.035);
      color: var(--text-primary);
      cursor: pointer;
      transition: background var(--transition-fast), border-color var(--transition-fast), opacity var(--transition-fast);
    }

    .icon-button {
      width: 34px;
      height: 34px;
      padding: 0;
      border-radius: 8px;
    }

    .ghost-button {
      height: 34px;
      padding: 0 12px;
      border-radius: 8px;
      font-size: 12px;
    }

    .icon-button:hover,
    .ghost-button:hover,
    .send-button:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.07);
      border-color: rgba(255, 255, 255, 0.14);
    }

    .icon-button svg,
    .ghost-button svg,
    .send-button svg {
      width: 15px;
      height: 15px;
      fill: currentColor;
      flex: 0 0 auto;
    }

    .operator-shell {
      min-height: 0;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 280px;
      gap: 0;
    }

    .transcript-panel {
      min-height: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border-right: 1px solid rgba(255, 255, 255, 0.06);
    }

    .message-list {
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .message {
      max-width: min(820px, 82%);
      padding: 12px 14px;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.07);
      background: rgba(255, 255, 255, 0.035);
    }

    .message.user {
      align-self: flex-end;
      background: rgba(var(--primary-rgb), 0.1);
      border-color: rgba(var(--primary-rgb), 0.2);
    }

    .message.operator {
      align-self: flex-start;
    }

    .message-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 6px;
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--text-muted);
      text-transform: uppercase;
    }

    .message p {
      margin: 0;
      color: var(--text-primary);
      font-size: 14px;
      line-height: 1.5;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .operator-side {
      min-height: 0;
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      background: rgba(255, 255, 255, 0.015);
    }

    .side-section {
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 8px;
      padding: 12px;
      background: rgba(255, 255, 255, 0.025);
    }

    .side-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      font-size: 12px;
      color: var(--text-secondary);
    }

    .side-heading strong {
      font-family: var(--font-mono);
      color: var(--text-primary);
    }

    .side-empty,
    .empty-state,
    .error-row {
      color: var(--text-muted);
      font-size: 13px;
    }

    .side-empty {
      margin: 10px 0 0;
    }

    .empty-state {
      margin: auto;
      padding: 24px;
    }

    .error-row {
      margin: 0;
      padding: 10px 24px;
      color: var(--error-color);
      border-top: 1px solid rgba(var(--error-rgb), 0.18);
      background: rgba(var(--error-rgb), 0.08);
    }

    .composer {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      padding: 16px 24px 20px;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
      background: rgba(12, 18, 17, 0.92);
    }

    textarea {
      width: 100%;
      min-width: 0;
      resize: vertical;
      max-height: 180px;
      padding: 12px;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.09);
      background: rgba(255, 255, 255, 0.035);
      color: var(--text-primary);
      font: inherit;
      line-height: 1.45;
    }

    textarea:focus {
      outline: none;
      border-color: rgba(var(--primary-rgb), 0.42);
      box-shadow: 0 0 0 3px rgba(var(--primary-rgb), 0.12);
    }

    .send-button {
      align-self: stretch;
      min-width: 104px;
      padding: 0 16px;
      border-radius: 8px;
      font-weight: 600;
    }

    .ghost-button:disabled,
    .send-button:disabled,
    textarea:disabled {
      opacity: 0.55;
      cursor: default;
    }

    @media (max-width: 900px) {
      .operator-shell {
        grid-template-columns: 1fr;
      }

      .operator-side {
        display: none;
      }

      .transcript-panel {
        border-right: none;
      }

      .composer {
        grid-template-columns: 1fr;
      }

      .send-button {
        height: 42px;
      }
    }
  `],
})
export class OperatorPageComponent implements AfterViewChecked {
  protected readonly store = inject(OperatorStore);
  private router = inject(Router);
  private shouldScrollToBottom = false;

  @ViewChild('messageList') private messageList?: ElementRef<HTMLElement>;

  draft = '';

  constructor() {
    void this.store.initialize().then(() => {
      this.shouldScrollToBottom = true;
    });
  }

  ngAfterViewChecked(): void {
    if (!this.shouldScrollToBottom || !this.messageList) {
      return;
    }
    const element = this.messageList.nativeElement;
    element.scrollTop = element.scrollHeight;
    this.shouldScrollToBottom = false;
  }

  protected goBack(): void {
    void this.router.navigate(['/']);
  }

  protected async refresh(): Promise<void> {
    await this.store.refresh();
    this.shouldScrollToBottom = true;
  }

  protected canSend(): boolean {
    return this.draft.trim().length > 0 && !this.store.sending();
  }

  protected async submit(): Promise<void> {
    const text = this.draft.trim();
    if (!text) {
      return;
    }
    const sent = await this.store.sendMessage(text);
    if (sent) {
      this.draft = '';
      this.shouldScrollToBottom = true;
    }
  }

  protected onComposerKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    event.preventDefault();
    void this.submit();
  }

  protected messageLabel(message: ConversationMessageRecord): string {
    return message.role === 'user' ? 'You' : 'Orchestrator';
  }

  protected formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  }
}

import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { OperatorStore } from '../../core/state/operator.store';

@Component({
  selector: 'app-operator-page',
  standalone: true,
  imports: [DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="operator-page">
      <header class="operator-header">
        <div>
          <p class="operator-kicker">Global control plane</p>
          <h1>Orchestrator</h1>
        </div>
        <div class="operator-status" [class.loading]="store.loading() || store.sending()">
          {{ store.sending() ? 'Sending' : store.loading() ? 'Loading' : 'Ready' }}
        </div>
      </header>

      @if (visibleProjects().length > 0) {
        <div class="operator-targets">
          @for (project of visibleProjects(); track project.id) {
            <button type="button" class="operator-target-chip" [title]="project.canonicalPath">
              {{ project.displayName }}
            </button>
          }
        </div>
      }

      @if (store.runs().length > 0) {
        <div class="operator-runs">
          @for (run of store.runs(); track run.id) {
            <article class="operator-run">
              <div class="operator-run-main">
                <span>{{ run.title }}</span>
                <strong>{{ run.status }}</strong>
              </div>
              <div class="operator-run-actions">
                @if (canCancelRun(run.status)) {
                  <button type="button" class="operator-run-button" (click)="cancelRun(run.id)">
                    Cancel
                  </button>
                }
                @if (canRetryRun(run.status)) {
                  <button type="button" class="operator-run-button" (click)="retryRun(run.id)">
                    Retry
                  </button>
                }
              </div>
            </article>
          }
        </div>
      }

      <div class="operator-transcript" aria-live="polite">
        @if (store.error(); as error) {
          <div class="operator-error" role="alert">{{ error }}</div>
        }

        @if (store.messages().length === 0 && !store.loading()) {
          <div class="operator-empty">
            <span>No messages yet</span>
          </div>
        }

        @for (message of store.messages(); track message.id) {
          <article class="operator-message" [class.user]="message.role === 'user'">
            <div class="operator-message-meta">
              <span>{{ labelForRole(message.role) }}</span>
              <time [attr.datetime]="dateTimeFor(message.createdAt)">
                {{ message.createdAt | date:'shortTime' }}
              </time>
            </div>
            <p>{{ message.content }}</p>
          </article>
        }
      </div>

      <form class="operator-composer" (submit)="send($event)">
        <textarea
          [value]="draft()"
          (input)="onDraftInput($event)"
          rows="3"
          placeholder="Message Orchestrator"
          aria-label="Message Orchestrator"
        ></textarea>
        <button type="submit" [disabled]="!canSend()">
          Send
        </button>
      </form>
    </section>
  `,
  styles: [`
    :host {
      display: flex;
      flex: 1;
      min-width: 0;
      min-height: 0;
    }

    .operator-page {
      flex: 1;
      min-width: 0;
      min-height: 0;
      display: grid;
      grid-template-rows: auto auto auto 1fr auto;
      gap: 18px;
      max-width: 1100px;
      width: 100%;
      color: var(--text-primary);
    }

    .operator-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 4px 2px 0;
    }

    .operator-kicker {
      margin: 0 0 4px;
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-size: 11px;
      text-transform: uppercase;
    }

    h1 {
      margin: 0;
      font-size: 28px;
      font-weight: 650;
      letter-spacing: 0;
    }

    .operator-status {
      border: 1px solid var(--glass-strong);
      border-radius: 999px;
      padding: 7px 12px;
      color: var(--text-secondary);
      background: var(--glass-light);
      font-family: var(--font-mono);
      font-size: 11px;
      text-transform: uppercase;
    }

    .operator-status.loading {
      color: var(--text-primary);
      border-color: rgba(var(--primary-rgb), 0.3);
      background: rgba(var(--primary-rgb), 0.12);
    }

    .operator-targets {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      min-width: 0;
    }

    .operator-target-chip {
      max-width: 210px;
      height: 30px;
      border: 1px solid var(--glass-border);
      border-radius: 8px;
      padding: 0 10px;
      color: var(--text-secondary);
      background: var(--glass-light);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font: inherit;
      font-size: 12px;
    }

    .operator-runs {
      display: grid;
      gap: 8px;
    }

    .operator-run {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-width: 0;
      border: 1px solid var(--glass-border);
      border-radius: 8px;
      padding: 10px 12px;
      background: var(--glass-light);
      color: var(--text-secondary);
    }

    .operator-run-main {
      display: grid;
      gap: 4px;
      min-width: 0;
    }

    .operator-run-main span {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .operator-run-main strong {
      color: var(--text-primary);
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 650;
      text-transform: uppercase;
    }

    .operator-run-actions {
      display: flex;
      flex: 0 0 auto;
      gap: 8px;
    }

    .operator-run-button {
      min-width: 0;
      height: 30px;
      padding: 0 10px;
      border-color: var(--glass-strong);
      background: var(--bg-primary);
      color: var(--text-secondary);
      font-size: 12px;
      font-weight: 600;
    }

    .operator-transcript {
      min-height: 0;
      overflow: auto;
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 4px 2px;
    }

    .operator-empty,
    .operator-error,
    .operator-message {
      border: 1px solid var(--glass-border);
      border-radius: 8px;
      background: var(--glass-light);
    }

    .operator-empty {
      display: grid;
      place-items: center;
      min-height: 220px;
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-size: 12px;
      text-transform: uppercase;
    }

    .operator-error {
      padding: 12px 14px;
      color: var(--danger-color, #ff6b6b);
      background: rgba(255, 107, 107, 0.08);
    }

    .operator-message {
      padding: 14px 16px;
      max-width: min(760px, 100%);
      color: var(--text-primary);
    }

    .operator-message.user {
      align-self: flex-end;
      border-color: rgba(var(--primary-rgb), 0.3);
      background: rgba(var(--primary-rgb), 0.12);
    }

    .operator-message-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 8px;
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-size: 11px;
      text-transform: uppercase;
    }

    .operator-message p {
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      line-height: 1.5;
    }

    .operator-composer {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 12px;
      align-items: end;
      padding: 14px;
      border: 1px solid var(--glass-border);
      border-radius: 8px;
      background: var(--glass-light);
    }

    textarea {
      width: 100%;
      min-height: 76px;
      max-height: 180px;
      resize: vertical;
      border: 1px solid var(--glass-strong);
      border-radius: 8px;
      padding: 12px;
      color: var(--text-primary);
      background: var(--bg-primary);
      font: inherit;
      line-height: 1.4;
    }

    textarea:focus {
      outline: none;
      border-color: rgba(var(--primary-rgb), 0.45);
      box-shadow: 0 0 0 3px rgba(var(--primary-rgb), 0.12);
    }

    button {
      min-width: 82px;
      height: 42px;
      border: 1px solid rgba(var(--primary-rgb), 0.35);
      border-radius: 8px;
      color: var(--text-primary);
      background: rgba(var(--primary-rgb), 0.16);
      font-weight: 650;
    }

    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    @media (max-width: 720px) {
      .operator-composer {
        grid-template-columns: 1fr;
      }

      button {
        width: 100%;
      }
    }
  `],
})
export class OperatorPageComponent implements OnInit {
  protected readonly store = inject(OperatorStore);
  protected readonly draft = signal('');

  ngOnInit(): void {
    void this.store.initialize();
  }

  protected onDraftInput(event: Event): void {
    const target = event.target;
    this.draft.set(target instanceof HTMLTextAreaElement ? target.value : '');
  }

  protected canSend(): boolean {
    return this.draft().trim().length > 0 && !this.store.sending();
  }

  protected send(event: Event): void {
    event.preventDefault();
    const text = this.draft().trim();
    if (!text || this.store.sending()) {
      return;
    }
    this.draft.set('');
    void this.store.sendMessage(text);
  }

  protected cancelRun(runId: string): void {
    void this.store.cancelRun(runId);
  }

  protected retryRun(runId: string): void {
    void this.store.retryRun(runId);
  }

  protected canCancelRun(status: string): boolean {
    return status === 'queued' || status === 'running' || status === 'waiting';
  }

  protected canRetryRun(status: string): boolean {
    return status === 'blocked' || status === 'failed' || status === 'cancelled';
  }

  protected visibleProjects() {
    return this.store.projects().slice(0, 8);
  }

  protected labelForRole(role: string): string {
    if (role === 'user') return 'You';
    if (role === 'assistant') return 'Orchestrator';
    return role;
  }

  protected dateTimeFor(timestamp: number): string {
    return new Date(timestamp).toISOString();
  }
}

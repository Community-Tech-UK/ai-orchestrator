import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  inject,
  input,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { GatewayClient } from '../../core/gateway-client.service';
import type { MobileMessageDto } from '../../core/models';

/**
 * Read-only transcript of a persisted (closed/archived) session, fetched from
 * the gateway's history store. No composer — closed sessions aren't resumable
 * from the phone; to continue work, start a new session in the project.
 */
@Component({
  standalone: true,
  selector: 'app-history-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="screen">
      <header class="top">
        <button class="back" (click)="back()">‹</button>
        <span class="info">
          <span class="name">Past session</span>
          <span class="sub">read-only</span>
        </span>
      </header>

      <div class="transcript">
        @if (loading()) {
          <p class="muted">Loading…</p>
        } @else if (error()) {
          <p class="error">{{ error() }}</p>
        } @else {
          @for (m of messages(); track m.id) {
            <div class="msg" [class]="m.type">
              @if (m.type !== 'user') {
                <span class="role">{{ roleLabel(m.type) }}</span>
              }
              <span class="content">{{ m.content }}</span>
            </div>
          }
          @if (messages().length === 0) {
            <p class="muted">This session has no recorded messages.</p>
          }
        }
      </div>
    </section>
  `,
  styles: [
    `
      .screen { display: flex; flex-direction: column; height: 100%; }
      .top { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,0.08); }
      .back { background: none; border: none; color: var(--accent-action); font-size: 26px; line-height: 1; }
      .info { display: flex; flex-direction: column; min-width: 0; }
      .name { font-size: 17px; font-weight: 600; }
      .sub { font-size: 13px; color: var(--text-secondary); }
      .transcript { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
      .msg { display: flex; flex-direction: column; gap: 4px; max-width: 85%; }
      .msg.user { align-self: flex-end; align-items: flex-end; }
      .msg .role { font-size: 11px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.04em; }
      .msg .content {
        white-space: pre-wrap; word-break: break-word; font-size: 15px; line-height: 1.45;
        background: var(--surface); padding: 10px 12px; border-radius: 12px;
      }
      .msg.user .content { background: var(--accent-action); color: #fff; }
      .msg.error .content { background: rgba(255,69,58,0.15); color: var(--accent-error); }
      .muted { color: var(--text-secondary); text-align: center; margin-top: 40px; }
      .error { color: var(--accent-error); text-align: center; margin-top: 40px; }
    `,
  ],
})
export class HistoryDetailComponent implements OnInit {
  private readonly gateway = inject(GatewayClient);
  private readonly router = inject(Router);

  /** Chat id from the route. */
  readonly chatId = input<string>('');

  protected readonly messages = signal<MobileMessageDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    try {
      const messages = await this.gateway.historyMessages(this.chatId());
      this.messages.set(messages);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.loading.set(false);
    }
  }

  protected roleLabel(type: MobileMessageDto['type']): string {
    switch (type) {
      case 'assistant':
        return 'assistant';
      case 'tool_use':
        return 'tool';
      case 'tool_result':
        return 'tool';
      case 'error':
        return 'error';
      default:
        return 'system';
    }
  }

  protected back(): void {
    void this.router.navigate(['/history']);
  }
}

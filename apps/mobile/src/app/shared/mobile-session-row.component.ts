import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { MobileIconComponent } from './mobile-icon.component';

export interface MobileSessionRowView {
  id: string;
  title: string;
  subtitle?: string;
  statusLabel: string;
  tone: 'working' | 'attention' | 'error' | 'loop' | 'idle' | 'history';
  unread: boolean;
  live: boolean;
  lastActivity: number;
}

export function mobileSessionRowAriaLabel(row: MobileSessionRowView): string {
  return `Open ${row.title}, ${row.statusLabel}${row.unread ? ', unread completion' : ''}`;
}

@Component({
  standalone: true,
  selector: 'app-mobile-session-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MobileIconComponent],
  template: `
    <button
      type="button"
      class="session-row"
      [class]="'session-row session-row--' + row().tone"
      [class.session-row--nested]="nested()"
      [attr.aria-label]="ariaLabel()"
      (click)="activate.emit(row().id)"
    >
      <span class="session-row__copy">
        <span class="session-row__heading">
          <span class="session-row__title">{{ row().title }}</span>
          @if (row().unread) {
            <span class="session-row__unread" aria-hidden="true"></span>
          }
        </span>
        <span class="session-row__subtitle">{{ row().statusLabel }} · {{ activity() }}</span>
        @if (showSubtitle() && row().subtitle) {
          <span class="session-row__subtitle">{{ row().subtitle }}</span>
        }
      </span>
      <span class="session-row__state" [attr.aria-label]="row().statusLabel">
        @switch (row().tone) {
          @case ('working') {
            <span class="session-row__spinner" aria-hidden="true"></span>
          }
          @case ('attention') {
            <app-mobile-icon name="warning" />
          }
          @case ('error') {
            <app-mobile-icon name="error" />
          }
          @case ('loop') {
            <span class="session-row__loop" aria-hidden="true"></span>
          }
          @default {
            <span class="session-row__label">{{ row().statusLabel }}</span>
          }
        }
      </span>
    </button>
  `,
  styles: [
    `
      :host {
        display: block;
      }

      .session-row {
        display: flex;
        width: 100%;
        min-height: 54px;
        align-items: center;
        gap: var(--space-3, 12px);
        border: 0;
        border-radius: var(--radius-md, 12px);
        background: transparent;
        color: var(--text);
        padding: var(--space-2, 8px) 0;
        text-align: start;
        touch-action: manipulation;
      }

      .session-row--nested { padding-inline-start: var(--space-9, 36px); }

      .session-row:active {
        background: rgba(255, 255, 255, 0.055);
      }

      .session-row__copy {
        display: flex;
        min-width: 0;
        flex: 1;
        flex-direction: column;
        gap: 2px;
      }

      .session-row__title {
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        min-width: 0;
        flex: 1;
        overflow: hidden;
        font-size: var(--font-size-base, 17px);
        line-height: 1.3;
        overflow-wrap: anywhere;
      }

      .session-row__heading { display: flex; align-items: flex-start; gap: var(--space-2, 8px); }

      .session-row__subtitle,
      .session-row__label {
        overflow: hidden;
        color: var(--text-secondary);
        font-size: var(--font-size-sm, 13px);
        text-overflow: ellipsis;
        text-transform: capitalize;
        white-space: nowrap;
      }

      .session-row__state {
        display: grid;
        min-width: var(--control-size, 44px);
        min-height: var(--control-size, 44px);
        place-items: center;
        color: var(--text-secondary);
        font-size: 20px;
      }

      .session-row--attention .session-row__state {
        color: var(--accent-attention);
      }

      .session-row--error .session-row__state {
        color: var(--accent-error);
      }

      .session-row__unread {
        display: inline-block;
        margin-top: 7px;
        width: 7px;
        height: 7px;
        flex: none;
        border-radius: var(--radius-pill);
        background: var(--accent-action);
      }

      .session-row__spinner,
      .session-row__loop {
        width: 19px;
        height: 19px;
        border: 3px solid rgba(255, 255, 255, 0.18);
        border-top-color: var(--text-secondary);
        border-radius: 50%;
        animation: session-row-spin 850ms linear infinite;
      }

      .session-row__loop {
        border-color: rgba(167, 139, 250, 0.25);
        border-top-color: #a78bfa;
      }

      @keyframes session-row-spin {
        to {
          transform: rotate(360deg);
        }
      }
    `,
  ],
})
export class MobileSessionRowComponent {
  readonly row = input.required<MobileSessionRowView>();
  readonly nested = input(false);
  readonly showSubtitle = input(true);
  readonly activate = output<string>();
  protected readonly activity = computed(() => relativeSessionActivity(this.row().lastActivity));
  protected readonly ariaLabel = computed(() => mobileSessionRowAriaLabel(this.row()));
}

export function relativeSessionActivity(timestamp: number, now = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'No activity recorded';
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { FailedImageRef } from '../../../../../shared/types/instance.types';

@Component({
  selector: 'app-failed-image-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="failed-image-card">
      <div class="failed-image-header">
        <span class="failed-image-badge">{{ failure().kind }}</span>
        <span class="failed-image-reason">{{ formatReason(failure().reason) }}</span>
      </div>
      <div class="failed-image-src" [title]="failure().src">{{ failure().src }}</div>
      <div class="failed-image-message">{{ failure().message }}</div>
    </div>
  `,
  styles: [`
    .failed-image-card {
      margin-top: 8px;
      padding: 10px 12px;
      border: 1px solid rgba(214, 94, 60, 0.35);
      border-radius: 10px;
      background: rgba(214, 94, 60, 0.08);
      color: var(--text-secondary, #6b7280);
    }

    .failed-image-header {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-bottom: 6px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }

    .failed-image-badge {
      padding: 2px 6px;
      border-radius: 999px;
      background: rgba(214, 94, 60, 0.16);
      color: var(--text-primary, #111827);
      font-weight: 600;
    }

    .failed-image-reason {
      font-weight: 600;
      color: var(--text-primary, #111827);
    }

    .failed-image-src {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
      color: var(--text-primary, #111827);
      margin-bottom: 4px;
    }

    .failed-image-message {
      font-size: 12px;
      line-height: 1.4;
    }
  `],
})
export class FailedImageCardComponent {
  readonly failure = input.required<FailedImageRef>();

  formatReason(reason: FailedImageRef['reason']): string {
    return reason.replace(/_/g, ' ');
  }
}

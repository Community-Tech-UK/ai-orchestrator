import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, output, signal } from '@angular/core';
import type { PauseDetectorEvent } from '@contracts/schemas/pause';
import { PauseIpcService } from '../../core/services/ipc/pause-ipc.service';

@Component({
  selector: 'app-pause-detector-events-dialog',
  standalone: true,
  imports: [DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="dialog-backdrop" role="presentation">
      <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="detector-events-title">
        <div class="dialog-header">
          <h2 id="detector-events-title">Recent Detector Events</h2>
          <button type="button" class="icon-btn" aria-label="Close" title="Close" (click)="closeRequested.emit()">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4.3 3.2 8 6.9l3.7-3.7 1.1 1.1L9.1 8l3.7 3.7-1.1 1.1L8 9.1l-3.7 3.7-1.1-1.1L6.9 8 3.2 4.3l1.1-1.1Z" />
            </svg>
          </button>
        </div>

        @if (loading()) {
          <p class="muted">Loading detector events...</p>
        } @else if (events().length === 0) {
          <p class="muted">No detector events recorded.</p>
        } @else {
          <div class="events-list">
            @for (event of events(); track event.at) {
              <article class="event-row">
                <div class="event-top">
                  <span class="event-decision">{{ event.decision }}</span>
                  <time>{{ event.at | date:'mediumTime' }}</time>
                </div>
                <div class="event-meta">
                  @if (event.matchedPattern) {
                    <span>Pattern: {{ event.matchedPattern }}</span>
                  }
                  @if (event.interfacesAdded.length > 0) {
                    <span>Added: {{ event.interfacesAdded.join(', ') }}</span>
                  }
                  @if (event.interfacesRemoved.length > 0) {
                    <span>Removed: {{ event.interfacesRemoved.join(', ') }}</span>
                  }
                  @if (event.note) {
                    <span>{{ event.note }}</span>
                  }
                </div>
              </article>
            }
          </div>
        }
      </section>
    </div>
  `,
  styles: [`
    .dialog-backdrop {
      position: fixed;
      inset: 0;
      z-index: 5200;
      display: grid;
      place-items: center;
      padding: 1rem;
      background: rgba(0, 0, 0, 0.48);
    }

    .dialog {
      width: min(620px, 100%);
      max-height: min(680px, calc(100vh - 2rem));
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      border: 1px solid var(--border-color, #333);
      border-radius: 8px;
      background: var(--bg-primary, #111);
      color: var(--text-primary, #e5e5e5);
      padding: 1rem;
      box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
    }

    .dialog-header,
    .event-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
    }

    h2 {
      margin: 0;
      font-size: 1rem;
    }

    .icon-btn {
      width: 28px;
      height: 28px;
      display: grid;
      place-items: center;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: var(--text-primary, #e5e5e5);
      cursor: pointer;
    }

    .icon-btn:hover {
      background: rgba(255, 255, 255, 0.08);
    }

    svg {
      width: 15px;
      height: 15px;
      fill: currentColor;
    }

    .muted {
      margin: 0;
      color: var(--text-muted, #888);
      font-size: 0.875rem;
    }

    .events-list {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      overflow: auto;
    }

    .event-row {
      border: 1px solid var(--border-color, #333);
      border-radius: 8px;
      padding: 0.75rem;
      background: var(--bg-secondary, #1e1e1e);
    }

    .event-decision {
      font-size: 0.78rem;
      font-weight: 700;
      text-transform: uppercase;
    }

    time,
    .event-meta {
      color: var(--text-secondary, #cbd5e1);
      font-size: 0.78rem;
    }

    .event-meta {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      margin-top: 0.45rem;
    }
  `],
})
export class PauseDetectorEventsDialogComponent implements OnInit {
  private readonly ipc = inject(PauseIpcService);

  readonly closeRequested = output<void>();
  protected readonly loading = signal(true);
  protected readonly events = signal<PauseDetectorEvent[]>([]);

  async ngOnInit(): Promise<void> {
    try {
      const response = await this.ipc.pauseDetectorRecentEvents();
      this.events.set(response.success && response.data ? response.data.events : []);
    } finally {
      this.loading.set(false);
    }
  }
}

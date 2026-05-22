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
  styleUrl: './pause-detector-events-dialog.component.scss',
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

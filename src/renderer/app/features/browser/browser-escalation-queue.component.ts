import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { BrowserUnattendedStore } from './browser-unattended.store';

@Component({
  selector: 'app-browser-escalation-queue',
  standalone: true,
  imports: [],
  templateUrl: './browser-escalation-queue.component.html',
  styleUrl: './browser-escalation-queue.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrowserEscalationQueueComponent implements OnInit {
  private readonly store = inject(BrowserUnattendedStore);

  readonly escalations = this.store.pendingEscalations;
  readonly busy = this.store.busy;
  readonly errorMessage = this.store.errorMessage;

  private readonly noteDrafts = signal<Record<string, string>>({});

  ngOnInit(): void {
    void this.store.refreshEscalations();
  }

  noteDraft(escalationId: string): string {
    return this.noteDrafts()[escalationId] ?? '';
  }

  onNoteInput(escalationId: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.noteDrafts.update((current) => ({ ...current, [escalationId]: value }));
  }

  async resolve(escalationId: string): Promise<void> {
    const note = this.noteDraft(escalationId).trim();
    await this.store.resolveEscalation(escalationId, note || undefined);
    this.clearNoteDraft(escalationId);
  }

  async skip(escalationId: string): Promise<void> {
    const note = this.noteDraft(escalationId).trim();
    await this.store.skipEscalation(escalationId, note || undefined);
    this.clearNoteDraft(escalationId);
  }

  formatAge(createdAt: number): string {
    const elapsedMs = Math.max(0, Date.now() - createdAt);
    if (elapsedMs < 60_000) {
      return 'now';
    }
    const elapsedMinutes = Math.floor(elapsedMs / 60_000);
    if (elapsedMinutes < 60) {
      return `${elapsedMinutes}m`;
    }
    const elapsedHours = Math.floor(elapsedMinutes / 60);
    if (elapsedHours < 24) {
      return `${elapsedHours}h`;
    }
    const elapsedDays = Math.floor(elapsedHours / 24);
    return `${elapsedDays}d`;
  }

  private clearNoteDraft(escalationId: string): void {
    this.noteDrafts.update((current) => {
      const next = { ...current };
      delete next[escalationId];
      return next;
    });
  }
}

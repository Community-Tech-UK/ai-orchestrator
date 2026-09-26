import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, signal, untracked } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router } from '@angular/router';
import type { MobileAutomationDto, MobileAutomationScheduleDto } from '../../core/models';
import { MobileHeaderComponent } from '../../shared/mobile-header.component';
import { MobileIconComponent } from '../../shared/mobile-icon.component';
import { MobileSheetComponent } from '../../shared/mobile-sheet.component';
import { AutomationStore } from './automation.store';

@Component({
  standalone: true,
  selector: 'app-automations',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, MobileHeaderComponent, MobileIconComponent, MobileSheetComponent],
  templateUrl: './automations.component.html',
  styleUrl: './automations.component.scss',
})
export class AutomationsComponent {
  protected readonly automation = inject(AutomationStore);
  private readonly router = inject(Router);
  protected readonly confirming = signal<MobileAutomationDto | null>(null);
  private readonly confirmingHostId = signal<string | null>(null);

  constructor() {
    effect(() => {
      const item = this.confirming();
      if (!item) return;
      if (this.confirmingHostId() !== this.automation.hostId()) {
        untracked(() => this.dismissRun());
        return;
      }
      // A failed or pending list is not evidence that an automation was removed.
      if (!this.automation.hasCurrentList()) return;
      const current = this.automation.automations().find(candidate => candidate.id === item.id);
      if (!current?.enabled) {
        untracked(() => this.dismissRun());
      } else if (current !== item) {
        // A reconnect refresh deserializes new objects for the same host/id.
        // Rebind the selection without cancelling its uncertain run intent.
        untracked(() => this.confirming.set(current));
      }
    });
    inject(DestroyRef).onDestroy(() => this.automation.cancelRun());
  }

  protected dismissRun(): void {
    this.confirming.set(null);
    this.confirmingHostId.set(null);
    this.automation.cancelRun();
  }

  protected beginRun(item: MobileAutomationDto): void {
    if (this.confirming()?.id !== item.id) this.automation.cancelRun();
    this.confirmingHostId.set(this.automation.hostId());
    this.confirming.set(item);
  }

  protected back(): void { void this.router.navigate(['/projects']); }

  protected scheduleLabel(schedule: MobileAutomationScheduleDto): string {
    if (schedule.type === 'oneTime') return 'One time';
    return `${schedule.expression} · ${schedule.timezone}`;
  }

  protected statusLabel(status: NonNullable<MobileAutomationDto['lastRun']>['status'] | undefined): string {
    if (!status) return 'Never run';
    return status[0].toUpperCase() + status.slice(1);
  }

  protected async confirmRun(): Promise<void> {
    const item = this.confirming();
    const hostId = this.confirmingHostId();
    if (!item || hostId !== this.automation.hostId()) return;
    const completed = await this.automation.runNow(item);
    if (completed && this.confirmingHostId() === hostId && this.confirming()?.id === item.id) {
      this.confirming.set(null);
      this.confirmingHostId.set(null);
      void this.automation.refresh();
    }
  }
}

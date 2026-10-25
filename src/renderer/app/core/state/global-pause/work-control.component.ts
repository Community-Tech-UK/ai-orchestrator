import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { GlobalPauseStore } from './global-pause.store';
import { WorkloadSliderComponent } from './workload-slider.component';
import { InstanceStateService } from '../instance/instance-state.service';
import { GlobalPauseIpcService, type GlobalPauseCommand } from '../../services/ipc/global-pause-ipc.service';
import { workControlLabel } from './global-pause-presentation';
import { SettingsStore } from '../settings.store';
import { WORKLOAD_COPY, type WorkloadLevel } from '../../../../../shared/copy/workload-copy';

@Component({
  selector: 'app-work-control',
  standalone: true,
  imports: [WorkloadSliderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './work-control.component.html',
  styleUrl: './work-control.component.scss',
  host: { '(document:keydown.escape)': 'close()', '(document:click)': 'outsideClick($event)' },
})
export class WorkControlComponent {
  protected readonly store = inject(GlobalPauseStore);
  private readonly ipc = inject(GlobalPauseIpcService);
  private readonly instances = inject(InstanceStateService);
  private readonly settings = inject(SettingsStore);
  private readonly element = inject(ElementRef<HTMLElement>);
  private readonly details = viewChild<ElementRef<HTMLDetailsElement>>('details');
  protected readonly confirmDiscard = signal(false);
  protected readonly pending = signal(false);
  protected readonly quitError = signal<string | null>(null);
  protected readonly runningCount = computed(() => [...this.instances.state().instances.values()]
    .filter(instance => instance.status === 'busy').length);
  protected readonly label = computed(() => this.store.state().phase === 'none' && (this.settings.get('workloadLevel') ?? 3) !== 3
    ? `Work · ${WORKLOAD_COPY[(this.settings.get('workloadLevel') ?? 3) as WorkloadLevel].name}`
    : workControlLabel(this.store.state(), this.store.state().entries
    .filter(entry => entry.kind === 'session' && entry.state !== 'void' && entry.state !== 'resumed'
      && !this.instances.state().instances.has(entry.targetId)).length));

  constructor() { void this.store.initialize(); }

  protected async act(command: GlobalPauseCommand, payload?: unknown): Promise<void> {
    if (this.pending() && command !== 'skip-notes') return;
    this.pending.set(true);
    try { await this.store.command(command, payload); }
    finally { this.pending.set(false); this.confirmDiscard.set(false); }
  }

  protected async quit(): Promise<void> {
    try {
      const result = await this.ipc.quit();
      if (!result.success) this.quitError.set('Could not quit Harness. Use the app menu to quit.');
    } catch { this.quitError.set('Could not quit Harness. Use the app menu to quit.'); }
  }

  protected close(): void {
    const details = this.details()?.nativeElement;
    if (details?.open) {
      details.open = false;
      details.querySelector('summary')?.focus();
    }
    this.confirmDiscard.set(false);
  }

  protected outsideClick(event: MouseEvent): void {
    if (event.target instanceof Node && !this.element.nativeElement.contains(event.target)) {
      const details = this.details()?.nativeElement;
      if (details) details.open = false;
      this.confirmDiscard.set(false);
    }
  }
}

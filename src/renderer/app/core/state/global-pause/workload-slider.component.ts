import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { SettingsStore } from '../settings.store';
import { WORKLOAD_COPY, WORKLOAD_CONSEQUENCE, type WorkloadLevel } from '../../../../../shared/copy/workload-copy';

@Component({
  selector: 'app-workload-slider',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div data-setting-key="workloadLevel">
      <label [attr.for]="controlId()">Workload: {{ copy().name }}</label>
      <div class="scale"><span>Less</span><span>More</span></div>
      <input type="range" min="1" max="5" step="1" [id]="controlId()"
        [value]="level()" [attr.aria-valuetext]="copy().name"
        [attr.aria-describedby]="controlId() + '-detail ' + controlId() + '-consequence'"
        (change)="change($event)" />
      <p [id]="controlId() + '-detail'">{{ copy().detail }}</p>
      <p [id]="controlId() + '-consequence'">{{ consequence }}</p>
      @if (error()) { <p role="alert">{{ error() }}</p> }
    </div>
  `,
  styles: [`
    :host { display: block; }
    input { width: 100%; accent-color: var(--primary-color); }
    input:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 3px; }
    label { font-weight: 600; }
    .scale { display: flex; justify-content: space-between; margin-top: var(--spacing-sm); }
    p, .scale { color: var(--text-secondary); font-size: 12px; }
    p { margin: var(--spacing-sm) 0; }
  `],
})
export class WorkloadSliderComponent {
  private readonly settings = inject(SettingsStore);
  readonly controlId = input('workload-titlebar');
  protected readonly level = computed(() => (this.settings.get('workloadLevel') ?? 3) as WorkloadLevel);
  protected readonly copy = computed(() => WORKLOAD_COPY[this.level()] ?? WORKLOAD_COPY[3]);
  protected readonly error = signal<string | null>(null);
  protected readonly consequence = WORKLOAD_CONSEQUENCE;

  protected async change(event: Event): Promise<void> {
    const inputElement = event.target as HTMLInputElement;
    const level = Number(inputElement.value);
    if (!Number.isInteger(level) || level < 1 || level > 5) return;
    this.error.set(null);
    try {
      await this.settings.set('workloadLevel', level as WorkloadLevel);
      if (this.settings.error?.()) this.error.set('Could not save the workload. Try again.');
    } catch {
      this.error.set('Could not save the workload. Try again.');
    }
  }
}

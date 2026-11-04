import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

@Component({
  selector: 'app-copilot-premium-usage',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span>Premium requests used: {{ measured() }}</span>`,
})
export class CopilotPremiumUsageComponent {
  readonly used = input<number | undefined>();
  protected readonly measured = computed(() => {
    const value = this.used();
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? String(value) : 'unavailable';
  });
}

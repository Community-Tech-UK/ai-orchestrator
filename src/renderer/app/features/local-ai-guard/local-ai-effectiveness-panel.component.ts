import {
  ChangeDetectionStrategy,
  Component,
  type OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import type {
  LocalAiEffectivenessSummary,
} from '../../../../shared/types/local-ai-guard.types';
import { LocalAiGuardStore } from '../../core/state/local-ai-guard.store';

type EffectivenessBreakdown = 'target' | 'model' | 'slot' | 'incident';

interface EffectivenessBreakdownEntry {
  key: string;
  label: string;
  count: number;
  percent: number;
}

const USD_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 20,
});
const COST_SIGNIFICANT_DIGITS = 15;

function formatLocalAiUsd(value: number): string {
  const normalized = value === 0
    ? 0
    : Number(value.toPrecision(COST_SIGNIFICANT_DIGITS));
  const formatted = USD_FORMATTER.format(normalized);
  if (normalized !== 0 && formatted === '$0.00') {
    return `$${normalized.toExponential()}`;
  }
  return formatted;
}

@Component({
  selector: 'app-local-ai-effectiveness-panel',
  standalone: true,
  templateUrl: './local-ai-effectiveness-panel.component.html',
  styleUrl: './local-ai-effectiveness-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LocalAiEffectivenessPanelComponent implements OnInit {
  protected readonly store = inject(LocalAiGuardStore);
  protected readonly breakdown = signal<EffectivenessBreakdown>('target');

  protected readonly eligibleTasks = computed(() => {
    const summary = this.store.effectiveness();
    return summary ? summary.localTasks + summary.proposedFallbacks : 0;
  });

  protected readonly completionPercent = computed(() => {
    const eligibleTasks = this.eligibleTasks();
    if (eligibleTasks === 0) return 0;
    return Math.round((this.store.effectiveness()!.localTasks / eligibleTasks) * 100);
  });

  protected readonly isEmpty = computed(() => this.eligibleTasks() === 0);

  protected readonly breakdownEntries = computed<EffectivenessBreakdownEntry[]>(() => {
    const summary = this.store.effectiveness();
    if (!summary) return [];
    const source = this.breakdownSource(summary, this.breakdown());
    const largest = Math.max(0, ...Object.values(source));
    return Object.entries(source)
      .map(([key, count]) => ({
        key,
        label: this.breakdownLabel(this.breakdown(), key),
        count,
        percent: largest === 0 ? 0 : Math.round((count / largest) * 100),
      }))
      .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
  });

  ngOnInit(): void {
    void this.store.loadEffectiveness(this.store.effectivenessWindow());
  }

  protected selectWindow(window: LocalAiEffectivenessSummary['window']): void {
    if (window === this.store.effectivenessWindow() && this.store.effectiveness()) return;
    void this.store.loadEffectiveness(window);
  }

  protected selectBreakdown(breakdown: EffectivenessBreakdown): void {
    this.breakdown.set(breakdown);
  }

  protected completionLabel(): string {
    const summary = this.store.effectiveness();
    if (!summary) return 'No Local AI effectiveness data';
    return `${summary.localTasks} of ${this.eligibleTasks()} eligible tasks completed locally, ${this.completionPercent()} percent`;
  }

  protected breakdownVisualLabel(entry: EffectivenessBreakdownEntry): string {
    return `${this.breakdownHeading()}: ${entry.label}, ${entry.count} task${entry.count === 1 ? '' : 's'}`;
  }

  protected breakdownHeading(): string {
    switch (this.breakdown()) {
      case 'target': return 'Endpoints';
      case 'model': return 'Models';
      case 'slot': return 'Helper slots';
      case 'incident': return 'Incidents';
    }
  }

  protected formatInteger(value: number): string {
    return new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 }).format(value);
  }

  protected formatUsd(value: number): string {
    return formatLocalAiUsd(value);
  }

  private breakdownSource(
    summary: LocalAiEffectivenessSummary,
    breakdown: EffectivenessBreakdown,
  ): Record<string, number> {
    switch (breakdown) {
      case 'target': return summary.byTarget;
      case 'model': return summary.byModel;
      case 'slot': return summary.bySlot;
      case 'incident': return summary.byIncident;
    }
  }

  private breakdownLabel(
    breakdown: EffectivenessBreakdown,
    key: string,
  ): string {
    if (breakdown === 'target') return this.store.knownTarget(key)?.label ?? key;
    if (breakdown !== 'slot') return key;
    return key
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/^./, (letter) => letter.toUpperCase());
  }
}

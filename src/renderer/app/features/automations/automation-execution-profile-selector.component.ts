import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { AutomationExecutionProfile } from '../../../../shared/types/automation.types';
import type { InstanceProvider } from '../../../../shared/types/instance.types';

/**
 * WS-C7 — the automation editor's execution-profile radio picker (Standard /
 * Contained). Kept as its own component: `automations-page.component.ts` is
 * at its LOC ceiling, and this control's logic (the resolved-provider
 * mismatch warning) is independently unit-testable without Angular's host.
 *
 * `resolvedProvider` is the SAME resolution `automation-model-preview.ts`
 * exposes (built from `resolveAutomationSpawnTarget`, the exact function the
 * main-process runner uses to pick a spawn target) — so the inline warning
 * can never claim a mismatch the fire-time gate wouldn't also refuse.
 */
@Component({
  selector: 'app-automation-execution-profile-selector',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './automation-execution-profile-selector.component.html',
  styleUrl: './automation-execution-profile-selector.component.css',
})
export class AutomationExecutionProfileSelectorComponent {
  readonly value = input.required<AutomationExecutionProfile>();
  readonly resolvedProvider = input<InstanceProvider | undefined>(undefined);
  readonly valueChange = output<AutomationExecutionProfile>();

  /** True when Contained is picked but the resolved provider isn't Codex — the fire-time gate would refuse this run. */
  readonly containedProviderMismatch = computed(() =>
    this.value() === 'contained' && this.resolvedProvider() !== 'codex'
  );

  select(profile: AutomationExecutionProfile): void {
    this.valueChange.emit(profile);
  }
}

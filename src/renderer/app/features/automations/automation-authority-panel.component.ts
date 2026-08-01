import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import {
  deriveAutomationAuthority,
  type AutomationAuthorityCard,
  type AutomationAuthorityInput,
  type AutomationAuthorityTemplate,
  type AutomationAuthorityTemplateId,
} from './automation-authority';

/**
 * WS-C5 — displays the six operating-authority cards (May access / May change
 * / Must ask before / Stops when / Verification / Report destination) for the
 * current config, plus optional one-click safety-preset buttons.
 *
 * Pure display: derivation itself lives in `automation-authority.ts` so it
 * stays unit-testable without Angular. Reused for both the live form (with
 * templates) and the read-only pre-run detail view (without templates).
 */
@Component({
  selector: 'app-automation-authority-panel',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './automation-authority-panel.component.html',
  styleUrl: './automation-authority-panel.component.css',
})
export class AutomationAuthorityPanelComponent {
  readonly authorityInput = input.required<AutomationAuthorityInput>();
  /** Only the live editor form passes presets; the read-only detail view leaves this empty. */
  readonly templates = input<AutomationAuthorityTemplate[]>([]);
  readonly templateApplied = output<AutomationAuthorityTemplateId>();

  readonly cards = computed<AutomationAuthorityCard[]>(() =>
    deriveAutomationAuthority(this.authorityInput()).cards
  );

  applyTemplate(id: AutomationAuthorityTemplateId): void {
    this.templateApplied.emit(id);
  }
}

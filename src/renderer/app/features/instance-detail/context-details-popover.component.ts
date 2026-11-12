import { ChangeDetectionStrategy, Component, computed, effect, input, output, signal, viewChild } from '@angular/core';
import type { ContextUsage } from '../../core/state/instance.store';
import { ContextBarComponent } from './context-bar.component';
import { ProviderDiagnosticsPanelComponent } from './provider-diagnostics-panel.component';
import { CompactionPreviewDialogComponent } from './compaction-preview-dialog.component';
import { CopilotPremiumUsageComponent } from './copilot-premium-usage.component';
import { FanoutCostComponent } from './fanout-cost.component';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
@Component({
  selector: 'app-context-details-popover', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ContextBarComponent, ProviderDiagnosticsPanelComponent, CompactionPreviewDialogComponent, CopilotPremiumUsageComponent, FanoutCostComponent, AioTooltipDirective],
  template: `@if (isOpen()) { <button type="button" class="backdrop" data-ui-hints-exempt="backdrop" aria-label="Close Context details" (click)="closed.emit()"></button> }
<section class="context-details" [hidden]="!isOpen()" role="dialog" aria-label="Context details" (keydown.escape)="onEscape($event)">
  <div class="heading"><h3>Context details</h3><button type="button" aria-label="Close Context details" appTooltip="Close Context details" (click)="closed.emit()">×</button></div>
  @if (isOpen()) {
    @if (usage(); as current) { <app-context-bar [usage]="current" [showDetails]="true" [showCost]="false" [instanceId]="instanceId()" (statusOpened)="closed.emit()" /> }
    @if (provider() === 'copilot') { <app-copilot-premium-usage [used]="usage()?.copilotUsage?.premiumRequests" /> }
    <app-fanout-cost [instanceId]="instanceId()" />
    <button type="button" (click)="previewOpen.set(true)">Compact now…</button>
  }
  <app-provider-diagnostics-panel [instanceId]="instanceId()" [contextUsage]="usage() ?? null" [exclude]="['context']" />
</section>
<app-compaction-preview-dialog [instanceId]="instanceId()" [isOpen]="previewOpen()" (closed)="previewOpen.set(false)" />
`,
  styles: [`
    :host { display: contents; }
    .context-details { position: absolute; bottom: calc(100% + 6px); left: 0; width: min(560px, 90vw); max-height: 60vh; overflow: auto; padding: 14px; background: var(--bg-elevated, #1d2126); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 10px; box-shadow: 0 8px 24px #0006; z-index: 51; }
    .context-details[hidden] { display: none; }
    .heading { display: flex; justify-content: space-between; gap: 12px; }
    h3 { margin: 0 0 12px; font-size: 14px; }
    button { font: inherit; color: inherit; background: transparent; border: 1px solid var(--border-color); border-radius: 6px; padding: 4px 8px; cursor: pointer; }
    .backdrop { position: fixed; inset: 0; border: 0; border-radius: 0; z-index: 50; }
  `],
})
export class ContextDetailsPopoverComponent {
  readonly instanceId = input.required<string>();
  readonly usage = input<ContextUsage | undefined>(undefined);
  /** Only Copilot reports premium requests. */
  readonly provider = input('');
  readonly isOpen = input(false);
  readonly closed = output<void>();
  readonly previewOpen = signal(false);
  private readonly diagnostics = viewChild(ProviderDiagnosticsPanelComponent);
  readonly warningItems = computed(() => this.diagnostics()?.warningItems() ?? []);
  readonly hasWarning = computed(() => this.warningItems().length > 0);
  readonly warningLabel = computed(() => this.warningItems().some(item => item.id === 'quota') ? 'Quota used up' : this.hasWarning() ? 'Rate limit reached' : null);
  constructor() { effect(() => { this.instanceId(); this.previewOpen.set(false); }); }
  onEscape(event: Event): void { event.preventDefault(); event.stopPropagation(); this.closed.emit(); }
}

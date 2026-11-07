import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { ContextAdvice } from '../../../../shared/types/provider-measured-context.types';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
@Component({ selector: 'app-context-advice-list', standalone: true, imports: [AioTooltipDirective], changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<ul aria-label="Context suggestions">@for (item of advice(); track item.id) {
    <li><span>{{ item.text }}</span>@if (item.action === 'compact-now' && canCompact()) {
      <button type="button" appTooltip="Summarise older conversation output to make more room." (click)="compact.emit()">Compact now</button>
    } @else if (item.action === 'open-usage') { <button type="button" (click)="openUsage.emit()">Usage details</button> }</li>
  }</ul>`, styles: [`ul { list-style:none; padding:0; margin:0; } li { margin:8px 0; line-height:1.5; } button { margin-left:8px; }`],
})
export class ContextAdviceListComponent {
  readonly advice = input<ContextAdvice[]>([]);
  readonly canCompact = input(false);
  readonly compact = output<void>();
  readonly openUsage = output<void>();
}

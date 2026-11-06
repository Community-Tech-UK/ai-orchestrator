import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { ModelDisplayInfo } from '../../../../shared/types/provider.types';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { buildModelRowFacts } from './model-row-facts';

@Component({
  selector: 'app-model-row-facts', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AioTooltipDirective],
  template: `<span class="facts"><span>{{ facts().tierLabel }}</span>
    @if (facts().contextLabel; as context) { <span>{{ context }}</span> }
    @if (facts().price; as price) { <span [appTooltip]="price.note || null">{{ price.text }}</span> }</span>`,
  styles: [`.facts { display: inline-flex; align-items: baseline; gap: 6px; flex-wrap: wrap; font-size: 10px; color: var(--text-muted); } .facts span { white-space: nowrap; }`],
})
export class ModelRowFactsComponent {
  readonly model = input.required<ModelDisplayInfo>();
  readonly provider = input.required<string>();
  protected readonly facts = computed(() => buildModelRowFacts(this.model(), this.provider()));
}

import { computed, Directive, inject, input } from '@angular/core';
import { AioTooltipDirective } from './aio-tooltip.directive';
import { resolveIconButtonAria } from './tooltip-policy';

/** One phrase supplies an icon control's accessible name and hover hint. */
@Directive({
  selector: '[appIconButton]', standalone: true,
  hostDirectives: [{ directive: AioTooltipDirective, inputs: [
    'appTooltipShortcut', 'appTooltipPosition', 'appTooltipVariant', 'appTooltipShowWhenExpanded',
    'appTooltipDisabledReason: appIconButtonDisabledReason',
  ] }],
  host: { '[attr.aria-label]': 'ariaLabel()' },
})
export class AppIconButtonDirective {
  readonly label = input.required<string>({ alias: 'appIconButton' });
  protected readonly ariaLabel = computed(() => resolveIconButtonAria(this.label()).ariaLabel);
  constructor() {
    inject(AioTooltipDirective, { self: true }).registerTextSource(computed(() => resolveIconButtonAria(this.label()).tooltip));
  }
}

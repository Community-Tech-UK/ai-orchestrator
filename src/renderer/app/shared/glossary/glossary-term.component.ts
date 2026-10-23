import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { AioTooltipDirective } from '../tooltip/aio-tooltip.directive';
import { HelpDrawerService } from '../help/help-drawer.service';
import { glossaryLabel, glossaryPlain, type GlossaryTermId } from './glossary';

/** Use on text, never inside another interactive control. */
@Component({
  selector: 'app-term',
  standalone: true,
  imports: [AioTooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<button type="button" class="app-term" [appTooltip]="tooltip()" aria-haspopup="dialog" (click)="learnMore($event)"><ng-content>{{ label() }}</ng-content></button>`,
  styles: [`
    :host { display: inline; }
    .app-term { color: inherit; font: inherit; background: none; border: 0; padding: 0; text-decoration: underline dotted; text-underline-offset: .2em; cursor: help; }
    .app-term:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 3px; border-radius: var(--radius-sm); }
  `],
})
export class GlossaryTermComponent {
  readonly term = input.required<GlossaryTermId>();
  readonly label = computed(() => glossaryLabel(this.term()));
  readonly tooltip = computed(() => `${glossaryPlain(this.term())} Select for more.`);
  private readonly drawer = inject(HelpDrawerService);
  learnMore(event: Event): void {
    event.stopPropagation();
    this.drawer.open({ topic: 'glossary', anchor: this.term() });
  }
}

import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { AppIconButtonDirective } from '../tooltip/icon-button.directive';
import { HelpDrawerService } from './help-drawer.service';
import type { HelpTopicId } from './help-topics';

@Component({
  selector: 'app-help-link',
  standalone: true,
  imports: [AppIconButtonDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<button type="button" [appIconButton]="label()" aria-haspopup="dialog" (click)="open($event)"><span aria-hidden="true">?</span></button>`,
  styles: [`
    :host { display: inline-flex; flex-shrink: 0; }
    button { width: 20px; height: 20px; padding: 0; border: 1px solid var(--border-color); border-radius: var(--radius-full); color: var(--text-secondary); background: none; font: inherit; cursor: help; }
    button:hover { color: var(--text-primary); background: var(--bg-hover); }
    button:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 3px; }
  `],
})
export class HelpLinkComponent {
  readonly topic = input.required<HelpTopicId>();
  readonly label = input.required<string>();
  private readonly drawer = inject(HelpDrawerService);
  open(event: Event): void {
    event.stopPropagation();
    this.drawer.open({ topic: this.topic() });
  }
}

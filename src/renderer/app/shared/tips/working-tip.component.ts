import { ChangeDetectionStrategy, Component, DestroyRef, Injector, afterRenderEffect, inject, input } from '@angular/core';
import { WorkingTipService, type WorkingTipRuntime } from './working-tip.service';

@Component({
  selector: 'app-working-tip', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (connection.tip(); as tip) {
    <div class="working-tip" role="note"><span>Tip: {{ tip.text }}</span><button type="button" (click)="connection.retire()">Got it</button></div>
  }`,
  styles: [`
    .working-tip { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; padding: 4px 14px; color: var(--text-secondary); font-size: var(--text-xs); }
    button { font: inherit; color: var(--text-secondary); background: transparent; border: 1px solid var(--border-color); border-radius: var(--radius-sm); padding: 3px 6px; cursor: pointer; }
    button:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
  `],
})
export class WorkingTipComponent {
  readonly context = input<WorkingTipRuntime | null>(null);
  protected readonly connection = inject(WorkingTipService).connect(() => this.context(), inject(Injector));
  constructor() {
    inject(DestroyRef).onDestroy(() => this.connection.destroy());
    afterRenderEffect(() => {
      const tip = this.connection.tip();
      if (tip) this.connection.markRendered(tip.id);
    });
  }
}

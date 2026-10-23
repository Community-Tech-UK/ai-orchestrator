import { afterRenderEffect, ChangeDetectionStrategy, Component, computed, ElementRef, inject, OnDestroy, viewChild } from '@angular/core';
import { HelpDrawerService } from './help-drawer.service';
import { resolveHelpTarget } from './help-target';
import { HelpPaneComponent } from './help-pane.component';
import { AioTooltipDirective } from '../tooltip/aio-tooltip.directive';
import { createFocusTrap, type FocusTrapHandle } from '../utils/focus-trap';

@Component({
  selector: 'app-help-drawer',
  standalone: true,
  imports: [HelpPaneComponent, AioTooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (resolved(); as help) {
      <button type="button" class="help-scrim" aria-hidden="true" tabindex="-1" (click)="drawer.close()"></button>
      <aside #dialog role="dialog" aria-modal="true" aria-label="Help &amp; tips" (keydown.escape)="close($event)">
        <header><h2>{{ help.title }}</h2><button type="button" appTooltip="Close help" aria-label="Close help" (click)="drawer.close()">×</button></header>
        <app-help-pane class="drawer" [entry]="help.entry" [collapsed]="false" (toggled)="drawer.close()" />
      </aside>
    }
  `,
  styles: [`
    .help-scrim { position: fixed; inset: 0; z-index: calc(var(--z-modal) + 2); border: 0; background: var(--overlay-dark-medium); }
    aside { position: fixed; inset: 0 0 0 auto; z-index: calc(var(--z-modal) + 3); width: min(380px, 100%); overflow-y: auto; background: var(--bg-primary); color: var(--text-primary); box-shadow: var(--shadow-lg); }
    header { display: flex; align-items: center; justify-content: space-between; padding: var(--spacing-md); }
    h2 { font-size: 16px; margin: 0; }
    header button { background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: var(--radius-sm); color: inherit; cursor: pointer; }
    button:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
    app-help-pane { width: 100%; }
  `],
})
export class HelpDrawerComponent implements OnDestroy {
  protected readonly drawer = inject(HelpDrawerService);
  protected readonly resolved = computed(() => {
    const target = this.drawer.target();
    return target ? resolveHelpTarget(target) : null;
  });
  private readonly dialog = viewChild<ElementRef<HTMLElement>>('dialog');
  private trap: FocusTrapHandle | null = null;
  private trappedElement: HTMLElement | null = null;

  constructor() {
    afterRenderEffect(() => {
      const element = this.dialog()?.nativeElement;
      const help = this.resolved();
      if (!element || !help) { this.release(); return; }
      if (element !== this.trappedElement) {
        this.release();
        this.trappedElement = element;
        this.trap = createFocusTrap(element);
        this.trap.activate();
      }
      if (help.anchor) {
        const anchor = element.querySelector<HTMLElement>(`#term-${help.anchor}`);
        anchor?.scrollIntoView({ block: 'start' });
        anchor?.focus();
      } else if (!element.contains(document.activeElement)) {
        element.querySelector<HTMLElement>('button')?.focus();
      }
    });
  }
  protected close(event: Event): void {
    event.stopPropagation();
    this.drawer.close();
  }
  ngOnDestroy(): void { this.release(); }
  private release(): void {
    this.trap?.restore();
    this.trap = null;
    this.trappedElement = null;
  }
}

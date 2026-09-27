import { Directive, output } from '@angular/core';

/** Fires when a downward drag starts at the top of the page. */
@Directive({
  standalone: true,
  selector: '[appPullRefresh]',
  host: {
    '(touchstart)': 'onStart($event)',
    '(touchend)': 'onEnd($event)',
    '(touchcancel)': 'onCancel()',
  },
})
export class PullRefreshDirective {
  readonly refresh = output<void>();
  private startY = 0;
  private tracking = false;

  protected onStart(event: TouchEvent): void {
    if (window.scrollY > 0) return;
    this.startY = event.changedTouches[0]?.clientY ?? 0;
    this.tracking = true;
  }

  protected onEnd(event: TouchEvent): void {
    if (!this.tracking) return;
    const endY = event.changedTouches[0]?.clientY ?? this.startY;
    this.tracking = false;
    if (endY - this.startY >= 72) this.refresh.emit();
  }

  protected onCancel(): void { this.tracking = false; }
}

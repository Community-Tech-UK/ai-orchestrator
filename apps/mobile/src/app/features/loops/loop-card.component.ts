import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Router } from '@angular/router';
import { LoopStore } from './loop.store';

/** Shown at the top of a conversation while that session owns a loop run. */
@Component({
  standalone: true,
  selector: 'app-loop-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible() && run(); as current) {
      <button type="button" class="loop-card" (click)="open()">
        <span>Loop · {{ current.status }} · {{ current.iteration }}@if (current.maxIterations) { of {{ current.maxIterations }} }</span>
        @if (current.lastIteration) { <span>{{ current.lastIteration.summary }}</span> }
      </button>
    }
  `,
  styles: [`
    .loop-card { display: grid; gap: var(--space-1); width: calc(100% - (var(--mobile-gutter) * 2)); margin: var(--space-2) var(--mobile-gutter); text-align: start; min-height: var(--control-size); border: 0; border-radius: var(--radius-md); background: var(--surface); color: var(--text); padding: var(--space-3); }
  `],
})
export class LoopCardComponent {
  readonly chatId = input.required<string>();
  readonly visible = input(false);
  private readonly loops = inject(LoopStore);
  private readonly router = inject(Router);
  protected readonly run = computed(() => {
    const matches = this.loops.runs().filter((item) => item.chatId === this.chatId());
    return matches.find((item) => item.status === 'running' || item.status === 'paused') ?? matches[0] ?? null;
  });
  protected open(): void {
    const run = this.run();
    if (run) void this.router.navigate(['/loops', run.id]);
  }
}

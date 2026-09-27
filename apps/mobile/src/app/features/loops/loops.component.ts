import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { MobileHeaderComponent } from '../../shared/mobile-header.component';
import { MobileIconComponent } from '../../shared/mobile-icon.component';
import { LoopStore } from './loop.store';

@Component({
  standalone: true,
  selector: 'app-loops',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, MobileHeaderComponent, MobileIconComponent],
  template: `
    <section class="screen">
      <app-mobile-header title="Loops">
        <button mobileHeaderLeading class="mobile-icon-button" type="button" (click)="back()" aria-label="Back to projects">
          <app-mobile-icon name="chevron-left" />
        </button>
      </app-mobile-header>
      @if (loops.error(); as message) { <p class="feedback" role="alert">{{ message }}</p> }
      @if (loops.status() === 'loading') { <p class="feedback" role="status">Loading loops…</p> }
      @if (loops.status() === 'ready' && loops.runs().length === 0) {
        <p class="feedback">No loop runs on this host.</p>
      }
      <ul>
        @for (run of loops.runs(); track run.id) {
          <li>
            <button type="button" (click)="open(run.id)">
              <span>{{ run.status }} · {{ run.iteration }}@if (run.maxIterations) { of {{ run.maxIterations }} }</span>
              <span>{{ run.workspaceCwd }}</span>
              <span>{{ run.startedAt | date:'short' }}</span>
              @if (run.lastIteration) { <span>{{ run.lastIteration.summary }}</span> }
            </button>
          </li>
        }
      </ul>
    </section>
  `,
  styles: [`
    :host { position: fixed; inset: 0; display: flex; background: var(--bg); color: var(--text);
      padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
    .screen { display: flex; flex-direction: column; flex: 1; min-height: 0; }
    ul { list-style: none; margin: 0; padding: 0 var(--mobile-gutter); overflow: auto; }
    button { width: 100%; text-align: start; min-height: var(--control-size); background: var(--surface); color: inherit; border: 0; border-radius: var(--radius-md); margin-block: var(--space-2); padding: var(--space-3); display: grid; gap: var(--space-1); }
    .feedback { margin: var(--space-3) var(--mobile-gutter); color: var(--text-secondary); }
  `],
})
export class LoopsComponent {
  protected readonly loops = inject(LoopStore);
  private readonly router = inject(Router);
  protected back(): void { void this.router.navigate(['/projects']); }
  protected open(id: string): void { void this.router.navigate(['/loops', id]); }
}

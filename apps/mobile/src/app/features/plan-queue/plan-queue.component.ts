import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { MobileHeaderComponent } from '../../shared/mobile-header.component';
import { MobileIconComponent } from '../../shared/mobile-icon.component';
import { PlanQueueStore } from './plan-queue.store';

@Component({
  standalone: true,
  selector: 'app-plan-queue',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MobileHeaderComponent, MobileIconComponent],
  template: `
    <section class="screen">
      <app-mobile-header title="Plan queue">
        <button mobileHeaderLeading class="mobile-icon-button" type="button" (click)="back()" aria-label="Back to projects">
          <app-mobile-icon name="chevron-left" />
        </button>
      </app-mobile-header>
      @if (queue.error(); as message) { <p class="feedback" role="alert">{{ message }}</p> }
      @if (queue.status() === 'loading') { <p class="feedback" role="status">Loading plan queue…</p> }
      @for (run of queue.runs(); track run.id) {
        <article>
          <header>
            <h2>{{ run.kind }} · {{ run.status }}</h2>
            <p>{{ run.workspaceCwd }}</p>
            <div class="actions">
              <button type="button" [disabled]="queue.pending()" (click)="queue.control(run.id, 'pause')">Pause</button>
              <button type="button" [disabled]="queue.pending()" (click)="queue.control(run.id, 'resume')">Resume</button>
              <button type="button" [disabled]="queue.pending()" (click)="queue.control(run.id, 'cancel')">Cancel</button>
            </div>
          </header>
          <ul>
            @for (item of run.items; track item.id) {
              <li>
                <button type="button" (click)="open(item.id)">
                  <span>{{ item.title }}</span>
                  <span>{{ item.state }}@if (item.question) { · needs an answer }</span>
                </button>
              </li>
            }
          </ul>
        </article>
      }
      @if (queue.status() === 'ready' && queue.runs().length === 0) { <p class="feedback">No plan queue runs.</p> }
    </section>
  `,
  styles: [`
    :host { position: fixed; inset: 0; display: flex; background: var(--bg); color: var(--text);
      padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
    .screen { flex: 1; min-height: 0; overflow: auto; }
    article { margin: var(--space-3) var(--mobile-gutter); }
    ul { list-style: none; margin: 0; padding: 0; }
    button { min-height: var(--control-size); }
    li button { width: 100%; text-align: start; display: grid; background: var(--surface); color: inherit; border: 0; border-radius: var(--radius-md); margin-block: var(--space-2); padding: var(--space-3); }
    .actions { display: flex; gap: var(--space-2); }
    .feedback, h2, p { margin-inline: var(--mobile-gutter); }
  `],
})
export class PlanQueueComponent {
  protected readonly queue = inject(PlanQueueStore);
  private readonly router = inject(Router);
  protected back(): void { void this.router.navigate(['/projects']); }
  protected open(id: string): void { void this.router.navigate(['/plan-queue', id]); }
}

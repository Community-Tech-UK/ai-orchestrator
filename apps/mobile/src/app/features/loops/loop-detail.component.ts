import { ChangeDetectionStrategy, Component, effect, inject, input } from '@angular/core';
import { Router } from '@angular/router';
import { MobileHeaderComponent } from '../../shared/mobile-header.component';
import { MobileIconComponent } from '../../shared/mobile-icon.component';
import { LoopStore } from './loop.store';

@Component({
  standalone: true,
  selector: 'app-loop-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MobileHeaderComponent, MobileIconComponent],
  template: `
    <section class="screen">
      <app-mobile-header [title]="'Loop'" [subtitle]="loops.detail()?.run.status || ''">
        <button mobileHeaderLeading class="mobile-icon-button" type="button" (click)="back()" aria-label="Back to loops">
          <app-mobile-icon name="chevron-left" />
        </button>
      </app-mobile-header>
      @if (loops.detail(); as detail) {
        <p class="summary">{{ detail.run.iteration }}@if (detail.run.maxIterations) { of {{ detail.run.maxIterations }} }
          · {{ detail.run.currentStage }} · {{ detail.run.workspaceCwd }}</p>
        <div class="actions">
          <button type="button" [disabled]="busy()" (click)="control('pause')">Pause</button>
          <button type="button" [disabled]="busy()" (click)="control('resume')">Resume</button>
          <button type="button" class="danger" [disabled]="busy()" (click)="control('stop')">Stop</button>
        </div>
        @if (loops.error(); as message) { <p role="alert">{{ message }}</p> }
        @if (detail.run.lastIteration; as last) { <p>{{ last.summary }}</p> }
        <ul>
          @for (item of detail.outstanding; track item.id) {
            <li>{{ item.kind }} · {{ item.status }} · {{ item.text }}</li>
          }
        </ul>
      } @else {
        <p role="status">Loading loop…</p>
      }
    </section>
  `,
  styles: [`
    :host { position: fixed; inset: 0; display: flex; background: var(--bg); color: var(--text);
      padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
    .screen { display: flex; flex-direction: column; gap: var(--space-3); padding-inline: var(--mobile-gutter); flex: 1; min-height: 0; overflow: auto; }
    .actions { display: flex; gap: var(--space-2); }
    button { min-height: var(--control-size); border: 0; border-radius: var(--radius-md); background: var(--surface); color: inherit; padding-inline: var(--space-3); }
    .danger { color: var(--accent-error); }
    ul { padding-left: 1.1rem; }
  `],
})
export class LoopDetailComponent {
  readonly id = input.required<string>();
  protected readonly loops = inject(LoopStore);
  private readonly router = inject(Router);

  constructor() {
    effect(() => { void this.loops.open(this.id()); });
  }

  protected busy(): boolean { return this.loops.pendingId() === this.id(); }
  protected back(): void { void this.router.navigate(['/loops']); }
  protected control(action: 'pause' | 'resume' | 'stop'): void { void this.loops.control(this.id(), action); }
}

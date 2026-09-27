import { ChangeDetectionStrategy, Component, inject, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { MobileHeaderComponent } from '../../shared/mobile-header.component';
import { MobileIconComponent } from '../../shared/mobile-icon.component';
import { DocReviewStore } from './doc-review.store';

@Component({
  standalone: true,
  selector: 'app-doc-reviews',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MobileHeaderComponent, MobileIconComponent],
  template: `
    <section class="screen">
      <app-mobile-header title="Reviews">
        <button mobileHeaderLeading class="mobile-icon-button" type="button" (click)="back()" aria-label="Back to projects">
          <app-mobile-icon name="chevron-left" />
        </button>
      </app-mobile-header>
      @if (reviews.error(); as message) { <p class="feedback" role="alert">{{ message }}</p> }
      @if (reviews.status() === 'loading') { <p class="feedback" role="status">Loading reviews…</p> }
      <ul>
        @for (review of reviews.reviews(); track review.id) {
          <li><button type="button" (click)="open(review.id)">{{ review.title }} · {{ review.status }}</button></li>
        }
      </ul>
      @if (reviews.status() === 'ready' && reviews.reviews().length === 0) { <p class="feedback">No reviews waiting.</p> }
    </section>
  `,
  styles: [`
    :host { position: fixed; inset: 0; display: flex; background: var(--bg); color: var(--text);
      padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
    .screen { flex: 1; min-height: 0; overflow: auto; }
    ul { list-style: none; margin: 0; padding: 0 var(--mobile-gutter); }
    button { width: 100%; text-align: start; min-height: var(--control-size); background: var(--surface); color: inherit; border: 0; border-radius: var(--radius-md); margin-block: var(--space-2); padding: var(--space-3); }
    .feedback { margin: var(--space-3) var(--mobile-gutter); color: var(--text-secondary); }
  `],
})
export class DocReviewsComponent implements OnInit {
  protected readonly reviews = inject(DocReviewStore);
  private readonly router = inject(Router);
  ngOnInit(): void { void this.reviews.refresh(); }
  protected back(): void { void this.router.navigate(['/projects']); }
  protected open(id: string): void { void this.router.navigate(['/reviews', id]); }
}

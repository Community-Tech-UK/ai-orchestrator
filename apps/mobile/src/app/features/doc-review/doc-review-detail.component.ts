import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { MobileDocReviewItemDecisionDto } from '../../core/models';
import { MobileHeaderComponent } from '../../shared/mobile-header.component';
import { MobileIconComponent } from '../../shared/mobile-icon.component';
import { DocReviewStore } from './doc-review.store';

@Component({
  standalone: true,
  selector: 'app-doc-review-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MobileHeaderComponent, MobileIconComponent],
  template: `
    <section class="screen">
      <app-mobile-header [title]="reviews.detail()?.review.title || 'Review'">
        <button mobileHeaderLeading class="mobile-icon-button" type="button" (click)="back()" aria-label="Back to reviews">
          <app-mobile-icon name="chevron-left" />
        </button>
      </app-mobile-header>
      @if (reviews.detail(); as detail) {
        @for (item of detail.items; track item.id) {
          <article>
            <h2>{{ item.title }}</h2>
            <div class="choices">
              <button type="button" [attr.aria-pressed]="decisionFor(item.id) === 'approve'" (click)="setDecision(item, 'approve')">Approve</button>
              <button type="button" [attr.aria-pressed]="decisionFor(item.id) === 'reject'" (click)="setDecision(item, 'reject')">Reject</button>
            </div>
            @if (item.options.length) {
              @for (option of item.options; track option.id) {
                <label>
                  <input [type]="option.multi ? 'checkbox' : 'radio'" [name]="item.id" [value]="option.id"
                    [checked]="chosen(item.id, option.id)" (change)="choose(item, option.id, option.multi)" />
                  {{ option.label }}@if (option.isDefault) { (default) }
                </label>
              }
            }
            <label>Comment
              <textarea rows="2" [value]="commentFor(item.id)" (input)="setComment(item.id, $event)"></textarea>
            </label>
          </article>
        }
        <label>Overall comment
          <textarea rows="3" [value]="general()" (input)="general.set(text($event))"></textarea>
        </label>
        <div class="choices">
          <button type="button" [disabled]="reviews.pending()" (click)="submit('approved')">Approve all</button>
          <button type="button" [disabled]="reviews.pending()" (click)="submit('changes_requested')">Request changes</button>
          <button type="button" [disabled]="reviews.pending()" (click)="submit('rejected')">Reject</button>
        </div>
        @if (reviews.error(); as message) { <p role="alert">{{ message }}</p> }
      } @else {
        <p role="status">Loading review…</p>
      }
    </section>
  `,
  styles: [`
    :host { position: fixed; inset: 0; display: flex; background: var(--bg); color: var(--text);
      padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
    .screen { flex: 1; overflow: auto; display: flex; flex-direction: column; gap: var(--space-3); padding: 0 var(--mobile-gutter) var(--space-4); }
    article, label { display: grid; gap: var(--space-2); background: var(--surface); border-radius: var(--radius-md); padding: var(--space-3); }
    textarea { width: 100%; font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--separator); border-radius: var(--radius-sm); }
    .choices { display: flex; flex-wrap: wrap; gap: var(--space-2); }
    button { min-height: var(--control-size); border: 0; border-radius: var(--radius-md); background: var(--surface-2); color: inherit; padding-inline: var(--space-3); }
    button[aria-pressed="true"] { outline: 2px solid var(--accent-action); }
  `],
})
export class DocReviewDetailComponent {
  readonly id = input.required<string>();
  protected readonly reviews = inject(DocReviewStore);
  private readonly router = inject(Router);
  private readonly decisions = signal<Record<string, MobileDocReviewItemDecisionDto>>({});
  protected readonly general = signal('');

  constructor() {
    effect(() => { void this.reviews.open(this.id()); });
  }

  protected back(): void { void this.router.navigate(['/reviews']); }
  protected decisionFor(itemId: string): 'approve' | 'reject' | null {
    return this.decisions()[itemId]?.decision ?? null;
  }
  protected commentFor(itemId: string): string { return this.decisions()[itemId]?.comment ?? ''; }
  protected chosen(itemId: string, optionId: string): boolean {
    const decision = this.decisions()[itemId];
    return decision?.choice === optionId || (decision?.choices ?? []).includes(optionId);
  }
  protected text(event: Event): string { return (event.target as HTMLTextAreaElement).value; }

  protected setDecision(item: { id: string; title: string; decisionId: string | null }, decision: 'approve' | 'reject'): void {
    this.decisions.update((all) => ({
      ...all,
      [item.id]: { ...all[item.id], itemId: item.id, title: item.title, decisionId: item.decisionId, decision },
    }));
  }

  protected setComment(itemId: string, event: Event): void {
    const comment = this.text(event);
    this.decisions.update((all) => ({ ...all, [itemId]: { ...all[itemId], itemId, decision: all[itemId]?.decision ?? null, comment } }));
  }

  protected choose(item: { id: string; title: string; decisionId: string | null; options: { multi: boolean }[] }, optionId: string, multi: boolean): void {
    this.decisions.update((all) => {
      const current = all[item.id] ?? { itemId: item.id, title: item.title, decisionId: item.decisionId, decision: 'approve' as const };
      if (!multi) return { ...all, [item.id]: { ...current, choice: optionId, choices: [], decision: current.decision ?? 'approve' } };
      const choices = new Set(current.choices ?? []);
      if (choices.has(optionId)) choices.delete(optionId);
      else choices.add(optionId);
      return { ...all, [item.id]: { ...current, choice: null, choices: [...choices], decision: current.decision ?? 'approve' } };
    });
  }

  protected async submit(overall: 'approved' | 'changes_requested' | 'rejected'): Promise<void> {
    const detail = this.reviews.detail();
    if (!detail) return;
    const decisions = detail.items.map((item) => this.decisions()[item.id] ?? {
      itemId: item.id, title: item.title, decisionId: item.decisionId, decision: null,
    });
    const ok = await this.reviews.submit(this.id(), { overall, decisions, generalComment: this.general() });
    if (ok) this.back();
  }
}

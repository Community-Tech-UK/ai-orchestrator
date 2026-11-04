import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import type { PlanQueueItemDto } from '@contracts/schemas/plan-queue';
import { pluralise } from '../plan-queue-item-display';

function notStarted(item: PlanQueueItemDto): boolean {
  return ['discovered', 'needs-answer', 'queued'].includes(item.state)
    && !item.branchName && !item.worktreePath && !item.workerInstanceId && !item.verifierInstanceId;
}

/** Preview a fixed selection; jobs that start while it is open are left alone. */
@Component({
  selector: 'app-plan-queue-skip-pending',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (available() > 0 || selection()) {
      <button type="button" (click)="selection.set(items())">Skip all not started</button>
    }
    @if (selection()) {
      <section aria-label="Preview skipping documents">
        <h3>Will change ({{ willChange().length }})</h3>
        <ul>@for (item of willChange(); track item.id) { <li>{{ name(item) }}</li> }</ul>
        <h3>Left alone ({{ leftAlone().length }})</h3>
        <ul>@for (item of leftAlone(); track item.id) { <li>{{ name(item) }}: already started, ended, or set aside</li> }</ul>
        <h3>Not applicable ({{ notApplicable().length }})</h3>
        <ul>@for (item of notApplicable(); track item.id) { <li>{{ name(item) }}: already started or set aside when the preview opened</li> }</ul>
        <p>Skipping leaves each document open and starts no session for it.</p>
        @if (willChange().length > 0) { <button type="button" class="pq-confirm-skip" (click)="confirm()">Skip {{ count(willChange().length, 'document') }}</button> }
        <button type="button" (click)="selection.set(null)">Cancel</button>
      </section>
    }
  `,
})
export class PlanQueueSkipPendingComponent {
  readonly items = input<readonly PlanQueueItemDto[]>([]);
  readonly skipItem = output<string>();
  protected readonly selection = signal<readonly PlanQueueItemDto[] | null>(null);
  protected readonly available = computed(() => this.items().filter(notStarted).length);
  protected readonly current = computed(() => new Map(this.items().map(item => [item.id, item])));
  protected readonly willChange = computed(() => (this.selection() ?? []).filter(original => notStarted(original))
    .map(original => this.current().get(original.id)).filter((item): item is PlanQueueItemDto => !!item && notStarted(item)));
  protected readonly leftAlone = computed(() => {
    const changed = new Set(this.willChange().map(item => item.id));
    return (this.selection() ?? []).filter(item => notStarted(item) && !changed.has(item.id));
  });
  protected readonly notApplicable = computed(() => (this.selection() ?? []).filter(item => !notStarted(item)));
  protected readonly name = (item: PlanQueueItemDto) => item.documentPath.split(/[\\/]/).pop();
  protected readonly count = pluralise;

  confirm(): void {
    const ids = this.willChange().map(item => item.id);
    this.selection.set(null);
    for (const id of ids) this.skipItem.emit(id);
  }
}

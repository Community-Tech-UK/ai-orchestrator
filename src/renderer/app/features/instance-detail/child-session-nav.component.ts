import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { InstanceStore } from '../../core/state/instance.store';

@Component({
  selector: 'app-child-session-nav', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (child(); as current) {
    <nav aria-label="Child session navigation">
      <span>Child {{ position() + 1 }} of {{ siblings().length }} of {{ parent()?.displayName || 'Unavailable parent' }}</span>
      <button type="button" [disabled]="!parent()" (click)="select(current.parentId)">Parent</button>
      <button type="button" [disabled]="position() <= 0" (click)="select(siblings()[position() - 1]?.id)">Previous</button>
      <button type="button" [disabled]="position() >= siblings().length - 1" (click)="select(siblings()[position() + 1]?.id)">Next</button>
      @if (position() === 0) { <span>First child</span> }
      @if (position() === siblings().length - 1) { <span>Last child</span> }
      @if (!parent()) { <span>The parent session is no longer open.</span> }
    </nav>
  }`,
  styles: [`nav { display: flex; align-items: center; flex-wrap: wrap; gap: var(--spacing-sm); padding: var(--spacing-sm) var(--spacing-md); font-size: 12px; color: var(--text-secondary); border-bottom: 1px solid var(--border-color); }
    button { color: var(--text-primary); background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: var(--radius-sm); padding: var(--spacing-xs) var(--spacing-sm); cursor: pointer; }
    button:disabled { opacity: .5; cursor: default; }`],
})
export class ChildSessionNavComponent {
  private readonly store = inject(InstanceStore);
  readonly instanceId = input.required<string>();
  readonly child = computed(() => this.store.instances().find((instance) => instance.id === this.instanceId() && instance.parentId) ?? null);
  readonly parent = computed(() => this.store.instances().find((instance) => instance.id === this.child()?.parentId) ?? null);
  readonly siblings = computed(() => this.child() ? this.store.instances().filter((instance) => instance.parentId === this.child()?.parentId).sort((left, right) => left.createdAt - right.createdAt) : []);
  readonly position = computed(() => this.siblings().findIndex((instance) => instance.id === this.instanceId()));
  select(id: string | null | undefined): void { if (id) this.store.setSelectedInstance(id); }
}

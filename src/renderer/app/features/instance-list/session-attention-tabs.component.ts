import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { attentionLevelForInstanceStatus } from '../../../../shared/attention/attention-level';
import { InstanceStore } from '../../core/state/instance.store';
import { NeedsYouStore } from '../workboard/needs-you.store';

@Component({
  selector: 'app-session-attention-tabs', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div role="group" aria-label="Filter sessions by attention">
    @for (tab of tabs(); track tab.value) {
      <button type="button" [class.active]="value() === tab.value" [attr.aria-pressed]="value() === tab.value" (click)="changed.emit(tab.value)">
        {{ tab.label }} @if (tab.count > 0) { <span>{{ tab.count }}</span> }
      </button>
    }
  </div>`,
  styles: [`:host { display:block; } div { display:flex; flex-wrap:wrap; gap:3px; } button { padding:4px 6px; border:1px solid var(--border-color); border-radius:var(--radius-sm,4px); background:transparent; color:var(--text-secondary); cursor:pointer; font-size:11px; } button.active { background:var(--bg-tertiary); color:var(--text-primary); } button:focus-visible { outline:2px solid var(--primary-color); } span { font-variant-numeric:tabular-nums; }`],
})
export class SessionAttentionTabsComponent {
  readonly value = input('all');
  readonly changed = output<string>();
  private readonly instances = inject(InstanceStore);
  private readonly needsYou = inject(NeedsYouStore);
  readonly tabs = computed(() => {
    const instances = this.instances.instances();
    const levels = instances.map((item) => attentionLevelForInstanceStatus(item.status));
    return [
      { value: 'attn:needs-you', label: 'Needs you', count: instances.filter((item) => this.needsYou.sessionIds().has(item.id)).length },
      { value: 'attn:working', label: 'Working', count: levels.filter((level) => level === 'working').length },
      { value: 'attn:idle', label: 'Idle', count: levels.filter((level) => level === 'idle' || level === 'waiting').length },
      { value: 'all', label: 'All', count: instances.length },
    ];
  });
}

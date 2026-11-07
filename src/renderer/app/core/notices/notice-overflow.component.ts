import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { NoticeSlotService } from './notice-slot.service';

@Component({
  selector: 'app-notice-overflow',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (slots.overflow().length > 0) {
      <aside class="notice-overflow" aria-label="More notices">
        @if (!slots.expanded()) {
          <span>{{ slots.overflow().length }} more {{ slots.overflow().length === 1 ? 'notice' : 'notices' }}: {{ names() }}</span>
        }
        <button type="button" [attr.aria-expanded]="slots.expanded()" (click)="slots.toggle()">
          {{ slots.expanded() ? 'Show fewer' : 'Show' }}
        </button>
      </aside>
    }
  `,
  styles: [`
    .notice-overflow { display: flex; align-items: center; gap: 8px; padding: 3px 16px; color: var(--text-secondary); font-size: var(--text-xs); }
    button { font: inherit; color: var(--primary-color); background: transparent; border: 0; cursor: pointer; padding: 4px; }
    button:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
  `],
})
export class NoticeOverflowComponent {
  protected readonly slots = inject(NoticeSlotService);
  protected readonly names = computed(() => this.slots.overflow().map(n => n.label).join(', '));
}

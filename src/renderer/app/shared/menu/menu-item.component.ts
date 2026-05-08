import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  Output,
  ViewChild,
  inject,
  NgZone,
} from '@angular/core';
import type { MenuItem } from './menu.types';

/**
 * One row in a `<app-nested-menu>`.
 *
 * Two interactive regions:
 *   - The row body (`<button role="menuitem">`) commits the item as a leaf.
 *     Hovering any part of the row opens the submenu (with 120ms delay)
 *     when the item has one — matches the Codex screenshot's UX.
 *   - The chevron region (`<button role="button">`) is rendered only when
 *     `item.submenu` is set; clicking it opens the submenu immediately
 *     without committing. Screen readers announce it as a distinct
 *     "Open X options" button so the split target is discoverable.
 *
 * The component does not own selection state. The parent `nested-menu`
 * passes `focused` to drive roving tabindex; click and submenu intents
 * are emitted as events so the parent can dispatch them.
 */
@Component({
  selector: 'app-menu-item',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="menu-item-row" (mouseenter)="onMouseEnter()" (mouseleave)="onMouseLeave()">
      <button
        #rowButton
        type="button"
        class="menu-item-row__body"
        role="menuitem"
        [attr.tabindex]="focused ? 0 : -1"
        [attr.aria-checked]="item.selected ? 'true' : null"
        [attr.aria-haspopup]="item.submenu ? 'menu' : null"
        [attr.aria-disabled]="item.disabledReason ? 'true' : null"
        [attr.aria-expanded]="item.submenu ? (submenuOpen ? 'true' : 'false') : null"
        [attr.title]="item.disabledReason ?? null"
        (click)="onRowClick($event)"
        (focus)="onRowFocus()"
      >
        @if (item.selected) {
          <span class="menu-item-row__check" aria-hidden="true">✓</span>
        } @else {
          <span class="menu-item-row__check menu-item-row__check--placeholder" aria-hidden="true"></span>
        }
        <span class="menu-item-row__label">{{ item.label }}</span>
      </button>
      @if (item.submenu) {
        <button
          type="button"
          class="menu-item-row__chevron"
          tabindex="-1"
          [attr.aria-label]="'Open ' + item.label + ' options'"
          [attr.aria-disabled]="item.disabledReason ? 'true' : null"
          (click)="onChevronClick($event)"
        >
          <span aria-hidden="true">›</span>
        </button>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }

    .menu-item-row {
      display: flex;
      align-items: stretch;
      width: 100%;
    }

    .menu-item-row__body {
      flex: 1 1 auto;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      background: transparent;
      border: 0;
      color: var(--text-primary, inherit);
      font: inherit;
      text-align: left;
      cursor: pointer;
      min-height: 32px;
    }

    .menu-item-row__body:hover:not([aria-disabled='true']),
    .menu-item-row__body:focus-visible {
      background: var(--bg-tertiary, rgba(127,127,127,0.12));
      outline: none;
    }

    .menu-item-row__body[aria-disabled='true'] {
      opacity: 0.45;
      cursor: not-allowed;
    }

    .menu-item-row__check {
      width: 14px;
      flex: 0 0 14px;
      text-align: center;
    }
    .menu-item-row__check--placeholder { visibility: hidden; }

    .menu-item-row__label {
      flex: 1 1 auto;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .menu-item-row__chevron {
      flex: 0 0 28px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: 0;
      color: inherit;
      font-size: 16px;
      cursor: pointer;
    }
    .menu-item-row__chevron:hover:not([aria-disabled='true']) {
      background: var(--bg-tertiary, rgba(127,127,127,0.12));
    }
    .menu-item-row__chevron[aria-disabled='true'] {
      opacity: 0.45;
      cursor: not-allowed;
    }
  `],
})
export class MenuItemComponent<T = unknown> {
  @Input({ required: true }) item!: MenuItem<T>;
  @Input() focused = false;
  @Input() submenuOpen = false;

  @Output() itemSelect = new EventEmitter<MenuItem<T>>();
  @Output() openSubmenu = new EventEmitter<MenuItem<T>>();
  @Output() rowFocused = new EventEmitter<MenuItem<T>>();

  @ViewChild('rowButton', { static: true }) rowButton!: ElementRef<HTMLButtonElement>;

  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly zone = inject(NgZone);
  private static readonly HOVER_OPEN_DELAY_MS = 120;

  focusRow(): void {
    this.rowButton.nativeElement.focus();
  }

  onRowClick(event: MouseEvent): void {
    event.stopPropagation();
    this.cancelHoverTimer();
    if (this.item.disabledReason) return;
    this.itemSelect.emit(this.item);
  }

  onChevronClick(event: MouseEvent): void {
    event.stopPropagation();
    this.cancelHoverTimer();
    if (this.item.disabledReason || !this.item.submenu) return;
    this.openSubmenu.emit(this.item);
  }

  onRowFocus(): void {
    this.rowFocused.emit(this.item);
  }

  onMouseEnter(): void {
    if (this.item.disabledReason || !this.item.submenu) return;
    this.cancelHoverTimer();
    this.zone.runOutsideAngular(() => {
      this.hoverTimer = setTimeout(() => {
        this.zone.run(() => this.openSubmenu.emit(this.item));
      }, MenuItemComponent.HOVER_OPEN_DELAY_MS);
    });
  }

  onMouseLeave(): void {
    this.cancelHoverTimer();
  }

  private cancelHoverTimer(): void {
    if (this.hoverTimer) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
  }
}

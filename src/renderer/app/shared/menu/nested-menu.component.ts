import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  Output,
  QueryList,
  ViewChild,
  ViewChildren,
  signal,
  computed,
  AfterViewInit,
  OnDestroy,
} from '@angular/core';
import { OverlayModule, ConnectedPosition } from '@angular/cdk/overlay';
import { MenuItemComponent } from './menu-item.component';
import type { MenuItem, MenuModel } from './menu.types';

/**
 * Generic nested menu — renders a `MenuModel<T>` inside a `role="menu"`
 * container with keyboard navigation, hover-to-open submenus, and
 * CDK-overlay-mounted nested submenus that fly out to the right.
 *
 * The component is stateless about *selection*. Consumers handle the
 * `itemSelect` event and re-render with the new selection if needed.
 * This keeps the primitive composable across pickers (model picker
 * today, agent picker / slash-command palette later).
 *
 * Keyboard (per WAI-ARIA APG menu pattern):
 *   ↑/↓     move focus within the current menu, wrapping at the ends
 *   Home    focus first item
 *   End     focus last item
 *   Enter   commit a leaf item (emit `itemSelect`); on a parent, open submenu
 *   Space   open submenu when focused on a parent item
 *   →       open submenu of focused parent item; focus moves into it
 *   ←       close current submenu; focus returns to parent row
 *   Esc     emit `dismiss` (the consumer hides the popover)
 *   Tab     emit `dismiss` (Tab exits the menu)
 *
 * Disabled items remain focusable (so screen readers announce the
 * disabled reason) but `Enter` / click is a no-op.
 */
@Component({
  selector: 'app-nested-menu',
  standalone: true,
  imports: [OverlayModule, MenuItemComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      #menuRoot
      class="nested-menu"
      role="menu"
      tabindex="-1"
      (keydown)="onKeydown($event)"
    >
      @if (totalItemCount() === 0 && model.emptyStateLabel) {
        <div class="nested-menu__empty" role="presentation">{{ model.emptyStateLabel }}</div>
      } @else {
        @for (section of model.sections; track section.id; let sectionIdx = $index) {
          @if (section.label) {
            <div class="nested-menu__section-label" role="presentation">{{ section.label }}</div>
          }
          @for (item of section.items; track item.id; let itemIdx = $index) {
            <app-menu-item
              [item]="item"
              [focused]="isFocused(sectionIdx, itemIdx)"
              [submenuOpen]="openSubmenuId() === item.id"
              (itemSelect)="onItemSelect($event)"
              (openSubmenu)="onItemOpenSubmenu($event, sectionIdx, itemIdx)"
              (rowFocused)="onItemRowFocused(sectionIdx, itemIdx)"
            />
          }
          @if (sectionIdx < lastSectionIndex()) {
            <hr class="nested-menu__divider" role="separator" />
          }
        }
      }
    </div>

    @for (submenuItem of pendingSubmenuItems(); track submenuItem.id) {
      <ng-template
        cdkConnectedOverlay
        [cdkConnectedOverlayOpen]="openSubmenuId() === submenuItem.id"
        [cdkConnectedOverlayOrigin]="originForId(submenuItem.id)"
        [cdkConnectedOverlayPositions]="submenuPositions"
        [cdkConnectedOverlayHasBackdrop]="false"
        (overlayOutsideClick)="onSubmenuOutsideClick($event)"
      >
        @if (submenuItem.submenu) {
          <app-nested-menu
            #childMenu
            [model]="submenuItem.submenu"
            [autoFocus]="true"
            (itemSelect)="onSubmenuSelect(submenuItem, $event)"
            (dismiss)="closeSubmenu()"
          />
        }
      </ng-template>
    }
  `,
  styles: [`
    :host { display: block; }
    .nested-menu {
      min-width: 220px;
      padding: 4px 0;
      background: var(--bg-secondary, #1f1f1f);
      border: 1px solid var(--border-subtle, rgba(255,255,255,0.08));
      border-radius: 8px;
      box-shadow: 0 6px 24px rgba(0,0,0,0.32);
      max-height: 320px;
      overflow-y: auto;
      outline: none;
    }
    .nested-menu__section-label {
      padding: 6px 12px 2px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-tertiary, rgba(255,255,255,0.5));
    }
    .nested-menu__divider {
      border: 0;
      border-top: 1px solid var(--border-subtle, rgba(255,255,255,0.08));
      margin: 4px 0;
    }
    .nested-menu__empty {
      padding: 10px 12px;
      color: var(--text-tertiary, rgba(255,255,255,0.5));
      font-style: italic;
    }
  `],
})
export class NestedMenuComponent<T = unknown> implements AfterViewInit, OnDestroy {
  @Input({ required: true }) model!: MenuModel<T>;
  /** When true, focuses the first focusable item on mount. */
  @Input() autoFocus = false;

  @Output() itemSelect = new EventEmitter<MenuItem<T>>();
  @Output() dismiss = new EventEmitter<void>();

  @ViewChild('menuRoot', { static: true }) menuRoot!: ElementRef<HTMLDivElement>;
  @ViewChildren(MenuItemComponent) menuItems!: QueryList<MenuItemComponent<T>>;

  readonly openSubmenuId = signal<string | null>(null);
  /**
   * Roving-tabindex anchor. -1 / -1 means "no item yet has keyboard focus";
   * the first ArrowDown lands on item 0, ArrowUp lands on the last item.
   * Once a keyboard action sets these, an item is rendered with `tabindex=0`.
   */
  private readonly focusedSectionIdx = signal(-1);
  private readonly focusedItemIdx = signal(-1);
  private readonly originElements = new Map<string, ElementRef<HTMLElement>>();

  /** Position list passed to `cdkConnectedOverlay` for the right-side submenu. */
  readonly submenuPositions: ConnectedPosition[] = [
    { originX: 'end',   originY: 'top',    overlayX: 'start', overlayY: 'top',    offsetX: 4 },
    { originX: 'start', originY: 'top',    overlayX: 'end',   overlayY: 'top',    offsetX: -4 },
    { originX: 'end',   originY: 'bottom', overlayX: 'start', overlayY: 'bottom', offsetX: 4 },
  ];

  totalItemCount = computed(() =>
    this.model.sections.reduce((sum, s) => sum + s.items.length, 0)
  );

  lastSectionIndex = computed(() => {
    const lastWithItems = [...this.model.sections]
      .map((_, i) => i)
      .reverse()
      .find((i) => this.model.sections[i].items.length > 0);
    return lastWithItems ?? -1;
  });

  pendingSubmenuItems = computed(() => {
    const items: MenuItem<T>[] = [];
    for (const section of this.model.sections) {
      for (const item of section.items) {
        if (item.submenu) items.push(item);
      }
    }
    return items;
  });

  isFocused(sectionIdx: number, itemIdx: number): boolean {
    return this.focusedSectionIdx() === sectionIdx && this.focusedItemIdx() === itemIdx;
  }

  ngAfterViewInit(): void {
    if (this.autoFocus) {
      // Defer to allow QueryList to populate.
      queueMicrotask(() => this.focusFirstItem());
    }
  }

  ngOnDestroy(): void {
    this.openSubmenuId.set(null);
  }

  originForId(itemId: string): ElementRef<HTMLElement> {
    // Fallback to menu root if item-specific origin isn't registered yet
    // (shouldn't happen post-render, but keeps the ng-template typed).
    return this.originElements.get(itemId) ?? this.menuRoot;
  }

  onItemSelect(item: MenuItem<T>): void {
    this.itemSelect.emit(item);
  }

  onItemOpenSubmenu(item: MenuItem<T>, sectionIdx: number, itemIdx: number): void {
    this.focusedSectionIdx.set(sectionIdx);
    this.focusedItemIdx.set(itemIdx);
    this.captureOriginFor(item.id, sectionIdx, itemIdx);
    this.openSubmenuId.set(item.id);
  }

  onItemRowFocused(sectionIdx: number, itemIdx: number): void {
    this.focusedSectionIdx.set(sectionIdx);
    this.focusedItemIdx.set(itemIdx);
  }

  onSubmenuSelect(_parent: MenuItem<T>, child: MenuItem<T>): void {
    // Bubble the chosen submenu item up so the consumer can map it back
    // to the parent context if needed via `child.payload`.
    this.itemSelect.emit(child);
    this.openSubmenuId.set(null);
  }

  onSubmenuOutsideClick(event: MouseEvent): void {
    // If the click landed inside the parent menu's root, ignore — keep
    // submenu open while the user navigates the parent.
    const root = this.menuRoot.nativeElement;
    const target = event.target as Node | null;
    if (target && root.contains(target)) return;
    this.openSubmenuId.set(null);
    this.dismiss.emit();
  }

  closeSubmenu(): void {
    this.openSubmenuId.set(null);
    // Restore focus to the parent row that opened the submenu.
    queueMicrotask(() => this.focusCurrent());
  }

  onKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.moveFocus(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.moveFocus(-1);
        break;
      case 'Home':
        event.preventDefault();
        this.focusFirstItem();
        break;
      case 'End':
        event.preventDefault();
        this.focusLastItem();
        break;
      case 'ArrowRight':
      case ' ':
      case 'Spacebar': {
        const item = this.currentItem();
        if (item?.submenu && !item.disabledReason) {
          event.preventDefault();
          this.openSubmenuFor(item);
        }
        break;
      }
      case 'ArrowLeft':
        event.preventDefault();
        if (this.openSubmenuId()) {
          this.closeSubmenu();
        } else {
          this.dismiss.emit();
        }
        break;
      case 'Enter': {
        const item = this.currentItem();
        if (!item || item.disabledReason) return;
        event.preventDefault();
        if (item.submenu) {
          this.openSubmenuFor(item);
        } else {
          this.itemSelect.emit(item);
        }
        break;
      }
      case 'Escape':
      case 'Tab':
        event.preventDefault();
        this.dismiss.emit();
        break;
      default:
        break;
    }
  }

  private currentItem(): MenuItem<T> | undefined {
    return this.model.sections[this.focusedSectionIdx()]?.items[this.focusedItemIdx()];
  }

  private moveFocus(delta: 1 | -1): void {
    const flat = this.flattenItems();
    if (flat.length === 0) return;
    const currentFlat = flat.findIndex(
      (e) => e.sectionIdx === this.focusedSectionIdx() && e.itemIdx === this.focusedItemIdx()
    );
    const baseIdx = currentFlat === -1 ? (delta === 1 ? -1 : 0) : currentFlat;
    const nextFlat = (baseIdx + delta + flat.length) % flat.length;
    this.focusedSectionIdx.set(flat[nextFlat].sectionIdx);
    this.focusedItemIdx.set(flat[nextFlat].itemIdx);
    this.focusCurrent();
  }

  private focusFirstItem(): void {
    const flat = this.flattenItems();
    if (flat.length === 0) return;
    this.focusedSectionIdx.set(flat[0].sectionIdx);
    this.focusedItemIdx.set(flat[0].itemIdx);
    this.focusCurrent();
  }

  private focusLastItem(): void {
    const flat = this.flattenItems();
    if (flat.length === 0) return;
    const last = flat[flat.length - 1];
    this.focusedSectionIdx.set(last.sectionIdx);
    this.focusedItemIdx.set(last.itemIdx);
    this.focusCurrent();
  }

  private focusCurrent(): void {
    const flat = this.flattenItems();
    const targetIdx = flat.findIndex(
      (e) => e.sectionIdx === this.focusedSectionIdx() && e.itemIdx === this.focusedItemIdx()
    );
    if (targetIdx === -1) return;
    const itemComp = this.menuItems.toArray()[targetIdx];
    itemComp?.focusRow();
  }

  private openSubmenuFor(item: MenuItem<T>): void {
    const flat = this.flattenItems();
    const idx = flat.findIndex((e) => e.item.id === item.id);
    if (idx === -1) return;
    this.captureOriginFor(item.id, flat[idx].sectionIdx, flat[idx].itemIdx);
    this.openSubmenuId.set(item.id);
  }

  private captureOriginFor(itemId: string, sectionIdx: number, itemIdx: number): void {
    const flat = this.flattenItems();
    const targetIdx = flat.findIndex(
      (e) => e.sectionIdx === sectionIdx && e.itemIdx === itemIdx
    );
    if (targetIdx === -1) return;
    const comp = this.menuItems.toArray()[targetIdx];
    if (comp) {
      this.originElements.set(itemId, comp.rowButton);
    }
  }

  private flattenItems(): { sectionIdx: number; itemIdx: number; item: MenuItem<T> }[] {
    const flat: { sectionIdx: number; itemIdx: number; item: MenuItem<T> }[] = [];
    this.model.sections.forEach((section, sectionIdx) => {
      section.items.forEach((item, itemIdx) => {
        flat.push({ sectionIdx, itemIdx, item });
      });
    });
    return flat;
  }
}

import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  TemplateRef,
  computed,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import type { OverlayController, OverlayItem, OverlayItemFooterTemplate } from './overlay.types';

@Component({
  selector: 'app-overlay-shell',
  standalone: true,
  imports: [NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="overlay-backdrop"
      tabindex="0"
      role="dialog"
      aria-modal="true"
      [attr.aria-label]="controller().title"
      (click)="onBackdropClick($event)"
      (keydown)="onShellKeydown($event)"
    >
      <section class="overlay-panel">
        <header class="overlay-header">
          <span class="overlay-glyph">/</span>
          <input
            #searchInput
            class="overlay-input"
            type="text"
            [placeholder]="controller().placeholder"
            [value]="controller().query()"
            (input)="onInput($event)"
            (keydown)="onInputKeydown($event)"
          />
          <kbd>Esc</kbd>
        </header>

        @if (headerAccessory()) {
          <ng-container [ngTemplateOutlet]="headerAccessory()" />
        }

        <div class="overlay-list">
          @if (flatItems().length === 0) {
            <div class="overlay-empty">{{ controller().emptyLabel }}</div>
          } @else {
            @for (group of controller().groups(); track group.id) {
              @if (group.items.length > 0) {
                <div class="overlay-group">
                  <div class="overlay-group-label">{{ group.label }}</div>
                  @for (item of group.items; track item.id) {
                    <div
                      class="overlay-row"
                      role="button"
                      tabindex="0"
                      [attr.aria-disabled]="item.disabled ? 'true' : null"
                      [class.selected]="isSelected(item)"
                      [class.disabled-row]="item.disabled"
                      [title]="item.disabledReason || item.description || item.label"
                      (click)="select(item)"
                      (keydown.enter)="select(item)"
                      (keydown.space)="select(item)"
                      (mouseenter)="selectById(item.id)"
                    >
                      <span class="overlay-row-main">
                        <span class="overlay-row-label">{{ item.label }}</span>
                        @if (item.description) {
                          <span class="overlay-row-description">{{ item.description }}</span>
                        }
                        @if (item.disabledReason) {
                          <span class="overlay-row-disabled">{{ item.disabledReason }}</span>
                        }
                        @if (itemFooter()) {
                          <ng-container
                            [ngTemplateOutlet]="itemFooter()"
                            [ngTemplateOutletContext]="{ $implicit: item, item: item }"
                          />
                        }
                      </span>
                      @if (item.detail) {
                        <span class="overlay-row-detail">{{ item.detail }}</span>
                      }
                      @if (item.badge) {
                        <span class="overlay-row-badge">{{ item.badge }}</span>
                      }
                    </div>
                  }
                </div>
              }
            }
          }
        </div>

        <footer class="overlay-footer">
          <span><kbd>Up</kbd><kbd>Down</kbd> Navigate</span>
          <span><kbd>Enter</kbd> Select</span>
        </footer>
      </section>
    </div>
  `,
  styles: [`
    .overlay-backdrop {
      position: fixed;
      inset: 0;
      z-index: 9999;
      display: flex;
      justify-content: center;
      padding-top: 12vh;
      background: rgba(0, 0, 0, 0.52);
      backdrop-filter: blur(5px);
    }

    .overlay-panel {
      width: min(720px, calc(100vw - 32px));
      max-height: min(720px, 72vh);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 8px;
      background: rgba(13, 18, 17, 0.98);
      box-shadow: 0 24px 70px rgba(0, 0, 0, 0.46);
    }

    .overlay-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 14px 16px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.07);
    }

    .overlay-glyph,
    .overlay-row-label {
      color: var(--primary-color);
      font-family: var(--font-mono);
      font-weight: 700;
    }

    .overlay-input {
      flex: 1;
      min-width: 0;
      border: 0;
      outline: none;
      background: transparent;
      color: var(--text-primary);
      font: 15px var(--font-display);
    }

    .overlay-list {
      flex: 1;
      overflow: auto;
      padding: 8px;
    }

    .overlay-empty {
      padding: 36px 16px;
      text-align: center;
      color: var(--text-muted);
    }

    .overlay-group-label {
      padding: 10px 8px 6px;
      color: var(--text-muted);
      font: 700 10px var(--font-mono);
      letter-spacing: 0;
      text-transform: uppercase;
    }

    .overlay-row {
      width: 100%;
      min-height: 58px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      align-items: center;
      gap: 12px;
      padding: 10px 12px;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: var(--text-primary);
      text-align: left;
      cursor: pointer;
    }

    .overlay-row:hover,
    .overlay-row.selected {
      background: rgba(255, 255, 255, 0.055);
    }

    .overlay-row.selected {
      outline: 1px solid rgba(var(--primary-rgb), 0.38);
    }

    .overlay-row.disabled-row {
      opacity: 0.52;
      cursor: not-allowed;
    }

    .overlay-row-main {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .overlay-row-description,
    .overlay-row-disabled {
      overflow: hidden;
      color: var(--text-secondary);
      font-size: 12px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .overlay-row-disabled {
      color: var(--warning-color, #ffb74d);
    }

    .overlay-row-detail,
    .overlay-row-badge,
    kbd {
      flex-shrink: 0;
      border-radius: 5px;
      background: rgba(255, 255, 255, 0.07);
      color: var(--text-muted);
      font: 11px var(--font-mono);
    }

    .overlay-row-detail,
    .overlay-row-badge {
      padding: 3px 7px;
    }

    kbd {
      padding: 2px 5px;
    }

    .overlay-footer {
      display: flex;
      justify-content: center;
      gap: 20px;
      padding: 10px 14px;
      border-top: 1px solid rgba(255, 255, 255, 0.07);
      color: var(--text-muted);
      font-size: 12px;
    }

    .overlay-footer span {
      display: flex;
      align-items: center;
      gap: 5px;
    }
  `],
})
export class OverlayShellComponent implements AfterViewInit {
  controller = input.required<OverlayController>();
  headerAccessory = input<TemplateRef<unknown> | null>(null);
  itemFooter = input<OverlayItemFooterTemplate | null>(null);
  closeRequested = output<void>();
  selected = output<OverlayItem>();

  private searchInput = viewChild<ElementRef<HTMLInputElement>>('searchInput');
  private selectedIndex = signal(0);

  flatItems = computed(() => this.controller().groups().flatMap((group) => group.items));
  selectedItem = computed(() => this.flatItems()[this.selectedIndex()] ?? null);

  ngAfterViewInit(): void {
    setTimeout(() => this.searchInput()?.nativeElement.focus());
  }

  onInput(event: Event): void {
    this.controller().setQuery((event.target as HTMLInputElement).value);
    this.selectedIndex.set(0);
  }

  onInputKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.move(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.move(-1);
        break;
      case 'Enter':
        event.preventDefault();
        this.select(this.selectedItem());
        break;
      case 'Escape':
        event.preventDefault();
        this.closeRequested.emit();
        break;
    }
  }

  onShellKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.closeRequested.emit();
    }
  }

  onBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.closeRequested.emit();
    }
  }

  selectById(id: string): void {
    const index = this.flatItems().findIndex((item) => item.id === id);
    if (index >= 0) {
      this.selectedIndex.set(index);
    }
  }

  select(item: OverlayItem | null): void {
    if (!item || item.disabled) return;
    this.selected.emit(item);
  }

  isSelected(item: OverlayItem): boolean {
    return this.selectedItem()?.id === item.id;
  }

  private move(delta: 1 | -1): void {
    const items = this.flatItems();
    if (items.length === 0) return;
    this.selectedIndex.update((index) => (index + delta + items.length) % items.length);
  }
}

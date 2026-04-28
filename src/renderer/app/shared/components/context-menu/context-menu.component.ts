import {
  Component,
  ChangeDetectionStrategy,
  HostListener,
  ElementRef,
  inject,
  signal,
  effect,
  Input,
  Output,
  EventEmitter,
} from '@angular/core';

export interface ContextMenuItem {
  id?: string;
  label: string;
  icon?: string;
  action: () => void | Promise<void>;
  disabled?: boolean;
  danger?: boolean;
  divider?: boolean;
}

@Component({
  selector: 'app-context-menu',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (menuVisible()) {
      <div
        #menu
        class="context-menu"
        role="menu"
        [style.left.px]="menuLeft()"
        [style.top.px]="menuTop()"
        (contextmenu)="$event.preventDefault()"
      >
        @for (item of menuItems(); track item.id ?? item.label) {
          @if (item.divider) {
            <div class="context-menu-divider"></div>
          }
          <button
            class="context-menu-item"
            [class.disabled]="item.disabled"
            [class.danger]="item.danger"
            [disabled]="item.disabled"
            role="menuitem"
            (click)="onItemClick(item)"
          >
            @if (item.icon) {
              <span class="context-menu-icon" aria-hidden="true">{{ item.icon }}</span>
            }
            <span class="context-menu-label">{{ item.label }}</span>
          </button>
        }
      </div>
    }
  `,
  styles: [`
    :host {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      z-index: 10000;
      pointer-events: none;
    }

    .context-menu {
      position: fixed;
      min-width: 208px;
      max-width: min(280px, calc(100vw - 16px));
      max-height: calc(100vh - 16px);
      overflow-y: auto;
      background:
        linear-gradient(180deg, rgba(30, 38, 36, 0.98), rgba(12, 18, 17, 0.98));
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 8px;
      padding: 6px;
      box-shadow:
        0 18px 42px rgba(0, 0, 0, 0.46),
        inset 0 1px 0 rgba(255, 255, 255, 0.08);
      pointer-events: all;
      z-index: 10001;
      backdrop-filter: blur(14px);
      animation: context-menu-pop 90ms ease-out;
      transform-origin: top left;
    }

    @keyframes context-menu-pop {
      from {
        opacity: 0;
        transform: translateY(-3px) scale(0.98);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }

    .context-menu-item {
      display: flex;
      align-items: center;
      gap: 9px;
      width: 100%;
      min-height: 32px;
      padding: 7px 9px;
      border: none;
      border-radius: 7px;
      background: transparent;
      color: var(--text-primary, #dce5da);
      font-size: 13px;
      font-weight: 500;
      text-align: left;
      cursor: pointer;
      transition:
        background var(--transition-fast, 120ms ease),
        color var(--transition-fast, 120ms ease);
    }

    .context-menu-item:hover:not(.disabled),
    .context-menu-item:focus-visible:not(.disabled) {
      outline: none;
      background: rgba(255, 255, 255, 0.07);
      color: var(--text-primary, #f2f7ef);
    }

    .context-menu-item.disabled {
      opacity: 0.4;
      cursor: default;
    }

    .context-menu-item.danger {
      color: var(--error-color, #f87171);
    }

    .context-menu-item.danger:hover:not(.disabled),
    .context-menu-item.danger:focus-visible:not(.disabled) {
      background: rgba(239, 68, 68, 0.12);
      color: var(--error-color, #f87171);
    }

    .context-menu-icon {
      width: 16px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 16px;
      color: rgba(214, 221, 208, 0.78);
      font-size: 12px;
      line-height: 1;
    }

    .context-menu-label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .context-menu-divider {
      height: 1px;
      background: rgba(255, 255, 255, 0.09);
      margin: 5px 4px;
    }
  `],
})
export class ContextMenuComponent {
  private el = inject(ElementRef<HTMLElement>);

  protected menuItems = signal<ContextMenuItem[]>([]);
  private menuX = signal(0);
  private menuY = signal(0);
  protected menuVisible = signal(false);
  protected menuLeft = signal(0);
  protected menuTop = signal(0);
  @Output() closed = new EventEmitter<void>();

  @Input() set items(value: ContextMenuItem[] | null | undefined) {
    this.menuItems.set(value ?? []);
  }

  @Input() set x(value: number | string | null | undefined) {
    this.menuX.set(this.coerceNumber(value));
  }

  @Input() set y(value: number | string | null | undefined) {
    this.menuY.set(this.coerceNumber(value));
  }

  @Input() set visible(value: boolean | string | null | undefined) {
    this.menuVisible.set(value === true || value === '' || value === 'true');
  }

  constructor() {
    effect(() => {
      const visible = this.menuVisible();
      const x = this.menuX();
      const y = this.menuY();

      if (!visible) {
        return;
      }

      this.menuLeft.set(x);
      this.menuTop.set(y);
      this.scheduleReposition();
    });
  }

  onItemClick(item: ContextMenuItem): void {
    if (!item.disabled) {
      this.closed.emit();
      void item.action();
    }
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (this.menuVisible()) {
      const menuEl = this.el.nativeElement.querySelector('.context-menu');
      if (menuEl && !menuEl.contains(event.target as Node)) {
        this.closed.emit();
      }
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.menuVisible()) {
      this.closed.emit();
    }
  }

  @HostListener('window:resize')
  onWindowResize(): void {
    if (this.menuVisible()) {
      this.repositionMenu();
    }
  }

  private repositionMenu(): void {
    const menuEl = this.el.nativeElement.querySelector('.context-menu') as HTMLElement | null;
    if (!menuEl || !this.menuVisible()) {
      return;
    }

    const margin = 8;
    const rect = menuEl.getBoundingClientRect();
    const maxLeft = window.innerWidth - rect.width - margin;
    const maxTop = window.innerHeight - rect.height - margin;
    this.menuLeft.set(Math.max(margin, Math.min(this.menuX(), maxLeft)));
    this.menuTop.set(Math.max(margin, Math.min(this.menuY(), maxTop)));
  }

  private scheduleReposition(): void {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => this.repositionMenu());
      return;
    }

    window.setTimeout(() => this.repositionMenu(), 0);
  }

  private coerceNumber(value: number | string | null | undefined): number {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : 0;
  }
}

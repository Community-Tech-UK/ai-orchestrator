import {
  Component,
  ChangeDetectionStrategy,
  HostListener,
  DestroyRef,
  inject,
  computed,
  input,
  ViewChild,
  output,
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import {
  CdkConnectedOverlay,
  OverlayModule,
  type ConnectedPosition,
} from '@angular/cdk/overlay';

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
  imports: [OverlayModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-template
      cdkConnectedOverlay
      [cdkConnectedOverlayOpen]="menuVisible()"
      [cdkConnectedOverlayOrigin]="menuOrigin()"
      [cdkConnectedOverlayPositions]="overlayPositions"
      [cdkConnectedOverlayViewportMargin]="8"
      [cdkConnectedOverlayFlexibleDimensions]="false"
      [cdkConnectedOverlayPush]="true"
    >
      <div
        class="context-menu"
        role="menu"
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
    </ng-template>
  `,
  styles: [`
    :host {
      display: contents;
    }

    .context-menu {
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
  private document = inject(DOCUMENT);
  private destroyRef = inject(DestroyRef);
  @ViewChild(CdkConnectedOverlay, { static: true })
  private overlay?: CdkConnectedOverlay;

  readonly items = input<ContextMenuItem[] | null | undefined>();
  readonly x = input<number | string | null | undefined>();
  readonly y = input<number | string | null | undefined>();
  readonly visible = input<boolean | string | null | undefined>();
  protected readonly menuItems = computed(() => this.items() ?? []);
  private readonly menuX = computed(() => this.coerceNumber(this.x()));
  private readonly menuY = computed(() => this.coerceNumber(this.y()));
  protected readonly menuVisible = computed(() => {
    const value = this.visible();
    return value === true || value === '' || value === 'true';
  });
  protected menuOrigin = computed(() => ({
    x: this.menuX(),
    y: this.menuY(),
  }));
  protected readonly overlayPositions: ConnectedPosition[] = [
    {
      originX: 'start',
      originY: 'top',
      overlayX: 'start',
      overlayY: 'top',
    },
  ];
  readonly closed = output<void>();

  constructor() {
    this.document.addEventListener('pointerdown', this.onDocumentPointerDown, true);
    this.destroyRef.onDestroy(() => {
      this.document.removeEventListener('pointerdown', this.onDocumentPointerDown, true);
    });
  }

  onItemClick(item: ContextMenuItem): void {
    if (!item.disabled) {
      this.closed.emit();
      void item.action();
    }
  }

  private readonly onDocumentPointerDown = (event: PointerEvent): void => {
    if (this.menuVisible()) {
      const overlayElement = this.overlay?.overlayRef.overlayElement;
      if (overlayElement && !overlayElement.contains(event.target as Node)) {
        this.closed.emit();
      }
    }
  };

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.menuVisible()) {
      this.closed.emit();
    }
  }

  private coerceNumber(value: number | string | null | undefined): number {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : 0;
  }
}

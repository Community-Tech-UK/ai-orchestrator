/**
 * UX1 — one tooltip directive for the whole app, on the CDK Overlay.
 *
 * Before this there was no tooltip primitive at all: ~300 native `title=`
 * attributes doing the job badly. Native titles cannot be styled, appear after
 * an unconfigurable ~1s delay, never appear on keyboard focus, and are
 * inconsistently announced by screen readers.
 *
 * The timing and suppression RULES live in `tooltip-policy.ts` so they can be
 * unit-tested without a DOM; this directive is the adapter that applies them.
 *
 * Deliberate behaviours, each of which is a bug somewhere else if omitted:
 *
 * - **Keyboard focus opens; a click that focuses does not.** Otherwise every
 *   button press leaves a tooltip covering the thing you just pressed.
 * - **`aria-describedby` merges and restores.** A trigger that already had a
 *   description keeps it after the tooltip closes.
 * - **Escape closes**, because a tooltip that traps the eye during keyboard
 *   navigation is worse than none.
 * - **Suppressed while `aria-expanded="true"`.** The menu the trigger just
 *   opened says more than the tooltip would, and stacking them is a mess.
 * - **One overlay per trigger, disposed on destroy**, and the CDK's own
 *   app-root overlay container — not a container per icon.
 */

import {
  Directive,
  ElementRef,
  inject,
  input,
  type OnDestroy,
  Renderer2,
  TemplateRef,
  ViewContainerRef,
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import {
  Overlay,
  OverlayPositionBuilder,
  type ConnectedPosition,
  type OverlayRef,
} from '@angular/cdk/overlay';
import { ComponentPortal, TemplatePortal } from '@angular/cdk/portal';
import { AioTooltipPanelComponent } from './aio-tooltip-panel.component';
import {
  openDelayFor,
  POST_CLICK_BLOCK_MS,
  shouldOpenOnFocus,
  shouldSuppressTooltip,
  SKIP_WINDOW_MS,
  TOUCH_DELAY_MS,
  TOUCH_VISIBLE_MS,
  mergeDescribedBy,
  unmergeDescribedBy,
  type TooltipVariant,
} from './tooltip-policy';

/**
 * Shared across every instance: once one tooltip has shown, the next opens
 * without re-paying the delay. This is what makes an icon rail feel like one
 * control rather than a dozen independent ones (hermes' skip-delay).
 */
let lastTooltipClosedAt = 0;

const POSITIONS: Readonly<Record<'above' | 'below' | 'before' | 'after', ConnectedPosition[]>> = {
  above: [
    { originX: 'center', originY: 'top', overlayX: 'center', overlayY: 'bottom', offsetY: -8 },
    { originX: 'center', originY: 'bottom', overlayX: 'center', overlayY: 'top', offsetY: 8 },
  ],
  below: [
    { originX: 'center', originY: 'bottom', overlayX: 'center', overlayY: 'top', offsetY: 8 },
    { originX: 'center', originY: 'top', overlayX: 'center', overlayY: 'bottom', offsetY: -8 },
  ],
  before: [
    { originX: 'start', originY: 'center', overlayX: 'end', overlayY: 'center', offsetX: -8 },
    { originX: 'end', originY: 'center', overlayX: 'start', overlayY: 'center', offsetX: 8 },
  ],
  after: [
    { originX: 'end', originY: 'center', overlayX: 'start', overlayY: 'center', offsetX: 8 },
    { originX: 'start', originY: 'center', overlayX: 'end', overlayY: 'center', offsetX: -8 },
  ],
};

let tooltipIdCounter = 0;

/** Every live directive, so nested hosts can resolve to the innermost one. */
const liveTooltips = new Set<AioTooltipDirective>();

@Directive({
  selector: '[appTooltip], [appTooltipTpl]',
  standalone: true,
  host: {
    '(mouseenter)': 'onPointerEnter()',
    '(mouseleave)': 'onPointerLeave($event)',
    '(focus)': 'onFocus()',
    '(blur)': 'hide()',
    '(click)': 'onClick()',
    '(keydown.escape)': 'hide()',
    '(touchstart)': 'onTouchStart()',
    '(touchend)': 'onTouchEnd()',
    '(touchcancel)': 'onTouchEnd()',
  },
})
export class AioTooltipDirective implements OnDestroy {
  /** Tooltip text. Falsy disables the tooltip entirely. */
  readonly appTooltip = input<string | null | undefined>(null);
  /** Rich alternative to {@link appTooltip} for multi-line content. */
  readonly appTooltipTpl = input<TemplateRef<unknown> | null>(null);
  /** Timing profile. See `TooltipVariant`. */
  readonly appTooltipVariant = input<TooltipVariant>('default');
  readonly appTooltipPosition = input<'above' | 'below' | 'before' | 'after'>('above');
  readonly appTooltipDisabled = input(false);
  /**
   * The trigger's visible label, when it has one. Used to suppress a tooltip
   * that would merely repeat text the user can already read.
   */
  readonly appTooltipLabel = input<string | null>(null);

  private readonly overlay = inject(Overlay);
  private readonly positionBuilder = inject(OverlayPositionBuilder);
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly viewContainer = inject(ViewContainerRef);
  private readonly renderer = inject(Renderer2);
  private readonly document = inject(DOCUMENT);

  private overlayRef: OverlayRef | null = null;
  private openTimer: ReturnType<typeof setTimeout> | null = null;
  private touchHideTimer: ReturnType<typeof setTimeout> | null = null;
  private clickedAt = 0;
  private previousDescribedBy: string | null = null;
  private readonly tooltipId = `aio-tooltip-${++tooltipIdCounter}`;

  constructor() {
    liveTooltips.add(this);
    // Teardown is `ngOnDestroy` only. Registering a DestroyRef callback as well
    // ran `dispose()` twice on every destroy (Angular's onDestroy hooks and its
    // cleanup pass are separate) — harmless because dispose is idempotent, but
    // doubled on a directive attached to nearly every control in the app.
  }

  ngOnDestroy(): void {
    this.dispose();
  }

  protected onPointerEnter(): void {
    const skipActive = Date.now() - lastTooltipClosedAt < SKIP_WINDOW_MS;
    this.scheduleShow(openDelayFor(this.appTooltipVariant(), skipActive));
  }

  /**
   * `mouseenter` does not re-fire on an ancestor the pointer never left, so
   * once an inner host has taken the tooltip, closing it would leave NOTHING
   * shown while the pointer still sits over an outer host that has its own
   * copy. Native `title` never behaved that way — the browser re-resolves to
   * whatever element is under the pointer — so hand the tooltip back explicitly
   * to the innermost ancestor the pointer moved into.
   */
  protected onPointerLeave(event: MouseEvent): void {
    this.hide();
    const movedTo = event.relatedTarget as Node | null;
    if (!movedTo) return;
    let innermost: AioTooltipDirective | null = null;
    for (const other of liveTooltips) {
      if (other === this) continue;
      if (!other.host.nativeElement.contains(movedTo)) continue;
      if (!innermost || innermost.host.nativeElement.contains(other.host.nativeElement)) {
        innermost = other;
      }
    }
    innermost?.onPointerEnter();
  }

  protected onFocus(): void {
    // Keyboard focus only — a click that incidentally focuses must not leave a
    // tooltip sitting over the control the user just pressed.
    if (!shouldOpenOnFocus(this.host.nativeElement)) return;
    this.scheduleShow(0);
  }

  protected onClick(): void {
    this.clickedAt = Date.now();
    this.hide();
  }

  protected onTouchStart(): void {
    this.scheduleShow(TOUCH_DELAY_MS, () => {
      this.clearTimer('touchHideTimer');
      this.touchHideTimer = setTimeout(() => this.hide(), TOUCH_VISIBLE_MS);
    });
  }

  protected onTouchEnd(): void {
    // Let an already-visible touch tooltip finish its visible window; only
    // cancel one that has not opened yet.
    if (!this.overlayRef?.hasAttached()) this.hide();
  }

  /** Visible for tests and for imperative callers (e.g. a status dot on click). */
  show(): void {
    if (this.isSuppressed()) return;
    if (this.overlayRef?.hasAttached()) return;
    if (this.hasNestedTooltipPending()) return;
    this.hideAncestorTooltips();

    const overlayRef = this.ensureOverlay();
    const template = this.appTooltipTpl();
    if (template) {
      overlayRef.attach(new TemplatePortal(template, this.viewContainer));
    } else {
      const portal = new ComponentPortal(AioTooltipPanelComponent, this.viewContainer);
      const ref = overlayRef.attach(portal);
      ref.setInput('text', this.appTooltip() ?? '');
      ref.setInput('tooltipId', this.tooltipId);
    }
    this.applyDescribedBy();
  }

  hide(): void {
    this.clearTimer('openTimer');
    this.clearTimer('touchHideTimer');
    if (!this.overlayRef?.hasAttached()) return;
    this.overlayRef.detach();
    this.restoreDescribedBy();
    lastTooltipClosedAt = Date.now();
  }

  private scheduleShow(delayMs: number, onShown?: () => void): void {
    if (this.isSuppressed()) return;
    this.clearTimer('openTimer');
    if (delayMs <= 0) {
      this.show();
      onShown?.();
      return;
    }
    this.openTimer = setTimeout(() => {
      this.show();
      onShown?.();
    }, delayMs);
  }

  /** Open or waiting to open. */
  private isPending(): boolean {
    return this.openTimer !== null || !!this.overlayRef?.hasAttached();
  }

  /**
   * `mouseenter` fires on an element AND on each of its ancestors when the
   * pointer lands inside it, so nested hosts would each open their own overlay
   * and show two popups at once over the same few pixels. Native `title` never
   * did this — the browser resolves one — so the migration to a JS directive is
   * what introduced the hazard. Innermost wins: it is the more specific label.
   */
  private hasNestedTooltipPending(): boolean {
    const el = this.host.nativeElement;
    for (const other of liveTooltips) {
      if (other === this) continue;
      if (other.isPending() && el.contains(other.host.nativeElement)) return true;
    }
    return false;
  }

  private hideAncestorTooltips(): void {
    const el = this.host.nativeElement;
    for (const other of liveTooltips) {
      if (other === this) continue;
      if (other.host.nativeElement.contains(el)) other.hide();
    }
  }

  private isSuppressed(): boolean {
    return shouldSuppressTooltip({
      text: this.appTooltipTpl() ? 'template' : this.appTooltip(),
      visibleLabel: this.appTooltipLabel() ?? this.host.nativeElement.textContent,
      truncated: this.isTruncated(),
      expanded: this.host.nativeElement.getAttribute('aria-expanded') === 'true',
      disabled: this.appTooltipDisabled(),
      recentlyClicked: Date.now() - this.clickedAt < POST_CLICK_BLOCK_MS,
    });
  }

  private isTruncated(): boolean {
    const el = this.host.nativeElement;
    return el.scrollWidth > el.clientWidth + 1;
  }

  private ensureOverlay(): OverlayRef {
    if (this.overlayRef) return this.overlayRef;
    this.overlayRef = this.overlay.create({
      positionStrategy: this.positionBuilder
        .flexibleConnectedTo(this.host)
        .withPositions(POSITIONS[this.appTooltipPosition()])
        .withPush(true),
      scrollStrategy: this.overlay.scrollStrategies.close(),
      // A tooltip must never take the pointer: hovering it would keep it open
      // over the control it describes.
      hasBackdrop: false,
      panelClass: 'aio-tooltip-panel',
      disposeOnNavigation: true,
    });
    return this.overlayRef;
  }

  /**
   * Point the trigger at the tooltip for assistive technology, preserving any
   * description it already had.
   */
  private applyDescribedBy(): void {
    const el = this.host.nativeElement;
    this.previousDescribedBy = el.getAttribute('aria-describedby');
    this.renderer.setAttribute(el, 'aria-describedby', mergeDescribedBy(this.previousDescribedBy, this.tooltipId));
  }

  private restoreDescribedBy(): void {
    const el = this.host.nativeElement;
    const remaining = unmergeDescribedBy(el.getAttribute('aria-describedby'), this.tooltipId);
    if (remaining === null) this.renderer.removeAttribute(el, 'aria-describedby');
    else this.renderer.setAttribute(el, 'aria-describedby', remaining);
    this.previousDescribedBy = null;
  }

  private clearTimer(which: 'openTimer' | 'touchHideTimer'): void {
    const timer = this[which];
    if (timer) {
      clearTimeout(timer);
      this[which] = null;
    }
  }

  private dispose(): void {
    liveTooltips.delete(this);
    this.clearTimer('openTimer');
    this.clearTimer('touchHideTimer');
    this.overlayRef?.dispose();
    this.overlayRef = null;
    // The host may already be detached; guard so teardown never throws.
    if (this.document.contains(this.host.nativeElement)) this.restoreDescribedBy();
  }
}

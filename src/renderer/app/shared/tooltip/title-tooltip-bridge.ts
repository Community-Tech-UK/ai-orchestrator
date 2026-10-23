import { DOCUMENT } from '@angular/common';
import { ComponentRef, inject, Injectable, Injector, OnDestroy } from '@angular/core';
import { Overlay, OverlayPositionBuilder, OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { AioTooltipPanelComponent } from './aio-tooltip-panel.component';
import { createTooltipOverlay } from './tooltip-overlay';
import { visibleTextOf } from './tooltip-visible-text';
import { getLastTooltipClosedAt, markTooltipClosed, registerBridgeHider, tooltipHostElements } from './tooltip-registry';
import { mergeDescribedBy, openDelayFor, POST_CLICK_BLOCK_MS, shouldDescribeHost, shouldOpenOnFocus, shouldSuppressTooltip, SKIP_WINDOW_MS, unmergeDescribedBy } from './tooltip-policy';

interface TitleSlot {
  el: HTMLElement;
  text: string;
  blanked: boolean;
  borrowedName: string | null;
  observer: MutationObserver | null;
}
interface Source { el: HTMLElement; directive: boolean; }
let nextTooltipId = 0;

/** Temporary adapter for native-title debt, preserving every bound sentence. */
@Injectable({ providedIn: 'root' })
export class TitleTooltipBridge implements OnDestroy {
  private readonly document = inject(DOCUMENT);
  private readonly overlay = inject(Overlay);
  private readonly positions = inject(OverlayPositionBuilder);
  private readonly injector = inject(Injector);
  private slot: TitleSlot | null = null;
  private anchor: HTMLElement | null = null;
  private directiveOwns = false;
  private focusInside = false;
  private clickedAt = 0;
  private clickedEl: EventTarget | null = null;
  private dismissed = false;
  private overlayRef: OverlayRef | null = null;
  private panel: ComponentRef<AioTooltipPanelComponent> | null = null;
  private openTimer: ReturnType<typeof setTimeout> | null = null;
  private described = false;
  private readonly tooltipId = `aio-title-tooltip-${++nextTooltipId}`;
  private unregisterHider: (() => void) | null = null;
  private started = false;
  private readonly listener = (event: Event): void => this.handle(event);
  private readonly globalExit = (): void => this.release();

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const type of ['pointerover', 'pointerout', 'pointerdown', 'focusin', 'focusout', 'keydown', 'scroll']) {
      this.document.addEventListener(type, this.listener, { capture: true, passive: true });
    }
    this.document.addEventListener('visibilitychange', this.globalExit);
    this.document.defaultView?.addEventListener('blur', this.globalExit);
    this.document.defaultView?.addEventListener('pagehide', this.globalExit);
    this.unregisterHider = registerBridgeHider(() => this.hide());
  }

  stop(): void {
    this.release();
    for (const type of ['pointerover', 'pointerout', 'pointerdown', 'focusin', 'focusout', 'keydown', 'scroll']) {
      this.document.removeEventListener(type, this.listener, true);
    }
    this.document.removeEventListener('visibilitychange', this.globalExit);
    this.document.defaultView?.removeEventListener('blur', this.globalExit);
    this.document.defaultView?.removeEventListener('pagehide', this.globalExit);
    this.unregisterHider?.(); this.unregisterHider = null;
    this.started = false;
  }
  ngOnDestroy(): void { this.stop(); }

  private handle(event: Event): void {
    if (this.anchor && !this.document.contains(this.anchor)) this.release();
    if (event instanceof PointerEvent && event.pointerType === 'touch') return;
    switch (event.type) {
      case 'pointerover': this.enter(event.target, false); break;
      case 'focusin': this.enter(event.target, true); break;
      case 'pointerout': {
        if (!this.anchor || !this.containsTarget(this.anchor, event.target)) break;
        const related = (event as PointerEvent).relatedTarget;
        if (this.containsTarget(this.anchor, related)) break;
        // A real pointer exit ends this visit's dismissal; moving between children never does.
        this.dismissed = false;
        // Focus may still own the same hint, but native inheritance must be restored on pointer exit.
        if (this.focusInside && !this.directiveOwns) { this.restoreSlotTitle(); this.observeTitle(); }
        else this.release();
        break;
      }
      case 'focusout':
        if (this.anchor && this.containsTarget(this.anchor, event.target)) this.release();
        break;
      case 'pointerdown': this.clickedEl = event.target; this.clickedAt = Date.now(); this.dismiss(); break;
      case 'keydown': if ((event as KeyboardEvent).key === 'Escape') this.dismiss(); break;
      case 'scroll':
        if (this.anchor && (event.target === this.document || this.containsTarget(event.target, this.anchor))) this.dismiss();
        break;
    }
  }

  private containsTarget(container: EventTarget | null, target: EventTarget | null): boolean {
    return container instanceof Node && target instanceof Node && container.contains(target);
  }

  private sourceFrom(target: EventTarget | null): Source | null {
    if (!(target instanceof Element)) return null;
    if (target.closest('[data-title-tooltip="off"]')) return null;
    for (let el: Element | null = target; el; el = el.parentElement) {
      // SVG icons can target events, but only HTML ancestors own bridged titles.
      if (!(el instanceof HTMLElement)) continue;
      // An excluded target is a boundary, not permission to upgrade an ancestor.
      if (el.tagName.includes('-') || /^(IFRAME|FRAME|EMBED|OBJECT|BODY|HTML)$/.test(el.tagName)) return null;
      if (tooltipHostElements.has(el)) return { el, directive: true };
      if (el === this.slot?.el || el.hasAttribute('title')) return { el, directive: false };
    }
    return null;
  }

  private enter(target: EventTarget | null, keyboard: boolean): void {
    const source = this.sourceFrom(target);
    if (!source) { this.release(); return; }
    if (keyboard && !shouldOpenOnFocus(source.el)) return;
    if (this.anchor !== source.el || this.directiveOwns !== source.directive) {
      this.release(); this.anchor = source.el; this.directiveOwns = source.directive;
      const titled = source.directive ? this.titledAncestor(source.el) : source.el;
      if (titled) {
        this.slot = { el: titled, text: titled.getAttribute('title') ?? '', blanked: false, borrowedName: null, observer: null };
        this.observeTitle();
      }
    }
    if (keyboard) this.focusInside = true;
    else this.blankTitle();
    if (source.directive || !this.slot) return;
    this.schedule(keyboard ? 0 : openDelayFor(this.variant(), Date.now() - getLastTooltipClosedAt() < SKIP_WINDOW_MS));
  }

  private titledAncestor(host: HTMLElement): HTMLElement | null {
    for (let el = host.parentElement; el; el = el.parentElement) {
      if (el.tagName.includes('-') || /^(BODY|HTML)$/.test(el.tagName)) return null;
      if (el.hasAttribute('title')) return el;
    }
    return null;
  }

  private blankTitle(): void {
    const slot = this.slot;
    if (!slot || slot.blanked || !slot.text) return;
    slot.blanked = true;
    slot.el.setAttribute('title', ''); slot.observer?.takeRecords();
    if (!slot.el.hasAttribute('aria-label') && !slot.el.hasAttribute('aria-labelledby') && !visibleTextOf(slot.el)) {
      slot.el.setAttribute('aria-label', slot.text); slot.borrowedName = slot.text;
    }
  }

  private observeTitle(): void {
    const slot = this.slot;
    if (!slot || slot.observer) return;
    slot.observer = new MutationObserver(() => this.synchronizeTitle(true));
    slot.observer.observe(slot.el, { attributes: true, attributeFilter: ['title'] });
  }

  private synchronizeTitle(reblank: boolean): void {
    const slot = this.slot;
    if (!slot) return;
    const title = slot.el.getAttribute('title');
    if (!title) {
      slot.text = title ?? ''; slot.blanked = false;
      this.release(); return;
    }
    const oldName = slot.borrowedName;
    slot.text = title;
    if (oldName !== null && slot.el.getAttribute('aria-label') === oldName) {
      slot.el.setAttribute('aria-label', title); slot.borrowedName = title;
    }
    if (reblank && slot.blanked) { slot.el.setAttribute('title', ''); slot.observer?.takeRecords(); }
    if (this.panel) {
      if (this.suppressed()) this.hide();
      else { this.panel.setInput('text', title); this.panel.changeDetectorRef.detectChanges(); this.restoreDescription(); this.applyDescription(); }
    }
  }

  private variant(): 'default' | 'overflow' {
    return this.truncated() || !this.anchor?.matches('button, input, select, textarea, a[href], [role="button"], [tabindex]') ? 'overflow' : 'default';
  }
  private truncated(): boolean { return !!this.anchor && this.anchor.scrollWidth > this.anchor.clientWidth + 1; }
  private clickedHere(): boolean {
    if (!this.clickedEl || Date.now() - this.clickedAt >= POST_CLICK_BLOCK_MS) return false;
    return this.containsTarget(this.anchor, this.clickedEl) || this.containsTarget(this.clickedEl, this.anchor);
  }
  private suppressed(): boolean {
    return !this.slot || !this.anchor || this.directiveOwns || shouldSuppressTooltip({
      text: this.slot.text, visibleLabel: visibleTextOf(this.anchor), truncated: this.truncated(),
      expanded: this.anchor.getAttribute('aria-expanded') === 'true', recentlyClicked: this.clickedHere(),
    });
  }
  private schedule(delay: number): void {
    // Rule 6: a dismissed visit is spent until the pointer really leaves the source.
    if (this.dismissed || this.suppressed()) { this.hide(); return; }
    this.clearTimer();
    if (this.panel) return;
    if (delay === 0) this.show();
    else this.openTimer = setTimeout(() => { this.openTimer = null; this.show(); }, delay);
  }
  private show(): void {
    if (this.dismissed || this.suppressed() || !this.anchor || !this.slot || !this.document.contains(this.anchor)) return;
    // CDK close reacts to unrelated cdkScrollable containers too. The capture listener
    // above closes only when the anchor actually moves, including unregistered scrollables.
    this.overlayRef = createTooltipOverlay(this.overlay, this.positions, this.anchor, 'above', 'manual');
    this.panel = this.overlayRef.attach(new ComponentPortal(AioTooltipPanelComponent, null, this.injector));
    this.panel.setInput('text', this.slot.text); this.panel.setInput('tooltipId', this.tooltipId);
    this.panel.setInput('format', /^(CODE|KBD|SAMP)$/.test(this.anchor.tagName) ? 'code' : 'text');
    this.panel.changeDetectorRef.detectChanges(); this.applyDescription();
  }
  private applyDescription(): void {
    if (!this.anchor || !shouldDescribeHost(this.slot?.text, this.anchor.getAttribute('aria-label'))) return;
    this.anchor.setAttribute('aria-describedby', mergeDescribedBy(this.anchor.getAttribute('aria-describedby'), this.tooltipId)); this.described = true;
  }
  private restoreDescription(): void {
    if (!this.described || !this.anchor) return;
    const remaining = unmergeDescribedBy(this.anchor.getAttribute('aria-describedby'), this.tooltipId);
    if (remaining === null) this.anchor.removeAttribute('aria-describedby'); else this.anchor.setAttribute('aria-describedby', remaining);
    this.described = false;
  }
  /** Rule 6: hide without restoring; nothing reopens this source until its actual exit. */
  private dismiss(): void { this.dismissed = true; this.hide(); }
  private hide(): void {
    this.clearTimer(); this.restoreDescription();
    if (this.panel) markTooltipClosed();
    this.panel = null; this.overlayRef?.dispose(); this.overlayRef = null;
  }
  private clearTimer(): void { if (this.openTimer !== null) clearTimeout(this.openTimer); this.openTimer = null; }
  private restoreSlotTitle(): void {
    const slot = this.slot;
    if (!slot) return;
    // Flush external bindings even if stop/exit happens before MutationObserver's microtask.
    if (slot.observer?.takeRecords().length) this.synchronizeTitle(false);
    if (slot !== this.slot) return;
    slot.observer?.disconnect(); slot.observer = null;
    if (slot.blanked && slot.el.getAttribute('title') === '') slot.el.setAttribute('title', slot.text);
    slot.blanked = false;
    if (slot.borrowedName !== null && slot.el.getAttribute('aria-label') === slot.borrowedName) slot.el.removeAttribute('aria-label');
    slot.borrowedName = null;
  }
  private release(): void {
    this.restoreSlotTitle(); this.hide(); this.slot = null; this.anchor = null;
    this.directiveOwns = false; this.focusInside = false; this.dismissed = false;
  }
}

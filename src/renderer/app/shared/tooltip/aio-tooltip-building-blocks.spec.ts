import { Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeybindingService } from '../../core/services/keybinding.service';
import { AioTooltipDirective } from './aio-tooltip.directive';

@Component({ standalone: true, imports: [AioTooltipDirective], template: `
  <form (submit)="submits = submits + 1; $event.preventDefault()">
    <button [appTooltip]="tip()" [attr.aria-label]="label()" aria-describedby="hint"
      [appTooltipDisabledReason]="reason()" [appTooltipShortcut]="shortcut()"
      [appTooltipShowWhenExpanded]="showExpanded()" [attr.aria-expanded]="expanded()" (click)="clicks = clicks + 1">×</button>
  </form>` })
class Host {
  tip = signal<string | null>('Close'); label = signal('Close'); reason = signal<string | null>(null);
  shortcut = signal<string | null>(null); expanded = signal<string | null>(null); showExpanded = signal(false);
  clicks = 0; submits = 0;
}
@Component({ standalone: true, imports: [AioTooltipDirective], template: `
  <button appTooltipDisabledReason="Unavailable: pick a working folder first.">Send</button>
  <button id="rich" [appTooltipTpl]="rich" aria-label="Rich"><span style="display:none">template</span></button>
  <ng-template #rich><b>Rich body</b></ng-template>` })
class ReasonAndTemplate {}

function tooltip(): HTMLElement | null { return document.querySelector('[role="tooltip"]'); }
function focus(el: HTMLElement): void {
  const matches = el.matches.bind(el); vi.spyOn(el, 'matches').mockImplementation(s => s === ':focus-visible' || matches(s));
  el.dispatchEvent(new FocusEvent('focus'));
}
describe('tooltip building blocks', () => {
  let fixture: ComponentFixture<Host>; let button: HTMLElement;
  beforeEach(async () => {
    vi.useFakeTimers(); await TestBed.configureTestingModule({ imports: [Host, ReasonAndTemplate] }).compileComponents();
    fixture = TestBed.createComponent(Host); fixture.detectChanges(); button = fixture.nativeElement.querySelector('button');
  });
  afterEach(() => { fixture.destroy(); TestBed.resetTestingModule(); vi.useRealTimers(); expect(tooltip()).toBeNull(); });
  it('leaves unrelated descriptions untouched when the tooltip repeats the name', () => {
    focus(button); fixture.detectChanges(); expect(tooltip()).not.toBeNull(); expect(button.getAttribute('aria-describedby')).toBe('hint');
    fixture.componentInstance.tip.set(' close  '); fixture.detectChanges(); button.dispatchEvent(new FocusEvent('blur'));
    focus(button); fixture.detectChanges(); expect(button.getAttribute('aria-describedby')).toBe('hint');
  });
  it('describes extra information and removes only its own id', () => {
    fixture.componentInstance.tip.set('Close this panel'); fixture.detectChanges(); focus(button); fixture.detectChanges();
    expect(button.getAttribute('aria-describedby')).toMatch(/^hint aio-tooltip-/);
    button.dispatchEvent(new FocusEvent('blur')); expect(button.getAttribute('aria-describedby')).toBe('hint');
  });
  it('shows a live shortcut chip and reacts to rebinding', () => {
    fixture.componentInstance.shortcut.set('toggle-history'); fixture.detectChanges();
    const service = TestBed.inject(KeybindingService); service.customizeBinding('toggle-history', { key: 'j', modifiers: ['meta', 'shift'] });
    fixture.detectChanges(); focus(button); fixture.detectChanges();
    expect(tooltip()?.querySelector('kbd')?.textContent).toBe('Ctrl+Shift+J');
    expect(button.getAttribute('aria-keyshortcuts')).toBe('Control+Shift+J');
    service.customizeBinding('toggle-history', { key: 'h', modifiers: ['alt'] }); fixture.detectChanges();
    expect(button.getAttribute('aria-keyshortcuts')).toBe('Alt+H');
  });
  it('updates the visible reason and shortcut while the tooltip is already open', () => {
    focus(button); fixture.detectChanges();
    fixture.componentInstance.reason.set('Unavailable: choose a folder first.'); fixture.detectChanges();
    expect(tooltip()?.textContent).toContain('Unavailable: choose a folder first.');
    fixture.componentInstance.shortcut.set('toggle-history'); fixture.detectChanges();
    const service = TestBed.inject(KeybindingService); service.customizeBinding('toggle-history', { key: 'j', modifiers: ['alt'] }); fixture.detectChanges();
    expect(tooltip()?.querySelector('kbd')?.textContent).toBe('Alt+J');
    fixture.componentInstance.reason.set(null); fixture.detectChanges(); expect(tooltip()?.textContent).toContain('Close');
  });
  it('shows no shortcut for unknown or absent action ids', () => {
    fixture.componentInstance.shortcut.set('missing'); fixture.detectChanges(); focus(button); fixture.detectChanges();
    expect(tooltip()?.querySelector('kbd')).toBeNull(); expect(button.hasAttribute('aria-keyshortcuts')).toBe(false);
  });
  it('keeps lasting disabled reasons focusable and blocks clicks and submission until cleared', () => {
    fixture.componentInstance.reason.set('Unavailable: pick a working folder first.'); fixture.detectChanges();
    expect(button.getAttribute('aria-disabled')).toBe('true'); expect(button.classList.contains('aio-reason-disabled')).toBe(true);
    expect(button.hasAttribute('disabled')).toBe(false); focus(button); fixture.detectChanges();
    expect(tooltip()?.textContent).toContain('Unavailable: pick a working folder first.');
    button.click(); fixture.detectChanges(); expect(fixture.componentInstance.clicks).toBe(0); expect(fixture.componentInstance.submits).toBe(0);
    expect(tooltip()).not.toBeNull(); fixture.componentInstance.reason.set(null); fixture.detectChanges();
    expect(button.hasAttribute('aria-disabled')).toBe(false); button.click(); expect(fixture.componentInstance.clicks).toBe(1);
    expect(fixture.componentInstance.submits).toBe(1);
  });
  it('opens a reason on hover', () => {
    fixture.componentInstance.reason.set('Unavailable: select an item first.'); fixture.detectChanges();
    button.dispatchEvent(new MouseEvent('mouseenter')); vi.advanceTimersByTime(200); fixture.detectChanges();
    expect(tooltip()?.textContent).toContain('Unavailable: select an item first.');
  });
  it('can retain hints on expanded panel toggles', () => {
    fixture.componentInstance.expanded.set('true'); fixture.detectChanges(); focus(button); fixture.detectChanges(); expect(tooltip()).toBeNull();
    fixture.componentInstance.showExpanded.set(true); fixture.detectChanges(); focus(button); fixture.detectChanges(); expect(tooltip()).not.toBeNull();
  });
  it('attaches with only a reason and renders rich templates inside the semantic panel', () => {
    fixture.destroy(); const rich = TestBed.createComponent(ReasonAndTemplate); rich.detectChanges();
    const reason: HTMLElement = rich.nativeElement.querySelector('button'); focus(reason); rich.detectChanges();
    expect(tooltip()?.textContent).toContain('Unavailable: pick a working folder first.'); reason.dispatchEvent(new FocusEvent('blur'));
    const richButton: HTMLElement = rich.nativeElement.querySelector('#rich'); focus(richButton); rich.detectChanges();
    expect(tooltip()?.querySelector('b')?.textContent).toBe('Rich body'); expect(richButton.getAttribute('aria-describedby')).toMatch(/aio-tooltip-/);
    rich.destroy();
  });
});

import { Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppIconButtonDirective } from './icon-button.directive';
@Component({ standalone: true, imports: [AppIconButtonDirective], template: `
  <button [appIconButton]="name()" appTooltipShortcut="toggle-history" [appIconButtonDisabledReason]="reason()" (click)="clicks = clicks + 1">×</button>` })
class Host { name = signal('Close panel'); reason = signal<string | null>(null); clicks = 0; }
@Component({ standalone: true, imports: [AppIconButtonDirective], template: `
  <span id="outer" appIconButton="Outer"><span id="inner" appIconButton="Inner"></span></span>` })
class Nested {}
describe('icon button host-directive spike', () => {
  let fixture: ComponentFixture<Host>;
  beforeEach(async () => { vi.useFakeTimers(); await TestBed.configureTestingModule({ imports: [Host, Nested] }).compileComponents(); fixture = TestBed.createComponent(Host); fixture.detectChanges(); });
  afterEach(() => { fixture.destroy(); TestBed.resetTestingModule(); vi.useRealTimers(); });
  it('maps the label, tooltip and shortcut without matching a second directive', () => {
    const button: HTMLElement = fixture.nativeElement.querySelector('button'); expect(button.getAttribute('aria-label')).toBe('Close panel');
    button.dispatchEvent(new MouseEvent('mouseenter')); vi.advanceTimersByTime(200); fixture.detectChanges();
    const panel = document.querySelector('[role="tooltip"]'); expect(panel?.textContent).toContain('Close panel');
    expect(panel?.querySelector('kbd')?.textContent).toBe('Ctrl+H'); expect(button.hasAttribute('aria-describedby')).toBe(false);
    fixture.componentInstance.name.set('Hide panel'); fixture.detectChanges(); expect(button.getAttribute('aria-label')).toBe('Hide panel');
    expect(button.hasAttribute('aria-describedby')).toBe(false);
  });
  it('maps the reason alias and prevents the action', () => {
    fixture.componentInstance.reason.set('Unavailable: select an item first.'); fixture.detectChanges();
    const button: HTMLElement = fixture.nativeElement.querySelector('button'); expect(button.getAttribute('aria-disabled')).toBe('true');
    button.dispatchEvent(new MouseEvent('mouseenter')); vi.advanceTimersByTime(200); fixture.detectChanges();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Unavailable: select an item first.');
    button.click(); expect(fixture.componentInstance.clicks).toBe(0);
  });
  it('keeps only the inner icon tooltip', () => {
    fixture.destroy(); const nested = TestBed.createComponent(Nested); nested.detectChanges();
    for (const id of ['outer', 'inner']) nested.nativeElement.querySelector('#' + id).dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(200); nested.detectChanges();
    expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1); expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Inner'); nested.destroy();
  });
});

import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { copyFor } from '../../shared/tooltip/tooltip-copy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { SidebarHeaderComponent } from './sidebar-header.component';
import { KeybindingService } from '../../core/services/keybinding.service';
await resolveComponentResources((url) => Promise.resolve(url.endsWith('sidebar-header.component.scss') ? readFileSync('src/renderer/app/features/dashboard/sidebar-header.component.scss', 'utf8') : ''));
describe('Sidebar header', () => {
  afterEach(() => TestBed.resetTestingModule());
  it('toggles the menu with the complete pointer sequence and closes on outside input', () => {
    TestBed.configureTestingModule({ imports: [SidebarHeaderComponent], providers: [{ provide: KeybindingService, useValue: { formatBindingByAction: () => 'Ctrl+N', ariaShortcutsByAction: () => null } }] });
    const fixture = TestBed.createComponent(SidebarHeaderComponent);
    fixture.detectChanges();
    const caret = fixture.nativeElement.querySelector('[aria-haspopup="menu"]') as HTMLButtonElement;
    const click = (element: HTMLElement): void => {
      element.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      fixture.detectChanges();
      element.dispatchEvent(new Event('pointerup', { bubbles: true }));
      element.click();
      fixture.detectChanges();
    };
    click(caret);
    expect(caret.getAttribute('aria-expanded')).toBe('true');
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull();
    click(caret);
    expect(caret.getAttribute('aria-expanded')).toBe('false');
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    click(caret);
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    fixture.detectChanges();
    expect(caret.getAttribute('aria-expanded')).toBe('false');
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
  });


  it('has one primary session action and a Quick chat menu', () => {
    TestBed.configureTestingModule({ imports: [SidebarHeaderComponent], providers: [{ provide: KeybindingService, useValue: { formatBindingByAction: () => 'Ctrl+N', ariaShortcutsByAction: () => null } }] });
    const fixture = TestBed.createComponent(SidebarHeaderComponent);
    const quick = vi.fn(); fixture.componentInstance.newChatClicked.subscribe(quick);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.btn-header-icon--primary')).toHaveLength(1);
    const caret = fixture.nativeElement.querySelector('[aria-haspopup="menu"]') as HTMLButtonElement;
    expect(caret).not.toBeNull();
    caret.click(); fixture.detectChanges();
    const item = document.body.querySelector('.context-menu button') as HTMLButtonElement;
    expect(item.textContent).toContain('Quick chat (no folder)');
    expect(document.activeElement).toBe(item);
    const seen = vi.fn(); document.addEventListener('keydown', seen);
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    fixture.detectChanges();
    expect(seen).not.toHaveBeenCalled(); document.removeEventListener('keydown', seen);
    expect(document.activeElement).toBe(caret);
    caret.click(); fixture.detectChanges();
    const reopened = document.body.querySelector('.context-menu button') as HTMLButtonElement;
    reopened.click(); fixture.detectChanges();
    expect(quick).toHaveBeenCalledOnce();
    fixture.destroy();
  });
});


describe('Sidebar header hints', () => {
  afterEach(() => TestBed.resetTestingModule());
  it('names both controls with real tooltips and reads the new-session shortcut live', () => {
    TestBed.configureTestingModule({ imports: [SidebarHeaderComponent] });
    const fixture = TestBed.createComponent(SidebarHeaderComponent); fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('[title]')).toHaveLength(0);
    const controls = fixture.debugElement.queryAll(By.css('button'));
    expect(controls.map(control => control.nativeElement.getAttribute('aria-label'))).toEqual(['Create a new session', 'New session options']);
    expect(controls.map(control => control.injector.get(AioTooltipDirective).appTooltip())).toEqual([copyFor('newSession'), copyFor('newSessionOptions')]);
    const keybindings = TestBed.inject(KeybindingService);
    keybindings.customizeBinding('new-instance', { key: 'n', modifiers: ['alt'] }); fixture.detectChanges();
    const element = controls[0].nativeElement as HTMLElement;
    expect(element.getAttribute('aria-keyshortcuts')).toBe('Alt+N');
    const matches = element.matches.bind(element);
    vi.spyOn(element, 'matches').mockImplementation(selector => selector === ':focus-visible' || matches(selector));
    element.dispatchEvent(new FocusEvent('focus')); fixture.detectChanges();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(copyFor('newSession'));
    expect(document.querySelector('[role="tooltip"] kbd')?.textContent).toBe('Alt+N');
  });
});
